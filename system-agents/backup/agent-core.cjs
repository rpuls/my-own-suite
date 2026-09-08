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
//   archiveTree(sourceDir, archivePath)   assertArchiveReadable(archivePath)
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
//   openOrCreateRepository({ create, env, localPath, location }) -> repository
//   snapshotTree({ repository, sourceDir, tags }) -> { snapshotId, sourcePath }
//   restoreSnapshot({ repository, snapshotId, sourcePath, targetDir })
//   forgetSnapshots({ repository, snapshotIds })  maintainRepository({ repository })
//   verifySnapshots({ repository, snapshotIds })  repositoryStats({ repository })
// `destinations` = resolve(id) -> destination (../destinations.cjs), which owns
//   whether a drive is still mounted or a bucket still answers, how much room
//   is left, and where a restore point's manifest is kept.
//
// Every backup is a restore point in that repository. The tar adapter methods
// remain for the one thing that is still tar: the pre-restore rescue copy,
// which targets the system disk and must work with no destination attached at
// all.

const fs = require('node:fs');
const os = require('node:os');
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
const { RESTORE_POINTS_DIRNAME } = require('./engines/engine.cjs');
const { parseObjectLocator, readRestorePoint, sha256, writeRestorePoint } = require('./destinations.cjs');

const RESTORE_JOURNAL_FILENAME = 'restore-journal.json';
// MOS 0.19 and earlier wrote each backup as an unencrypted tar bundle. That
// read path is gone with the format, so such a backup gets one plain sentence
// instead of a checksum failure from a file this code no longer understands.
const UNREADABLE_LEGACY_BACKUP = 'This backup was written by an older MOS in the unencrypted bundle format, which this version can no longer read. Restore it with MOS 0.19 or earlier, or take a new backup on this machine.';
// One sentence for every way a drive can go away mid-write, so an owner reads
// the same cause whether the loss was caught by MOS or reported by the engine.
const DESTINATION_LOST = 'The backup drive was disconnected while MOS was writing to it, so this did not finish. Reconnect the drive, click Refresh drives, and try again.';
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

// Whether a restore point was written by another machine. The install id is
// the answer when both sides have one: a standby may carry the same hostname
// on purpose, and an address changes on the same machine. Older manifests fall
// back to the hostname, and a manifest naming neither counts as this machine's
// own work, which is the reading that never invents a question.
function writtenByAnotherMachine(source = {}, current = {}) {
  if (source.installId && current.installId) return source.installId !== current.installId;
  return Boolean(source.hostname && current.hostname && source.hostname !== current.hostname);
}

const RESTORE_ADDRESS_PLANS = Object.freeze(['copy', 'move']);

