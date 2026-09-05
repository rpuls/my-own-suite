// Backup/restore engine, separated from the host so its guarantees are
// testable. Every side effect — Docker, tar, systemd, disk sizing, the Suite
// Manager store — goes through injected adapters; the engine owns the order of
// operations, the journal, the rescue copy, absence reconciliation, and the
// verification that gates success.
//
// Injected `system` adapter surface (real implementation in
// ./system-adapter.cjs, fakes in ./agent-core.test.cjs):
//   listVolumes() -> [{ labels, name }]
//   volumeMountpoint(name) -> path        createVolume(name, labels)
//   removeVolume(name)                    listAppContainers({ runningOnly })
//   stopContainer(name)  startContainer(name)  removeContainer(name)
//   stopService(name)  startService(name)  reloadCaddy()
//   archiveTree(sourceDir, archivePath)   extractArchive(archivePath, targetDir)
//   assertArchiveReadable(archivePath)
//   copyTree(source, target, { excludeNames })  removeTree(target)
//   availableBytes(dir) -> bytes|null     pathBytes(target) -> bytes|null
//   destinationMounted(dir) -> boolean (optional; true when dir is a live mountpoint)
//   snapshotSqlite(databasePath, targetPath)
//   restoreStateOwnership()               sourceInfo() -> { branch, commit, repoDir, version }
//
// `packages` = { inventory(), validatePayloads(stagedRoot, apps) }
// `apps`     = { installedInstances() -> [{ enabled, instanceId, packageId }], reconcile(log) }
// `jobs`     = { log(file, message), stage(file, name), update(file, mutator) }
// `engine`   = the backup storage engine (./engines/, fakes in the tests):
//   openOrCreateRepository({ repositoryPath }) -> repository
//   snapshotTree({ repository, sourceDir, tags }) -> { snapshotId, sourcePath }
//   restoreSnapshot({ repository, snapshotId, sourcePath, targetDir })
//   forgetSnapshots({ repository, snapshotIds })  maintainRepository({ repository })
//   verifySnapshots({ repository, snapshotIds })  repositoryStats({ repository })
//
// New backups are always written as restore points into that repository. The
// tar adapter methods remain for the three things that are still tar: restoring
// and validating v2/v3 bundles that existing installs already have, importing
// an uploaded one, and the pre-restore rescue copy, which targets the system
// disk and must work with no destination attached at all.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  appVolumeLabels,
  BACKUP_BETA_MAX_TOTAL_BYTES,
  BACKUP_SCHEMA_VERSION,
  classifyVolumes,
  managedStateTargets,
  RESTORE_COMPATIBLE_SCHEMA_VERSIONS,
} = require('../../infrastructure/persistent-state.cjs');
const { collectPackageFiles, verifySnapshotIdentity } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
const { openDestinationRepository, repositorySidecarPath, RESTORE_POINTS_DIRNAME, restorePointPath, restorePointsDir } = require('./engines/engine.cjs');

