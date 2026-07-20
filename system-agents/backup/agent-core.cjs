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
//   snapshotSqlite(databasePath, targetPath)
//   restoreStateOwnership()               sourceInfo() -> { branch, commit, repoDir, version }
//
// `packages` = { inventory(), validatePayloads(stagedRoot, apps) }
// `apps`     = { installedInstances() -> [{ enabled, instanceId, packageId }], reconcile(log) }
// `jobs`     = { log(file, message), stage(file, name), update(file, mutator) }

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

class BackupAgentCore {
  constructor({ apps, jobs, packages, paths, system }) {
    this.apps = apps;
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
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const bundleDir = path.join(started.destinationId, 'MOS-backups', `mos-backup-${stamp}-${started.id.slice(0, 8)}`);
    const stateStage = path.join(bundleDir, 'state');
    const volumesDir = path.join(bundleDir, 'volumes');

    jobs.stage(jobFile, 'Preparing backup bundle');
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
    const freeBytes = await system.availableBytes(started.destinationId);
    if (freeBytes !== null && freeBytes < estimatedBytes) {
      throw new Error(`The destination has ${formatBytes(freeBytes)} free but this backup needs up to ${formatBytes(estimatedBytes)}. Free space on the destination and try again.`);
    }
    jobs.log(jobFile, `Backing up about ${formatBytes(estimatedBytes)} of persistent state (${owned.length} app volumes).`);

    ensureDir(bundleDir);
    ensureDir(volumesDir);
    jobs.update(jobFile, (job) => { job.outputPath = bundleDir; });
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
      await system.archiveTree(stateStage, path.join(bundleDir, 'state.tar.gz'));

      jobs.stage(jobFile, 'Archiving app volumes');
      const archivedVolumes = [];
      for (const volume of ownedWithMounts) {
        jobs.log(jobFile, `Archiving ${volume.name}`);
        const archivePath = path.join(volumesDir, `${volume.name}.tar.gz`);
        await system.archiveTree(volume.mountpoint, archivePath);
        archivedVolumes.push({
          archive: `volumes/${volume.name}.tar.gz`,
          archiveBytes: fs.statSync(archivePath).size,
          archiveSha256: sha256(archivePath),
          instanceId: volume.instanceId,
          name: volume.name,
          ownership: volume.ownership,
          packageId: volume.packageId,
          rawBytes: volume.rawBytes,
        });
      }

      jobs.stage(jobFile, 'Writing manifest');
      const stateArchivePath = path.join(bundleDir, 'state.tar.gz');
      const producedBytes = fs.statSync(stateArchivePath).size + archivedVolumes.reduce((sum, volume) => sum + volume.archiveBytes, 0);
      const freeForBundle = await system.availableBytes(started.destinationId);
      if (freeForBundle !== null && freeForBundle < producedBytes) {
        throw new Error(`The destination ran out of space for the downloadable bundle copy: ${formatBytes(freeForBundle)} free, ${formatBytes(producedBytes)} needed.`);
      }
      const manifest = {
        backup: { createdAt: new Date().toISOString(), id: started.id, kind: 'mos-whole-suite', schemaVersion: BACKUP_SCHEMA_VERSION },
        contents: {
          ambiguousVolumes: ambiguous,
          apps: packageInventory,
          stateArchive: 'state.tar.gz',
          stateArchiveBytes: fs.statSync(stateArchivePath).size,
          stateArchiveSha256: sha256(stateArchivePath),
          stateRawBytes,
          volumes: archivedVolumes,
        },
        source: await system.sourceInfo(),
      };
      writeJson(path.join(bundleDir, 'manifest.json'), manifest);
      fs.writeFileSync(path.join(bundleDir, 'MANIFEST.sha256'), `${sha256(path.join(bundleDir, 'manifest.json'))}  manifest.json\n`);
      await system.archiveTree(bundleDir, path.join(bundleDir, 'bundle.tar.gz'), { entries: ['manifest.json', 'MANIFEST.sha256', 'state.tar.gz', 'volumes'] });
      fs.writeFileSync(path.join(bundleDir, COMPLETE_MARKER), `${new Date().toISOString()}\n`, 'utf8');
      fs.rmSync(stateStage, { force: true, recursive: true });
    } finally {
      jobs.stage(jobFile, 'Restarting runtime');
      await system.startService('mos-homepage.service');
      for (const container of stoppedContainers) await system.startContainer(container);
    }
    jobs.update(jobFile, (job) => {
      job.stage = 'completed';
      job.status = 'succeeded';
      job.summary = { ambiguousVolumes: ambiguous.length, appCount: packageInventory.length, estimatedBytes, volumeCount: owned.length };
    });
  }

  // --- Validation ----------------------------------------------------------

  // Read-only bundle validation: every check restore runs before its first
  // mutation, callable on its own so an operator can prove a bundle is
  // restorable without restoring it. Throws on the first failed check;
  // `keepStagedState` hands the extracted state stage to the caller (restore
  // reuses it) instead of discarding it.
  async validateBundle(bundleDir, { keepStagedState = false } = {}) {
    const { packages, system } = this;
    const manifestPath = path.join(bundleDir, 'manifest.json');
    const manifest = readJson(manifestPath);
    if (manifest.backup?.kind !== 'mos-whole-suite') throw new Error('Backup bundle is not a MOS whole-suite backup.');
    if (!RESTORE_COMPATIBLE_SCHEMA_VERSIONS.includes(manifest.backup?.schemaVersion)) {
      throw new Error(`Backup bundle schema version ${manifest.backup?.schemaVersion ?? 'unknown'} is outside the supported restore window (${RESTORE_COMPATIBLE_SCHEMA_VERSIONS.join(', ')}).`);
    }
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
    const source = await system.sourceInfo();
    const bundleVersion = manifest.source?.version || null;
    const currentVersion = source?.version || null;
    const warnings = [];
    if (bundleVersion && currentVersion && bundleVersion !== currentVersion) {
      warnings.push(`This backup was created by MOS ${bundleVersion} but this machine runs MOS ${currentVersion}. Restore reuses the installed MOS software with the backup's validated app packages; recreating the recorded MOS version automatically is not supported yet.`);
    }
    const report = {
      apps: (manifest.contents?.apps || []).map((app) => ({ instanceId: app.instanceId, packageId: app.packageId, packageVersion: app.packageVersion })),
      bundlePath: bundleDir,
      checkedAt: new Date().toISOString(),
      checks: { archivesReadable: true, checksums: true, packagePayloads: true },
      schemaVersion: manifest.backup.schemaVersion,
      software: { bundleVersion, currentVersion, matched: !bundleVersion || !currentVersion || bundleVersion === currentVersion },
      volumes: (manifest.contents?.volumes || []).map((volume) => ({ name: volume.name, rawBytes: volume.rawBytes ?? null })),
      warnings,
    };
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

    jobs.stage(jobFile, 'Validating backup bundle');
    const { manifest, report, stagedStatePath: stagedState } = await this.validateBundle(bundleDir, { keepStagedState: true });
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
        await system.extractArchive(path.join(bundleDir, volume.archive), await system.volumeMountpoint(volume.name));
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
  RESTORE_JOURNAL_FILENAME,
  RESTORE_PHASES,
  sha256,
  validatePackagePayloads,
};