// The one thing in a backup that is portable between machines is a domain;
// every other address is bound to the machine, so there is nothing to choose.
// A restore onto another machine of a backup that carries a domain (or, for a
// manifest too old to say, may carry one) needs the owner's answer before
// anything is touched: `move` serves the domain from this machine, `copy`
// parks it and rebuilds the apps on this machine's own address.
function restoreAddressPlan({ current = {}, manifest = {}, requested = null } = {}) {
  const source = manifest.source || {};
  const foreign = writtenByAnotherMachine(source, current);
  const domain = source.domain || null;
  const knownWithoutDomain = source.domain === null;
  if (!foreign || knownWithoutDomain) return { domain, foreign, plan: 'same' };
  if (!RESTORE_ADDRESS_PLANS.includes(requested)) {
    throw new Error(`This backup was written by another machine${domain ? ` and carries the address ${domain}` : ''}. Choose whether to move that address to this machine or to restore as a copy before restoring.`);
  }
  return { domain, foreign, plan: requested };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'an unknown amount';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// A restore point on a drive is identified by its manifest file inside the
// destination's restore-points directory. Anything else on the wire is not
// something this version can restore, and is refused rather than guessed at.
function isRestorePointPath(target) {
  return typeof target === 'string' && target.endsWith('.json') && path.basename(path.dirname(target)) === RESTORE_POINTS_DIRNAME;
}

// Either shape of locator that names something MOS can still restore. A bucket
// has only this one: there were never any retired-format backups in one.
function isRestorePointLocator(target) {
  return Boolean(parseObjectLocator(target)) || isRestorePointPath(target);
}

function destinationOfRestorePoint(manifestPath) {
  return path.resolve(path.dirname(manifestPath), '..', '..');
}

function snapshotIdsOfRestorePoint(manifest) {
  return [manifest.contents?.stateSnapshot?.snapshotId, ...(manifest.contents?.volumes || []).map((volume) => volume.snapshotId)].filter(Boolean);
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
  constructor({ apps, destinations, engine, identity = {}, jobs, packages, paths, system }) {
    this.apps = apps;
    this.destinations = destinations;
    this.engine = engine;
    // Who this machine is and what it does with a restored domain. The host
    // wiring supplies the real answers; a core built without them names the
    // machine by hostname alone and treats every domain as untouched.
    this.identity = {
      domain: () => null,
      hostname: () => os.hostname(),
      installId: () => null,
      parkRestoredDomain: async () => null,
      serveRestoredDomain: async () => null,
      ...identity,
    };
    this.jobs = jobs;
    this.packages = packages;
    this.paths = paths;
    this.system = system;
    this.journalPath = path.join(paths.agentStateDir, RESTORE_JOURNAL_FILENAME);
    this.rescueRoot = path.join(paths.agentStateDir, 'pre-restore-rescue');
    this.uncollectedPath = path.join(paths.agentStateDir, 'uncollected-data.json');
  }

  // A backup whose worker was killed — power loss, a kill, a reboot — never runs
  // its own cleanup, so the packs it had already written stay in the repository
  // referenced by nothing. Until now the only thing that ever collected them was
  // the next delete, which an owner may never do.
  //
  // Noting the destination is all that can be done at the moment it is noticed:
  // collecting rewrites the repository with the engine's concurrency safety off,
  // so it has to happen inside the one-at-a-time pipeline rather than beside
  // whatever starts next.
  noteUncollectedData(destinationId) {
    if (!destinationId) return;
    const pending = new Set(this.readUncollectedData());
    pending.add(String(destinationId));
    try {
      fs.mkdirSync(path.dirname(this.uncollectedPath), { recursive: true });
      fs.writeFileSync(this.uncollectedPath, `${JSON.stringify([...pending], null, 2)}\n`, 'utf8');
    } catch {}
  }

  readUncollectedData() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.uncollectedPath, 'utf8'));
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  clearUncollectedData(destinationId) {
    const remaining = this.readUncollectedData().filter((entry) => entry !== String(destinationId));
    try {
      if (remaining.length === 0) fs.rmSync(this.uncollectedPath, { force: true });
      else fs.writeFileSync(this.uncollectedPath, `${JSON.stringify(remaining, null, 2)}\n`, 'utf8');
    } catch {}
  }

  // Runs at the start of the next job for that destination, which is the first
  // moment the repository is both reachable and provably not being written to.
  // A failure here is reported and cleared rather than raised: the owner asked
  // for a backup, and refusing it because leftover data could not be collected
  // would turn a housekeeping problem into a lost backup.
  async collectUncollectedData(destination, jobFile) {
    const destinationId = destination?.id;
    if (!destinationId || !this.readUncollectedData().includes(String(destinationId))) return false;
    this.jobs.stage(jobFile, 'Reclaiming space from an interrupted backup');
    try {
      const repository = await destination.repository({ create: false });
      await this.engine.maintainRepository({ repository });
      this.jobs.log(jobFile, 'Reclaimed data left in the backup store by an earlier backup that was interrupted.');
    } catch (error) {
      this.jobs.log(jobFile, `Data left by an earlier interrupted backup could not be reclaimed: ${error.message}`);
    }
    this.clearUncollectedData(destinationId);
    return true;
  }

  stateTargets() {
    return managedStateTargets(this.paths).filter((target) => target.backedUp && target.stagePath);
  }

  // What a backup locator names: which destination holds it, which restore
  // point it is, and whether it is a restore point at all — a drive can still
  // carry a directory written in the retired tar format, which is listed and
  // deletable but no longer readable.
  resolveBackup(locator) {
    const object = parseObjectLocator(locator);
    if (object) return { destination: this.destinations.resolve(object.destinationId), kind: 'restore-point', pointId: object.pointId };
    if (isRestorePointPath(locator)) {
      return { destination: this.destinations.resolve(destinationOfRestorePoint(locator)), kind: 'restore-point', pointId: path.basename(locator, '.json') };
    }
    return { destination: this.destinations.resolve(path.resolve(path.dirname(locator), '..')), kind: 'legacy-bundle', path: locator };
  }

  // A destination lost mid-write fails inside the engine, which reports the
  // path or request it could not complete as a fatal error — true, and
  // unreadable as anything but a MOS bug. When the destination is simply gone,
  // that is the whole story, so it replaces the message; the engine's own
  // output stays on the error for the support panel.
  async destinationLoss(destination, error) {
    try {
      if (await destination.available()) return error;
    } catch {
      return error;
    }
    const failure = new Error(destination.lostMessage || DESTINATION_LOST);
    failure.cause = error;
    failure.engineOutput = error?.engineOutput || null;
    return failure;
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
    const destination = this.destinations.resolve(started.destinationId);
    await destination.assertAvailable('The backup destination is not mounted. Reconnect the drive, refresh drives, and try again.');
    await this.collectUncollectedData(destination, jobFile);
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
    const restorePointsPresent = (await destination.points.count()) > 0;
    // Null where the destination sells capacity rather than reserving it: a
    // bucket has no free-space figure to refuse a backup against, and the
    // provider says so itself if a write is genuinely over a limit.
    const freeBytes = await destination.freeBytes();
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
    const repository = await destination.repository();
    if (repository.created) jobs.log(jobFile, `Created a new encrypted backup repository ${destination.kind === 'object' ? 'in this bucket' : 'on this drive'}.`);
    jobs.update(jobFile, (job) => { job.outputPath = destination.points.locator(started.id); });
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
          // Recorded so retention can tell a scheduled backup from one an owner
          // chose to take. A manifest without it predates automatic backups and
          // counts as the owner's, which is the answer that never deletes
          // something on a guess.
          initiator: started.initiator === 'schedule' ? 'schedule' : 'owner',
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
        repository: { engineName: this.engine.name, repositoryId: repository.descriptor?.repositoryId || repository.repositoryId || null, repositoryStoredBytes },
        // The machine that wrote this restore point, and the domain it served.
        // A destination can hold the backups of more than one server once a
        // replacement takes over, and an owner about to restore has to be able
        // to see which one they are about to become and whether it carries an
        // address only one machine can answer on.
        source: { ...await system.sourceInfo(), domain: this.identity.domain(), hostname: this.identity.hostname(), installId: this.identity.installId() },
      };
      // Success requires the destination to still be the one this started
      // against: if a drive vanished mid-backup, everything above landed on the
      // system disk and this restore point must not be reported as a usable
      // backup. The manifest is written only after that holds, so its presence
      // is the completion marker.
      await destination.assertStillWritable(destination.lostMessage);
      await destination.points.write(started.id, manifest);
      // Written after the manifest rather than before it, so a crash between
      // the two can only lose the note — never leave a note describing a
      // restore point that does not exist.
      if (started.note) await destination.points.writeNote(started.id, started.note);
    } catch (error) {
      await this.discardFailedBackup({ destination, jobFile, pointId: started.id, repository, snapshotIds: storedSnapshotIds });
      throw await this.destinationLoss(destination, error);
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
  async discardFailedBackup({ destination, jobFile, pointId, repository, snapshotIds }) {
    await destination.points.remove(pointId).catch(() => {});
    if (!repository) return;
    // Nothing to forget does not mean nothing was written: a backup that failed
    // before its first snapshot was recorded still left packs behind, and only a
    // maintenance pass can tell that they are referenced by nothing.
    if (!snapshotIds.length) this.noteUncollectedData(destination?.id);
    if (snapshotIds.length) {
      try {
        await this.engine.forgetSnapshots({ repository, snapshotIds });
        await this.engine.maintainRepository({ repository });
      } catch (cleanupError) {
        this.jobs.log(jobFile, `Some partly written backup data could not be cleaned up: ${cleanupError.message}`);
      }
    }
    if (repository.created) await destination.discardCreatedRepository(repository).catch(() => {});
  }

  // Deleting a restore point forgets its snapshots and then runs repository
  // maintenance, because unlinking alone reclaims nothing — an owner deleting
  // a backup to free a full drive would otherwise see no space come back.
  //
  // Maintenance rewrites the shared repository with the engine's concurrency
  // safety off, so a delete must never overlap a job that is writing to it —
  // it runs only as a queued job through the same one-at-a-time pipeline as
  // backup and restore (deleteBackupJob), never inline.
  async deleteBackup(target) {
    const { destination, kind, pointId } = this.resolveBackup(target);
    // A backup left over in the retired tar format can no longer be read, but
    // it is still a directory the owner is entitled to remove: refusing that
    // too would strand its space on the drive with nothing MOS can do about it.
    if (kind === 'legacy-bundle') {
      fs.rmSync(target, { force: true, recursive: true });
      return { kind, path: target };
    }
    let snapshotIds = [];
    try {
      snapshotIds = snapshotIdsOfRestorePoint(await destination.points.read(pointId));
    } catch {
      // A restore point whose manifest no longer reads cannot name its
      // snapshots. Removing it is still the owner's call; the unreferenced
      // data stays until repository maintenance collects it.
    }
    // The manifest goes first, because it is what makes a restore point exist.
    // A delete interrupted after this leaves data nobody references, which the
    // next maintenance pass collects; the other order would leave a backup
    // still listed and offered for restore with its contents already gone.
    await destination.points.remove(pointId);
    if (snapshotIds.length) {
      const repository = await destination.repository({ create: false });
      await this.engine.forgetSnapshots({ repository, snapshotIds });
      await this.engine.maintainRepository({ repository });
    }
    return { kind, path: target };
  }

  async deleteBackupJob(jobFile) {
    const { jobs } = this;
    const started = jobs.update(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
    jobs.stage(jobFile, 'Deleting backup and reclaiming space');
    // Reclaiming space rewrites the repository, so a delete is a writer too and
    // fails the same way when the destination goes away underneath it.
    const deleted = await this.deleteBackup(started.backupPath).catch(async (error) => {
      throw await this.destinationLoss(this.resolveBackup(started.backupPath).destination, error);
    });
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
  // hands the restored state stage to the caller (restore reuses it) instead
  // of discarding it.
  //
  // Restore points live in an encrypted repository, so proving one restorable
  // means the engine reading back every snapshot this point names, plus a
  // package-payload proof against a staged copy of the state. Corruption fails
  // here, before restore mutates anything. The check is scoped to this point's
  // snapshots on purpose: a whole-repository read costs every backup ever
  // taken and sits on the restore path, so it would grow until validate times
  // out exactly when recovery matters.
  async validateRestorePoint(locator, { keepStagedState = false } = {}) {
    const { packages } = this;
    if (!isRestorePointLocator(locator)) throw new Error(UNREADABLE_LEGACY_BACKUP);
    const { destination, pointId } = this.resolveBackup(locator);
    const manifest = await destination.points.read(pointId);
    this.assertRestorableManifest(manifest);
    const repository = await destination.repository({ create: false });
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
    const report = await this.validationReport(manifest, locator, { archivesReadable: true, checksums: true, packagePayloads: true, repositoryIntegrity: true });
    return { manifest, report, repository, stagedStatePath: keepStaged ? stagedState : null };
  }

  assertRestorableManifest(manifest) {
    if (manifest.backup?.kind !== 'mos-whole-suite') throw new Error('This backup is not a MOS whole-suite backup.');
    if (!RESTORE_COMPATIBLE_SCHEMA_VERSIONS.includes(manifest.backup?.schemaVersion)) throw new Error(UNREADABLE_LEGACY_BACKUP);
  }

  async validationReport(manifest, locator, checks) {
    const source = await this.system.sourceInfo();
    const backupVersion = manifest.source?.version || null;
    const currentVersion = source?.version || null;
    const backupHostname = manifest.source?.hostname || null;
    const currentHostname = this.identity.hostname();
    const warnings = [];
    if (backupVersion && currentVersion && backupVersion !== currentVersion) {
      warnings.push(`This backup was created by MOS ${backupVersion} but this machine runs MOS ${currentVersion}. Restore reuses the installed MOS software with the backup's validated app packages; recreating the recorded MOS version automatically is not supported yet.`);
    }
    return {
      apps: (manifest.contents?.apps || []).map((app) => ({ instanceId: app.instanceId, packageId: app.packageId, packageVersion: app.packageVersion })),
      backupPath: locator,
      checkedAt: new Date().toISOString(),
      checks,
      schemaVersion: manifest.backup.schemaVersion,
      software: { backupVersion, currentVersion, matched: !backupVersion || !currentVersion || backupVersion === currentVersion },
      source: {
        backupDomain: manifest.source?.domain || null,
        backupHostname,
        backupInstallId: manifest.source?.installId || null,
        currentHostname,
        currentInstallId: this.identity.installId(),
        matched: !writtenByAnotherMachine(manifest.source, { hostname: currentHostname, installId: this.identity.installId() }),
      },
      volumes: (manifest.contents?.volumes || []).map((volume) => ({ name: volume.name, rawBytes: volume.rawBytes ?? null })),
      warnings,
    };
  }

  // A validate job mutates nothing, so it stays available even while an
  // interrupted restore blocks backup/restore work — checking whether a
  // backup is restorable is part of recovering, not new destructive work.
  async validateBackup(jobFile) {
    const { jobs } = this;
    const started = jobs.update(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
    jobs.stage(jobFile, 'Checking the backup');
    const { report } = await this.validateRestorePoint(started.backupPath);
    for (const warning of report.warnings) jobs.log(jobFile, warning);
    jobs.update(jobFile, (job) => {
      job.stage = 'completed';
      job.status = 'succeeded';
      job.summary = { appCount: report.apps.length, volumeCount: report.volumes.length };
      job.validation = report;
    });
  }

  // --- Restore -------------------------------------------------------------

  async restore(jobFile) {
    const { apps, jobs, system } = this;
    const started = jobs.update(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
    if (this.interruptedRestore()) throw new Error('A previous restore did not complete. Acknowledge it before starting a new restore.');
    const backupPath = started.backupPath;

    jobs.stage(jobFile, 'Checking the backup');
    const { manifest, report, repository, stagedStatePath: stagedState } = await this.validateRestorePoint(backupPath, { keepStagedState: true });
    for (const warning of report.warnings) jobs.log(jobFile, warning);
    jobs.update(jobFile, (job) => { job.validation = report; });
    let runtimeStopped = false;
    try {
      const address = restoreAddressPlan({
        current: { hostname: this.identity.hostname(), installId: this.identity.installId() },
        manifest,
        requested: started.address,
      });
      jobs.update(jobFile, (job) => { job.address = { domain: address.domain, plan: address.plan }; });
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
      this.writeJournal({ backupPath, jobId: started.id, phase: RESTORE_PHASES[0], schemaVersion: manifest.backup.schemaVersion, startedAt: new Date().toISOString() });
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
      // A copy keeps this machine's own Caddy files: they carry its own address
      // and Easy Door, and the backup's would carry the other machine's domain.
      for (const target of targets.filter((entry) => address.plan !== 'copy' || !entry.id.startsWith('caddy-'))) {
        await system.removeTree(target.path);
        const staged = path.join(stagedState, target.stagePath);
        if (fs.existsSync(staged)) await system.copyTree(staged, target.path, { excludeNames: [] });
        else jobs.log(jobFile, `The backup does not contain ${target.id}; it is left absent.`);
      }
      if (address.plan === 'copy') {
        const parked = await this.identity.parkRestoredDomain();
        if (parked) jobs.log(jobFile, `Kept the address ${parked} aside: this machine answers on its own address, and Settings offers to move ${parked} here later.`);
      } else if (address.plan === 'move') {
        const served = await this.identity.serveRestoredDomain();
        if (served) jobs.log(jobFile, `This machine now serves ${served}. Point that name at this machine's address to finish the move; Settings shows how.`);
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
        await system.createVolume(volume.name, appVolumeLabels({ instanceId: volume.instanceId || null, name: volume.name, packageId: volume.packageId || null }));
        const mountpoint = await system.volumeMountpoint(volume.name);
        await this.engine.restoreSnapshot({ repository, snapshotId: volume.snapshotId, sourcePath: volume.sourcePath, targetDir: mountpoint });
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
  isRestorePointLocator,
  isRestorePointPath,
  readRestorePoint,
  RESTORE_ADDRESS_PLANS,
  RESTORE_JOURNAL_FILENAME,
  RESTORE_PHASES,
  restoreAddressPlan,
  restorePublicIdentity,
  UNREADABLE_LEGACY_BACKUP,
  sha256,
  validatePackagePayloads,
  writeRestorePoint,
};