const COMPLETE_MARKER = 'COMPLETE';
const RESTORE_JOURNAL_FILENAME = 'restore-journal.json';
const RESTORE_PHASES = Object.freeze(['stopping-runtime', 'rescue', 'restoring-state', 'restoring-volumes', 'reconciling-apps', 'verifying']);

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
// The journal must never be half-written: it is what a later process reads to
// decide whether the machine sits mid-restore. Write-then-rename keeps every
// observable journal state either the previous record or the next one.
function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.next`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

// A restore point's manifest is its completion marker: it names the snapshots
// the repository holds for one backup, and nothing lists a restore point until
// it exists. So it is written whole or not at all — digest first, then an
// atomic rename of the manifest itself.
function writeRestorePoint(manifestPath, manifest) {
  ensureDir(path.dirname(manifestPath));
  const staged = `${manifestPath}.next`;
  fs.writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(`${manifestPath}.sha256`, `${sha256(staged)}  ${path.basename(manifestPath)}\n`, 'utf8');
  fs.renameSync(staged, manifestPath);
}

function readRestorePoint(manifestPath) {
  const digestFile = `${manifestPath}.sha256`;
  if (!fs.existsSync(digestFile)) throw new Error('This restore point is incomplete: the checksum recorded with it is missing.');
  if (sha256(manifestPath) !== fs.readFileSync(digestFile, 'utf8').trim().split(/\s+/u)[0]) throw new Error('Backup manifest checksum is invalid.');
  return readJson(manifestPath);
}

// Hash in fixed-size chunks: volume archives are multi-gigabyte, and reading
// one into a single Buffer exhausts RAM or trips ERR_FS_FILE_TOO_LARGE.
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length)) > 0) hash.update(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function validatePackagePayloads(root, packages) {
  for (const item of packages || []) {
    const packageDir = path.join(root, 'var-lib-mos', 'app-packages', item.instanceId, 'installed');
    readAppPackageManifest(packageDir);
    const manifest = verifySnapshotIdentity(packageDir, { errorMessage: `Backup package identity is invalid for ${item.packageId}.`, expectedDigest: item.packageDigest, packageId: item.packageId });
    if (manifest.version !== item.packageVersion) throw new Error(`Backup package identity is invalid for ${item.packageId}.`);
    const files = collectPackageFiles(packageDir, { manifest });
    if (files.length !== item.payload?.length) throw new Error(`Backup package payload is incomplete for ${item.packageId}.`);
    for (const file of files) {
      const expected = item.payload.find((entry) => entry.path === file.relativePath);
      if (!expected || expected.bytes !== file.size || expected.sha256 !== sha256(file.absolutePath)) throw new Error(`Backup package payload hash is invalid for ${item.packageId}/${file.relativePath}.`);
    }
  }
}

// The public address apps are rebuilt on during a restore. The restored Suite
// Manager database is the authority: a domain the owner applied after install
// exists nowhere else the restore can reach, while MOS_HOME_HOST and the
// bootstrap contract only describe the install-time address — on a USB install
// that is the LAN name, and rebuilding routes from it takes every app off its
// HTTPS address.
function restorePublicIdentity({ bootstrapContract = {}, environment = {}, httpsSettings = null } = {}) {
  if (httpsSettings?.tlsMode === 'cloudflare-dns01' && httpsSettings.baseDomain) {
    return { homeHost: `home.${httpsSettings.baseDomain}`, scheme: 'https' };
  }
  if (environment.MOS_HOME_HOST) return { homeHost: environment.MOS_HOME_HOST, scheme: 'http' };
  if (bootstrapContract.MOS_HOME_URL) {
    try {
      const parsed = new URL(bootstrapContract.MOS_HOME_URL);
      return { homeHost: parsed.hostname, scheme: parsed.protocol === 'https:' ? 'https' : 'http' };
    } catch {}
  }
  if (bootstrapContract.MOS_DOMAIN) return { homeHost: `home.${bootstrapContract.MOS_DOMAIN}`, scheme: 'http' };
  return { homeHost: 'home.mos.home', scheme: 'http' };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'an unknown amount';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// Ownership metadata for a restored volume. A v3 bundle records it directly;
// a v2 bundle only recorded names, so the identity is re-derived from the
// packages the same bundle proves it contained — never from a bare prefix.
function volumeIdentityFromManifest(volumeEntry, manifestApps) {
  if (volumeEntry.packageId) return { instanceId: volumeEntry.instanceId || null, packageId: volumeEntry.packageId };
  for (const app of manifestApps || []) {
    if (volumeEntry.name.startsWith(`mos-app-${app.packageId}-`)) return { instanceId: app.instanceId || null, packageId: app.packageId };
  }
  return { instanceId: null, packageId: null };
}

// A restore point is identified by its manifest file; a legacy bundle by its
// directory. Both arrive on the wire as one opaque locator, so the shape of
// what is on disk decides which storage the flow is talking to.
function isRestorePointPath(target) {
  return typeof target === 'string' && target.endsWith('.json') && path.basename(path.dirname(target)) === RESTORE_POINTS_DIRNAME;
}

function destinationOfRestorePoint(manifestPath) {
  return path.resolve(path.dirname(manifestPath), '..', '..');
}

function snapshotIdsOfRestorePoint(manifest) {
  return [manifest.contents?.stateSnapshot?.snapshotId, ...(manifest.contents?.volumes || []).map((volume) => volume.snapshotId)].filter(Boolean);
}

function existingRestorePoints(destinationId) {
  try {
    return fs.readdirSync(restorePointsDir(destinationId)).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// Room a backup has to see free before it starts. The first backup into a
// repository stores everything, so it needs everything. Later ones store only
// what changed, and demanding room for another full copy would refuse the
// ordinary case outright: a drive that legitimately holds one copy of the data
// can never fit a second, so every backup after the first would fail on a
// correctly sized drive. The destination-full drill showed both engines refuse
// cleanly and leave the repository usable when space does run out, so this
// check exists to catch the hopeless case rather than to guarantee the write.
function requiredFreeBytes(estimatedBytes, restorePointsPresent) {
  if (!restorePointsPresent) return estimatedBytes;
  return Math.max(1024 * 1024 * 1024, Math.round(estimatedBytes * 0.05));
}

class BackupAgentCore {
  constructor({ apps, engine, jobs, packages, paths, system }) {
    this.apps = apps;
    this.engine = engine;
    this.jobs = jobs;
    this.packages = packages;
    this.paths = paths;
    this.system = system;
    this.journalPath = path.join(paths.agentStateDir, RESTORE_JOURNAL_FILENAME);
    this.rescueRoot = path.join(paths.agentStateDir, 'pre-restore-rescue');
  }

  stateTargets() {
    return managedStateTargets(this.paths).filter((target) => target.backedUp && target.stagePath);
  }

  // The destination directory outlives its mount, so without this check a
  // detached drive turns backups into silent writes onto the system disk —
  // reported as success and invisible in the bundle list.
  async assertDestinationMounted(destinationId, message) {
    if (!this.system.destinationMounted) return;
    if (await this.system.destinationMounted(destinationId)) return;
    throw new Error(message);
  }

  // --- Restore journal -----------------------------------------------------
  // The journal exists from the moment the restore stops the runtime until
  // verification passes. Its presence is the durable statement "this machine
  // is between two states"; success is recorded by completing and removing
  // it, never inferred from a job file that a crash may have left behind.

  readJournal() {
    if (!fs.existsSync(this.journalPath)) return null;
    try {
      return readJson(this.journalPath);
    } catch {
      return { corrupt: true, phase: 'unknown' };
    }
  }

  writeJournal(journal) { writeJsonAtomic(this.journalPath, journal); }

  advanceJournal(phase, extra = {}) {
    const journal = { ...(this.readJournal() || {}), ...extra, phase, updatedAt: new Date().toISOString() };
    this.writeJournal(journal);
    return journal;
  }

  interruptedRestore() {
    const journal = this.readJournal();
    if (!journal || journal.completedAt) return null;
    return {
      backupPath: journal.backupPath || null,
      corrupt: journal.corrupt === true,
      jobId: journal.jobId || null,
      phase: journal.phase || 'unknown',
      rescuePath: journal.rescuePath || null,
      startedAt: journal.startedAt || null,
    };
  }

  // Explicit operator acknowledgment is the only exit from the interrupted
  // state: the journal is folded into the job record for the audit trail and
  // the machine stops refusing new backup/restore work. Nothing here repairs
  // state — the rescue copy stays on disk for manual recovery.
  acknowledgeInterruptedRestore({ confirmation }) {
    const interrupted = this.interruptedRestore();
    if (!interrupted) throw new Error('No interrupted restore is recorded.');
    if (confirmation !== 'ACKNOWLEDGE') throw new Error('Type ACKNOWLEDGE to dismiss the interrupted restore record.');
    const journal = this.readJournal();
    const record = { ...journal, acknowledgedAt: new Date().toISOString() };
    writeJson(path.join(this.paths.agentStateDir, 'acknowledged-restores', `${journal.jobId || 'unknown'}-${Date.now()}.json`), record);
    fs.rmSync(this.journalPath, { force: true });
    return interrupted;
  }

  // --- Backup --------------------------------------------------------------

  async backup(jobFile) {
    const { jobs, packages, system } = this;
    const started = jobs.update(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
    if (this.interruptedRestore()) throw new Error('A previous restore did not complete. Acknowledge it before starting new backup or restore work.');
    await this.assertDestinationMounted(started.destinationId, 'The backup destination is not mounted. Reconnect the drive, refresh drives, and try again.');
    // exFAT and NTFS destinations reject app-packages' setgid mode, so the
    // stage cannot live on the drive.
    const stateStage = path.join(this.paths.agentStateDir, `backup-stage-${started.id}`);

    jobs.stage(jobFile, 'Preparing backup');
    const packageInventory = packages.inventory();
    const knownPackageIds = [...new Set(packageInventory.map((item) => item.packageId))];
    const { ambiguous, owned } = classifyVolumes(await system.listVolumes(), knownPackageIds);
    for (const name of ambiguous) {
      jobs.log(jobFile, `Volume ${name} wears the MOS prefix but matches no installed package. It is reported here and left out rather than assumed to be MOS-owned.`);
    }

    jobs.stage(jobFile, 'Checking required space');
    const targets = this.stateTargets();
    let stateRawBytes = 0;
    for (const target of targets) stateRawBytes += (await system.pathBytes(target.path)) || 0;
    const ownedWithMounts = [];
    let volumeRawBytes = 0;
    for (const volume of owned) {
      const mountpoint = await system.volumeMountpoint(volume.name);
      const rawBytes = (await system.pathBytes(mountpoint)) || 0;
      volumeRawBytes += rawBytes;
      ownedWithMounts.push({ ...volume, mountpoint, rawBytes });
    }
    const estimatedBytes = stateRawBytes + volumeRawBytes;
    if (estimatedBytes > BACKUP_BETA_MAX_TOTAL_BYTES) {
      throw new Error(`This installation holds about ${formatBytes(estimatedBytes)} of persistent state, above the current backup limit of ${formatBytes(BACKUP_BETA_MAX_TOTAL_BYTES)}.`);
    }
    const restorePointsPresent = existingRestorePoints(started.destinationId) > 0;
    const freeBytes = await system.availableBytes(started.destinationId);
    const neededBytes = requiredFreeBytes(estimatedBytes, restorePointsPresent);
    if (freeBytes !== null && freeBytes < neededBytes) {
      throw new Error(restorePointsPresent
        ? `The destination has ${formatBytes(freeBytes)} free, too little to add to the backups already on it. Free space on the destination and try again.`
        : `The destination has ${formatBytes(freeBytes)} free but this backup needs up to ${formatBytes(estimatedBytes)}. Free space on the destination and try again.`);
    }
    ensureDir(this.paths.agentStateDir);
    const localFreeBytes = await system.availableBytes(this.paths.agentStateDir);
    if (localFreeBytes !== null && localFreeBytes < stateRawBytes) {
      throw new Error(`Staging the suite state needs ${formatBytes(stateRawBytes)} free on the system disk, but only ${formatBytes(localFreeBytes)} is available.`);
    }
    jobs.log(jobFile, `Backing up about ${formatBytes(estimatedBytes)} of persistent state (${owned.length} app volumes).`);

    jobs.stage(jobFile, 'Opening the backup repository on the destination');
    const repository = await openDestinationRepository(this.engine, started.destinationId);
    if (repository.created) jobs.log(jobFile, 'Created a new encrypted backup repository on this drive.');
    const manifestPath = restorePointPath(started.destinationId, started.id);
    ensureDir(restorePointsDir(started.destinationId));
    // The operator's note travels with the restore point from birth; it stays a
    // sidecar outside the checksummed manifest.
    if (started.note) fs.writeFileSync(`${manifestPath}.note.txt`, `${started.note}\n`, 'utf8');
    jobs.update(jobFile, (job) => { job.outputPath = manifestPath; });
    const storedSnapshotIds = [];
    let repositoryStoredBytes = null;
    const stoppedContainers = await system.listAppContainers({ runningOnly: true });
    try {
      jobs.stage(jobFile, 'Stopping app runtime for a consistent snapshot');
      for (const container of stoppedContainers) await system.stopContainer(container);
      await system.stopService('mos-homepage.service');

      jobs.stage(jobFile, 'Copying suite state');
      for (const target of targets) {
        const staged = path.join(stateStage, target.stagePath);
        await system.copyTree(target.path, staged, { excludeNames: target.exclude || [] });
        if (target.sqliteDatabase) {
          // The control-plane database is captured as a point-in-time SQLite
          // snapshot rather than a file copy, so a write landing mid-copy can
          // never produce a torn database inside the bundle.
          await system.snapshotSqlite(path.join(target.path, target.sqliteDatabase), path.join(staged, target.sqliteDatabase));
        }
      }
      const stateSnapshot = await this.engine.snapshotTree({ repository, sourceDir: stateStage, tags: { mosjob: started.id, mosrole: 'state' } });
      storedSnapshotIds.push(stateSnapshot.snapshotId);

      jobs.stage(jobFile, 'Storing app volumes');
      const storedVolumes = [];
      for (const volume of ownedWithMounts) {
        jobs.log(jobFile, `Storing ${volume.name}`);
        const snapshot = await this.engine.snapshotTree({ repository, sourceDir: volume.mountpoint, tags: { mosjob: started.id, mosrole: 'volume', mosvolume: volume.name } });
        storedSnapshotIds.push(snapshot.snapshotId);
        storedVolumes.push({
          instanceId: volume.instanceId,
          name: volume.name,
          ownership: volume.ownership,
          packageId: volume.packageId,
          rawBytes: volume.rawBytes,
          snapshotId: snapshot.snapshotId,
          sourcePath: snapshot.sourcePath,
        });
      }

      jobs.stage(jobFile, 'Writing manifest');
      repositoryStoredBytes = (await this.engine.repositoryStats({ repository }))?.storedBytes ?? null;
      const manifest = {
        backup: {
          createdAt: new Date().toISOString(),
          engine: this.engine.name,
          id: started.id,
          kind: 'mos-whole-suite',
          schemaVersion: BACKUP_SCHEMA_VERSION,
          storage: 'engine-repository',
        },
        contents: {
          ambiguousVolumes: ambiguous,
          apps: packageInventory,
          stateRawBytes,
          stateSnapshot: { snapshotId: stateSnapshot.snapshotId, sourcePath: stateSnapshot.sourcePath },
          volumes: storedVolumes,
        },
        repository: { engineName: this.engine.name, repositoryId: repository.descriptor?.repositoryId || null, repositoryStoredBytes },
        source: await system.sourceInfo(),
      };
      // Success requires the destination to still be the mounted drive: if it
      // vanished mid-backup, everything above landed on the system disk and
      // this restore point must not be reported as a usable backup. The
      // manifest is written only after that holds, so its presence is the
      // completion marker.
      await this.assertDestinationMounted(started.destinationId, 'The backup destination disappeared while the backup was running. The written data is not a usable backup; reconnect the drive and run a new backup.');
      writeRestorePoint(manifestPath, manifest);
    } catch (error) {
      await this.discardFailedBackup({ jobFile, manifestPath, repository, snapshotIds: storedSnapshotIds });
      throw error;
    } finally {
      fs.rmSync(stateStage, { force: true, recursive: true });
      jobs.stage(jobFile, 'Restarting runtime');
      await system.startService('mos-homepage.service');
      for (const container of stoppedContainers) await system.startContainer(container);
    }
    jobs.update(jobFile, (job) => {
      job.stage = 'completed';
      job.status = 'succeeded';
      job.summary = { ambiguousVolumes: ambiguous.length, appCount: packageInventory.length, estimatedBytes, storedBytes: repositoryStoredBytes, volumeCount: owned.length };
    });
  }

  // A failed backup must leave nothing listed and nothing stranded. Snapshots
  // this job wrote are forgotten and the space reclaimed; the repository
  // itself is removed only when this job created it, so a mount check that
  // reports wrongly can never delete backups that were already on the drive.
  async discardFailedBackup({ jobFile, manifestPath, repository, snapshotIds }) {
    for (const suffix of ['', '.sha256', '.next', '.note.txt']) fs.rmSync(`${manifestPath}${suffix}`, { force: true });
    if (!repository) return;
    if (snapshotIds.length) {
      try {
        await this.engine.forgetSnapshots({ repository, snapshotIds });
        await this.engine.maintainRepository({ repository });
      } catch (cleanupError) {
        this.jobs.log(jobFile, `Some partly written backup data could not be cleaned up: ${cleanupError.message}`);
      }
    }
    if (repository.created) {
      fs.rmSync(repository.repositoryPath, { force: true, recursive: true });
      fs.rmSync(repositorySidecarPath(repository.destinationId), { force: true });
    }
  }

  // Deleting a restore point forgets its snapshots and then runs repository
  // maintenance, because unlinking alone reclaims nothing — an owner deleting
  // a backup to free a full drive would otherwise see no space come back.
  // A legacy bundle is still just a directory.
  //
  // Maintenance rewrites the shared repository with the engine's concurrency
  // safety off, so a delete must never overlap a job that is writing to it —
  // it runs only as a queued job through the same one-at-a-time pipeline as
  // backup and restore (deleteBackupJob), never inline.
  async deleteBackup(target) {
    if (!isRestorePointPath(target)) {
      fs.rmSync(target, { force: true, recursive: true });
      return { kind: 'bundle', path: target };
    }
    let snapshotIds = [];
    try {
      snapshotIds = snapshotIdsOfRestorePoint(readRestorePoint(target));
    } catch {
      // A restore point whose manifest no longer reads cannot name its
      // snapshots. Removing it is still the owner's call; the unreferenced
      // data stays until repository maintenance collects it.
    }
    if (snapshotIds.length) {
      const repository = await openDestinationRepository(this.engine, destinationOfRestorePoint(target), { create: false });
      await this.engine.forgetSnapshots({ repository, snapshotIds });
      await this.engine.maintainRepository({ repository });
    }
    for (const suffix of ['', '.sha256', '.note.txt']) fs.rmSync(`${target}${suffix}`, { force: true });
    return { kind: 'restore-point', path: target };
  }

  async deleteBackupJob(jobFile) {
    const { jobs } = this;
    const started = jobs.update(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
    jobs.stage(jobFile, 'Deleting backup and reclaiming space');
    const deleted = await this.deleteBackup(started.backupPath);
    jobs.update(jobFile, (job) => {
      job.stage = 'completed';
      job.status = 'succeeded';
      job.summary = { deletedKind: deleted.kind };
    });
  }

  // --- Validation ----------------------------------------------------------

  // Read-only validation: every check restore runs before its first mutation,
  // callable on its own so an operator can prove a backup is restorable
  // without restoring it. Throws on the first failed check; `keepStagedState`
  // hands the extracted state stage to the caller (restore reuses it) instead
  // of discarding it. The locator decides which storage is being validated.
  async validateBundle(target, options = {}) {
    return isRestorePointPath(target) ? this.validateRestorePoint(target, options) : this.validateLegacyBundle(target, options);
  }

  // Restore points live in an encrypted repository, so proving one restorable
  // means the engine reading back every snapshot this point names, plus the
  // same package-payload proof the tar path runs against a staged copy of the
  // state. Corruption fails here, before restore mutates anything. The check
  // is scoped to this point's snapshots on purpose: a whole-repository read
  // costs every backup ever taken and sits on the restore path, so it would
  // grow until validate times out exactly when recovery matters.
  async validateRestorePoint(manifestPath, { keepStagedState = false } = {}) {
    const { packages } = this;
    const destinationId = destinationOfRestorePoint(manifestPath);
    const manifest = readRestorePoint(manifestPath);
    this.assertRestorableManifest(manifest);
    const repository = await openDestinationRepository(this.engine, destinationId, { create: false });
    try {
      await this.engine.verifySnapshots({ repository, snapshotIds: snapshotIdsOfRestorePoint(manifest) });
    } catch (error) {
      const failure = new Error('This backup failed its integrity check: some of the data it stored is damaged or unreadable, so it cannot be trusted to restore. Nothing on this machine was changed. Take a new backup, and check the drive.');
      failure.engineOutput = error.engineOutput || null;
      failure.cause = error;
      throw failure;
    }
    ensureDir(this.paths.agentStateDir);
    const stagedState = fs.mkdtempSync(path.join(this.paths.agentStateDir, 'restore-'));
    let keepStaged = false;
    try {
      const stateSnapshot = manifest.contents?.stateSnapshot;
      if (!stateSnapshot?.snapshotId) throw new Error('This restore point does not record the suite state it was supposed to contain.');
      await this.engine.restoreSnapshot({ repository, snapshotId: stateSnapshot.snapshotId, sourcePath: stateSnapshot.sourcePath, targetDir: stagedState });
      packages.validatePayloads(stagedState, manifest.contents?.apps);
      keepStaged = keepStagedState;
    } finally {
      if (!keepStaged) fs.rmSync(stagedState, { force: true, recursive: true });
    }
    const report = await this.validationReport(manifest, manifestPath, { archivesReadable: true, checksums: true, packagePayloads: true, repositoryIntegrity: true });
    return { manifest, report, repository, stagedStatePath: keepStaged ? stagedState : null };
  }

  assertRestorableManifest(manifest) {
    if (manifest.backup?.kind !== 'mos-whole-suite') throw new Error('Backup bundle is not a MOS whole-suite backup.');
    if (!RESTORE_COMPATIBLE_SCHEMA_VERSIONS.includes(manifest.backup?.schemaVersion)) {
      throw new Error(`Backup bundle schema version ${manifest.backup?.schemaVersion ?? 'unknown'} is outside the supported restore window (${RESTORE_COMPATIBLE_SCHEMA_VERSIONS.join(', ')}).`);
    }
  }

  async validationReport(manifest, locator, checks) {
    const source = await this.system.sourceInfo();
    const bundleVersion = manifest.source?.version || null;
    const currentVersion = source?.version || null;
    const warnings = [];
    if (bundleVersion && currentVersion && bundleVersion !== currentVersion) {
      warnings.push(`This backup was created by MOS ${bundleVersion} but this machine runs MOS ${currentVersion}. Restore reuses the installed MOS software with the backup's validated app packages; recreating the recorded MOS version automatically is not supported yet.`);
    }
    return {
      apps: (manifest.contents?.apps || []).map((app) => ({ instanceId: app.instanceId, packageId: app.packageId, packageVersion: app.packageVersion })),
      bundlePath: locator,
      checkedAt: new Date().toISOString(),
      checks,
      schemaVersion: manifest.backup.schemaVersion,
      software: { bundleVersion, currentVersion, matched: !bundleVersion || !currentVersion || bundleVersion === currentVersion },
      storage: manifest.backup?.storage === 'engine-repository' ? 'engine-repository' : 'tar-bundle',
      volumes: (manifest.contents?.volumes || []).map((volume) => ({ name: volume.name, rawBytes: volume.rawBytes ?? null })),
      warnings,
    };
  }

  async validateLegacyBundle(bundleDir, { keepStagedState = false } = {}) {
    const { packages, system } = this;
    const manifestPath = path.join(bundleDir, 'manifest.json');
    const manifest = readJson(manifestPath);
    this.assertRestorableManifest(manifest);
    if (manifest.backup?.storage === 'engine-repository') throw new Error('This backup is stored in a repository, not a bundle, and cannot be read as one.');
    if (sha256(manifestPath) !== fs.readFileSync(path.join(bundleDir, 'MANIFEST.sha256'), 'utf8').trim().split(/\s+/u)[0]) throw new Error('Backup manifest checksum is invalid.');
    if (sha256(path.join(bundleDir, 'state.tar.gz')) !== manifest.contents?.stateArchiveSha256) throw new Error('Backup state archive checksum is invalid.');
    for (const volume of manifest.contents?.volumes || []) {
      if (sha256(path.join(bundleDir, volume.archive)) !== volume.archiveSha256) throw new Error(`Backup volume checksum is invalid for ${volume.name}.`);
    }
    await system.assertArchiveReadable(path.join(bundleDir, 'state.tar.gz'));
    for (const volume of manifest.contents?.volumes || []) await system.assertArchiveReadable(path.join(bundleDir, volume.archive));
    ensureDir(this.paths.agentStateDir);
    const stagedState = fs.mkdtempSync(path.join(this.paths.agentStateDir, 'restore-'));
    let keepStaged = false;
    try {
      await system.extractArchive(path.join(bundleDir, 'state.tar.gz'), stagedState);
      packages.validatePayloads(stagedState, manifest.contents?.apps);
      keepStaged = keepStagedState;
    } finally {
      if (!keepStaged) fs.rmSync(stagedState, { force: true, recursive: true });
    }
    const report = await this.validationReport(manifest, bundleDir, { archivesReadable: true, checksums: true, packagePayloads: true });
    return { manifest, report, stagedStatePath: keepStaged ? stagedState : null };
  }

  // A validate job mutates nothing, so it stays available even while an
  // interrupted restore blocks backup/restore work — checking whether a
  // bundle is restorable is part of recovering, not new destructive work.
  async validateBackup(jobFile) {
    const { jobs } = this;
    const started = jobs.update(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
    jobs.stage(jobFile, 'Validating backup bundle');
    const { report } = await this.validateBundle(started.backupPath);
    for (const warning of report.warnings) jobs.log(jobFile, warning);
    jobs.update(jobFile, (job) => {
      job.stage = 'completed';
      job.status = 'succeeded';
      job.summary = { appCount: report.apps.length, volumeCount: report.volumes.length };
      job.validation = report;
    });
  }

  // --- Import (upload) -----------------------------------------------------

  // The inverse of download: a downloaded `bundle.tar.gz` contains the whole
  // bundle (manifest, checksums, state, volumes), so importing means
  // unpacking it beside locally created bundles and proving it passes the
  // same read-only validation a restore preflight runs. The COMPLETE marker
  // is written last, so a failed or interrupted import is never listed as a
  // restorable bundle. Nothing about the running suite is touched.
  async importBundle(jobFile) {
    const { jobs, system } = this;
    const started = jobs.update(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
    const uploadPath = started.uploadPath;
    const backupsRoot = path.join(started.destinationId, 'MOS-backups');
    const stagingDir = path.join(backupsRoot, `.import-${started.id.slice(0, 8)}`);
    try {
      await this.assertDestinationMounted(started.destinationId, 'The backup destination is not mounted. Reconnect the drive, refresh drives, and upload again.');
      jobs.stage(jobFile, 'Reading the uploaded file');
      await system.assertArchiveReadable(uploadPath);
      const uploadBytes = (await system.pathBytes(uploadPath)) || 0;
      const freeBytes = await system.availableBytes(started.destinationId);
      if (freeBytes !== null && freeBytes < uploadBytes) {
        throw new Error(`Unpacking the uploaded backup needs about ${formatBytes(uploadBytes)} free on the destination, but only ${formatBytes(freeBytes)} is available.`);
      }
      jobs.stage(jobFile, 'Unpacking the uploaded backup');
      await system.extractArchive(uploadPath, stagingDir);
      const manifestPath = path.join(stagingDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) throw new Error('The uploaded file is not a MOS backup bundle.');
      const manifest = readJson(manifestPath);
      const backupId = String(manifest.backup?.id || '');
      for (const entry of fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot, { withFileTypes: true }) : []) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        let existingId = null;
        try { existingId = readJson(path.join(backupsRoot, entry.name, 'manifest.json')).backup?.id; } catch {}
        if (backupId && existingId === backupId) throw new Error('This backup already exists on the selected destination.');
      }
      const stamp = String(manifest.backup?.createdAt || '').replace(/[:.]/gu, '-');
      const bundleDir = path.join(backupsRoot, `mos-backup-${stamp || 'imported'}-${(backupId || started.id).slice(0, 8)}`);
      if (fs.existsSync(bundleDir)) throw new Error('This backup already exists on the selected destination.');
      jobs.stage(jobFile, 'Checking the uploaded backup');
      const { report } = await this.validateBundle(stagingDir);
      for (const warning of report.warnings) jobs.log(jobFile, warning);
      fs.renameSync(uploadPath, path.join(stagingDir, 'bundle.tar.gz'));
      fs.writeFileSync(path.join(stagingDir, COMPLETE_MARKER), `${new Date().toISOString()}\n`, 'utf8');
      fs.renameSync(stagingDir, bundleDir);
      jobs.update(jobFile, (job) => {
        job.outputPath = bundleDir;
        job.stage = 'completed';
        job.status = 'succeeded';
        job.summary = { appCount: report.apps.length, volumeCount: report.volumes.length };
        job.validation = { ...report, bundlePath: bundleDir };
      });
    } finally {
      fs.rmSync(stagingDir, { force: true, recursive: true });
      fs.rmSync(uploadPath, { force: true });
    }
  }

  // --- Restore -------------------------------------------------------------

  async restore(jobFile) {
    const { apps, jobs, system } = this;
    const started = jobs.update(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
    if (this.interruptedRestore()) throw new Error('A previous restore did not complete. Acknowledge it before starting a new restore.');
    const bundleDir = started.backupPath;

    jobs.stage(jobFile, 'Checking the backup');
    const { manifest, report, repository = null, stagedStatePath: stagedState } = await this.validateBundle(bundleDir, { keepStagedState: true });
    for (const warning of report.warnings) jobs.log(jobFile, warning);
    jobs.update(jobFile, (job) => { job.validation = report; });
    let runtimeStopped = false;
    try {
      jobs.stage(jobFile, 'Checking required space');
      const targets = this.stateTargets();
      let currentStateBytes = 0;
      for (const target of targets) currentStateBytes += (await system.pathBytes(target.path)) || 0;
      const knownPackageIds = [...new Set([
        ...(manifest.contents?.apps || []).map((app) => app.packageId),
        ...this.currentPackageIds(),
      ])];
      const { ambiguous: currentAmbiguous, owned: currentOwned } = classifyVolumes(await system.listVolumes(), knownPackageIds);
      let currentVolumeBytes = 0;
      const currentOwnedWithMounts = [];
      for (const volume of currentOwned) {
        const mountpoint = await system.volumeMountpoint(volume.name);
        const rawBytes = (await system.pathBytes(mountpoint)) || 0;
        currentVolumeBytes += rawBytes;
        currentOwnedWithMounts.push({ ...volume, mountpoint });
      }
      const rescueNeeds = currentStateBytes + currentVolumeBytes;
      const rescueFree = await system.availableBytes(this.paths.agentStateDir);
      if (rescueFree !== null && rescueFree < rescueNeeds) {
        throw new Error(`Keeping a recoverable copy of the current state needs up to ${formatBytes(rescueNeeds)}, but only ${formatBytes(rescueFree)} is free on the system disk. Free space before restoring.`);
      }
      const restoreNeeds = (manifest.contents?.stateRawBytes || 0) + (manifest.contents?.volumes || []).reduce((sum, volume) => sum + (volume.rawBytes || 0), 0);
      const restoreFree = await system.availableBytes(this.paths.stateRoot);
      if (restoreNeeds > 0 && restoreFree !== null && restoreFree + currentStateBytes + currentVolumeBytes < restoreNeeds) {
        throw new Error(`Restoring this backup needs about ${formatBytes(restoreNeeds)} of space, more than this machine can hold.`);
      }

      // Every mutation from here on happens under an open journal.
      this.writeJournal({ backupPath: bundleDir, jobId: started.id, phase: RESTORE_PHASES[0], schemaVersion: manifest.backup.schemaVersion, startedAt: new Date().toISOString() });
      jobs.stage(jobFile, 'Stopping current runtime');
      for (const container of await system.listAppContainers({ runningOnly: false })) await system.removeContainer(container);
      await system.stopService('mos-suite-manager.service');
      await system.stopService('mos-homepage.service');
      runtimeStopped = true;

      this.advanceJournal('rescue');
      jobs.stage(jobFile, 'Saving pre-restore rescue copy');
      const rescueDir = path.join(this.rescueRoot, started.id);
      const rescueStage = path.join(rescueDir, 'state');
      ensureDir(rescueDir);
      for (const target of targets) await system.copyTree(target.path, path.join(rescueStage, target.stagePath), { excludeNames: [] });
      await system.archiveTree(rescueStage, path.join(rescueDir, 'state-before-restore.tar.gz'));
      fs.rmSync(rescueStage, { force: true, recursive: true });
      const rescuedVolumes = [];
      for (const volume of currentOwnedWithMounts) {
        jobs.log(jobFile, `Saving rescue copy of ${volume.name}`);
        const archivePath = path.join(rescueDir, 'volumes', `${volume.name}.tar.gz`);
        ensureDir(path.dirname(archivePath));
        await system.archiveTree(volume.mountpoint, archivePath);
        rescuedVolumes.push({ archive: `volumes/${volume.name}.tar.gz`, name: volume.name });
      }
      await system.assertArchiveReadable(path.join(rescueDir, 'state-before-restore.tar.gz'));
      for (const volume of rescuedVolumes) await system.assertArchiveReadable(path.join(rescueDir, volume.archive));
      writeJson(path.join(rescueDir, 'rescue-manifest.json'), {
        createdAt: new Date().toISOString(),
        jobId: started.id,
        note: 'Complete pre-restore copy of MOS authoritative state. Restore it manually if the restore that created it failed.',
        stateArchive: 'state-before-restore.tar.gz',
        volumes: rescuedVolumes,
      });
      jobs.update(jobFile, (job) => { job.rescuePath = rescueDir; });
      // Exactly one rollback generation, retired only now that its
      // replacement is complete and proven readable: deleting the previous
      // rescue any earlier would leave a window with no recoverable state.
      for (const entry of fs.readdirSync(this.rescueRoot)) {
        if (entry !== started.id) fs.rmSync(path.join(this.rescueRoot, entry), { force: true, recursive: true });
      }

      this.advanceJournal('restoring-state', { rescuePath: rescueDir });
      jobs.stage(jobFile, 'Restoring suite state');
      for (const target of targets) {
        await system.removeTree(target.path);
        const staged = path.join(stagedState, target.stagePath);
        if (fs.existsSync(staged)) await system.copyTree(staged, target.path, { excludeNames: [] });
        else jobs.log(jobFile, `The backup does not contain ${target.id}; it is left absent.`);
      }

      this.advanceJournal('restoring-volumes');
      jobs.stage(jobFile, 'Restoring app volumes');
      // Absence reconciliation: every currently MOS-owned volume was rescued
      // above and is now removed, so a volume created after this backup was
      // taken cannot survive to be silently reused by a later install. The
      // backup's volumes are then recreated with ownership labels from birth.
      for (const volume of currentOwnedWithMounts) await system.removeVolume(volume.name);
      for (const name of currentAmbiguous) {
        jobs.log(jobFile, `Volume ${name} wears the MOS prefix but matches no known package, so it was left untouched. Remove it manually if it is unwanted.`);
      }
      for (const volume of manifest.contents?.volumes || []) {
        jobs.log(jobFile, `Restoring ${volume.name}`);
        const identity = volumeIdentityFromManifest(volume, manifest.contents?.apps);
        await system.createVolume(volume.name, appVolumeLabels({ instanceId: identity.instanceId, name: volume.name, packageId: identity.packageId }));
        const mountpoint = await system.volumeMountpoint(volume.name);
        if (repository) await this.engine.restoreSnapshot({ repository, snapshotId: volume.snapshotId, sourcePath: volume.sourcePath, targetDir: mountpoint });
        else await system.extractArchive(path.join(bundleDir, volume.archive), mountpoint);
      }

      this.advanceJournal('reconciling-apps');
      jobs.stage(jobFile, 'Rebuilding app runtime');
      await system.restoreStateOwnership();
      await apps.reconcile((message) => jobs.log(jobFile, message));

      this.advanceJournal('verifying');
      jobs.stage(jobFile, 'Verifying restored state');
      const verification = await this.verifyRestore(manifest);
      for (const warning of verification.warnings) jobs.log(jobFile, warning);
      jobs.update(jobFile, (job) => { job.verification = verification; });

      this.advanceJournal('completed', { completedAt: new Date().toISOString() });
      fs.rmSync(this.journalPath, { force: true });
    } finally {
      fs.rmSync(stagedState, { force: true, recursive: true });
      if (runtimeStopped) {
        await system.restoreStateOwnership();
        jobs.stage(jobFile, 'Starting restored control plane');
        await system.startService('mos-homepage.service');
        await system.startService('mos-suite-manager.service');
        await system.reloadCaddy();
      }
    }
    jobs.update(jobFile, (job) => { job.stage = 'completed'; job.status = 'succeeded'; });
  }

  currentPackageIds() {
    try {
      return this.apps.installedInstances().map((instance) => instance.packageId);
    } catch {
      // A broken current store must not block restoring a healthy backup —
      // classification falls back to the packages the bundle itself proves.
      return [];
    }
  }

  // Success is a comparison against the bundle, not the absence of thrown
  // errors: the restored control-plane inventory and the restored persistent
  // resources must both match the manifest exactly, presence and absence.
  async verifyRestore(manifest) {
    const expectedApps = (manifest.contents?.apps || []).map((app) => `${app.instanceId}:${app.packageId}`).sort();
    const actualInstances = this.apps.installedInstances();
    const actualApps = actualInstances.map((instance) => `${instance.instanceId}:${instance.packageId}`).sort();
    if (JSON.stringify(expectedApps) !== JSON.stringify(actualApps)) {
      throw new Error(`Restore verification failed: installed apps do not match the backup (expected [${expectedApps.join(', ')}], found [${actualApps.join(', ')}]).`);
    }
    const expectedVolumes = (manifest.contents?.volumes || []).map((volume) => volume.name).sort();
    const knownPackageIds = [...new Set([...(manifest.contents?.apps || []).map((app) => app.packageId), ...actualInstances.map((instance) => instance.packageId)])];
    const { ambiguous, owned } = classifyVolumes(await this.system.listVolumes(), knownPackageIds);
    const actualVolumes = owned.map((volume) => volume.name).sort();
    const missing = expectedVolumes.filter((name) => !actualVolumes.includes(name));
    const extra = actualVolumes.filter((name) => !expectedVolumes.includes(name));
    if (missing.length || extra.length) {
      throw new Error(`Restore verification failed: persistent volumes do not match the backup (missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]).`);
    }
    return {
      apps: { expected: expectedApps.length, matched: true },
      volumes: { expected: expectedVolumes.length, matched: true },
      warnings: ambiguous.map((name) => `Volume ${name} wears the MOS prefix but matches no known package; it was not part of this restore.`),
    };
  }
}

module.exports = {
  BackupAgentCore,
  COMPLETE_MARKER,
  isRestorePointPath,
  readRestorePoint,
  RESTORE_JOURNAL_FILENAME,
  RESTORE_PHASES,
  restorePublicIdentity,
  sha256,
  validatePackagePayloads,
  writeRestorePoint,
};
