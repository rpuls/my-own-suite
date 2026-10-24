#!/usr/bin/env node

// Host wiring for the MOS backup agent: places and archives, the job store, the
// unix-socket API and the worker entry. The backup/restore engine itself lives
// in agent-core.cjs behind injected adapters, where unit tests can reach it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { BackupAgentCore, isRestorePointPath, sha256, validatePackagePayloads } = require('./agent-core.cjs');
const { PROGRESS_FILENAME, UNAVAILABLE_PAGE_ROOT } = require('../../infrastructure/control-plane-runtime.cjs');
const { SuiteAddressFile, suiteAddressDir } = require('../../shared/suite-address.cjs');
const { bodyReader, respond, serveOnSocket } = require('../lib/agent-server.cjs');
const { BUILD_TIMINGS_FILENAME, expectedBuildSeconds, readBuildTimings } = require('../lib/app-build-timings.cjs');
const { checkExpectation, restoreExpectation, runningExpectation } = require('./expectations.cjs');
const { ProgressPublisher, advanceTimeline, closeTimeline, progressFor, stageSentence } = require('./progress.cjs');
const { BackupSystemAdapter } = require('./system-adapter.cjs');
const { BackupScheduler } = require('./scheduler.cjs');
const { PrimaryDestination } = require('./primary.cjs');
const { BucketCatalog, DestinationResolver, parseObjectLocator } = require('./destinations.cjs');
const { isObjectDestinationId, normalizeObjectDestination, ObjectDestinationRegistry, publicObjectDestination } = require('./object-destinations.cjs');
const { createEngine, ENGINE_MISSING_MESSAGE, ENGINE_NAME, repositoryUsage } = require('./engines/engine.cjs');
const { fingerprint: recoveryKeyFingerprint, normalize: normalizeRecoveryKey } = require('./recovery-key.cjs');
const { GuestKeyStore } = require('./guest-keys.cjs');
const { recoveryKitFilename, recoveryKitText } = require('./recovery-kit.cjs');
const { RecoveryKeyStore } = require('../lib/recovery-key-store.cjs');
const { rotateRecoveryKey: rotateKey } = require('./key-rotation.cjs');
const { LastBackups } = require('./last-backups.cjs');
const { CarryOver } = require('./carry-over.cjs');
const { machineHasVault, readVaultDescriptor, vaultAsksForPassword } = require('../../shared/vault-contract.cjs');
const { VaultAgentClient } = require('../../suite-manager/backend/src/settings/vault-agent-client.cjs');
const { AppAgentClient } = require('../../suite-manager/backend/src/apps/app-agent-client.cjs');
const { AppPackageService } = require('../../suite-manager/backend/src/apps/app-package-service.cjs');
const { HomepageAgentClient } = require('../../suite-manager/backend/src/homepage/homepage-agent-client.cjs');
const { HomepageService } = require('../../suite-manager/backend/src/homepage/homepage-service.cjs');
const { BACKUPS_DIR, STORAGE_MOUNT_ROOT, STORAGE_REGISTRY_FILENAME } = require('../../shared/storage-contract.cjs');
const { collectPackageFiles, verifySnapshotIdentity } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
const { SuiteManagerStore } = require('../../suite-manager/backend/src/state/suite-manager-store.cjs');
const { UpdateAgentClient } = require('../../suite-manager/backend/src/updates/update-agent-client.cjs');

const socketPath = process.env.MOS_BACKUP_AGENT_SOCKET || '/run/mos-backup-agent/agent.sock';
const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
const stateDir = process.env.MOS_STATE_DIR || path.join(stateRoot, 'suite-manager');
const repoDir = process.env.MOS_REPO_DIR || path.resolve(__dirname, '..', '..');
const agentStateDir = process.env.MOS_BACKUP_AGENT_STATE_DIR || path.join(stateRoot, 'backup-agent');
const jobsDir = path.join(agentStateDir, 'jobs');
const currentJobPath = path.join(agentStateDir, 'current-job.json');
const installIdPath = path.join(agentStateDir, 'install-id');
// Read for the manifest and for the address apps are rebuilt on; written only to
// offer a domain a restore carried.
const suiteAddress = new SuiteAddressFile({ dir: suiteAddressDir(stateRoot) });
// Where Caddy serves the busy page from: the one place an owner can still read
// while Suite Manager is down, so the progress file goes there too.
const statusDir = process.env.MOS_STATUS_DIR || UNAVAILABLE_PAGE_ROOT;
const buildTimingsPath = path.join(stateRoot, BUILD_TIMINGS_FILENAME);
const DRIVE_ID_PATTERN = /^[A-Za-z0-9-]{4,64}$/u;
const ERASING_PATTERN = /^archive-[0-9a-f]{8}\.erasing-\d+$/u;
const STORAGE_UNREACHABLE_REASON = 'MOS could not read your storage right now.';

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function directoryNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
const readBody = bodyReader(128 * 1024);

// The drives as the storage module sees them now, or null when it cannot be asked.
async function storageDrives() {
  try {
    return (await appAgent.storageInventory())?.drives || [];
  } catch {
    return null;
  }
}

// The drives this agent knows from its own record when the storage module cannot
// be asked: a state the screen and the schedule show, not an empty list.
function unreachableDrivePlaces() {
  const chosen = primary.read();
  return Object.keys(lastBackups.read()).filter((id) => DRIVE_ID_PATTERN.test(id)).map((id) => ({
    availableBytes: null,
    holdsAppFiles: false,
    id,
    kind: 'disk',
    label: chosen?.destinationId === id && chosen.label ? chosen.label : id,
    reason: STORAGE_UNREACHABLE_REASON,
    sizeBytes: null,
    state: 'unreachable',
    storageKind: null,
    transport: null,
  }));
}

// Whose an archive is, said outright so the screen never works it out again. An
// archive this server's key opens is this server's, whoever made it.
async function describeArchive(archive, placeLabel, health) {
  const { keyState, reason = null, usage = null } = health || await archive.health();
  if (!keyState || keyState === 'empty') return null;
  const points = keyState === 'locked' && archive.kind === 'object' ? [] : await archive.points.summaries().catch(() => []);
  const newest = points.slice().sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
  const described = archive.kind === 'disk'
    ? { hostname: archive.descriptor()?.createdByHostname, installId: archive.descriptor()?.createdByInstallId }
    : { hostname: archive.entry?.hostname, installId: archive.entry?.installId };
  const writtenBy = described.installId || described.hostname
    ? { hostname: described.hostname || null, installId: described.installId || null }
    : newest ? { hostname: newest.sourceHostname || null, installId: newest.sourceInstallId || null } : null;
  const stored = archive.kind === 'disk' ? repositoryUsage(archive.root) : usage;
  return {
    id: archive.id,
    keyState,
    newestAt: newest?.createdAt || null,
    owner: keyState === 'own' ? 'this' : 'other',
    placeId: archive.placeId,
    placeKind: archive.kind,
    placeLabel,
    reason: keyState === 'locked' ? reason : null,
    restorePoints: keyState === 'locked' ? null : stored?.restorePoints ?? points.length,
    storedBytes: stored?.storedBytes ?? null,
    writtenBy,
  };
}

// Every place a backup can go and every archive MOS can see in them, drives and
// storage online alike: nothing has to be chosen for backups before it is looked
// in. A drive's state and reason are the storage module's own words.
async function survey() {
  const drives = await carryOver.onSight(await storageDrives());
  const places = drives ? [] : unreachableDrivePlaces();
  const archives = [];
  for (const drive of drives || []) {
    if (!drive.connected || !drive.holdsBackupsFormat) continue;
    const label = drive.name || drive.label;
    if (drive.mountPath) {
      for (const archive of await destinationResolver.archivesIn(drive.id)) {
        const described = await describeArchive(archive, label);
        if (described) archives.push(described);
      }
    }
    const open = drive.state === 'ready' && Boolean(drive.mountPath);
    places.push({
      availableBytes: drive.availableBytes ?? null,
      holdsAppFiles: (drive.apps || []).length > 0,
      id: drive.id,
      kind: 'disk',
      label,
      reason: open ? null : drive.reason || 'MOS has not opened this drive yet. Unplug it and plug it back in.',
      sizeBytes: drive.sizeBytes ?? null,
      state: open ? 'ready' : drive.state,
      storageKind: drive.transport === 'usb' || drive.removable ? 'external' : 'local',
      transport: drive.transport || null,
    });
  }
  for (const record of destinationResolver.bucketRecords()) {
    let reason = null;
    try {
      for (const archive of await destinationResolver.archivesIn(record.id)) {
        const health = await archive.health().catch(() => ({ keyState: null }));
        const described = await describeArchive(archive, record.label, health);
        if (described) archives.push(described);
      }
      reason = destinationResolver.catalogProblem(record.id);
    } catch (error) {
      reason = error?.message || 'MOS could not reach this storage.';
    }
    places.push({
      ...publicObjectDestination(record),
      availableBytes: null,
      kind: 'object',
      reason,
      sizeBytes: null,
      state: reason ? 'unreachable' : 'ready',
      storageKind: 'object',
    });
  }
  for (const place of places) {
    const own = archives.filter((archive) => archive.placeId === place.id && archive.owner === 'this')
      .sort((left, right) => String(right.newestAt || '').localeCompare(String(left.newestAt || '')))[0] || null;
    place.ownArchive = own ? { id: own.id, restorePoints: own.restorePoints, storedBytes: own.storedBytes } : null;
    if (own?.newestAt) lastBackups.note(place.id, own.newestAt);
    place.lastBackupAt = own?.newestAt || lastBackups.of(place.id);
  }
  return { archives, places };
}

// What a bucket holds before it is connected: nothing yet, MOS backups beside
// which this server's go, or no answer and the provider's words for why.
async function testObjectDestination(input) {
  const record = normalizeObjectDestination(input, input.id ? objectRegistry.get(String(input.id)) : null);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-bucket-test-'));
  try {
    const archives = await new BucketCatalog({ agentStateDir: scratch, engine, record }).archives({ wait: true });
    if (!archives.length) return { message: 'Connected. This bucket holds no MOS backups yet; the first backup to it creates them.', ok: true, archives: 0 };
    return {
      archives: archives.length,
      message: `Connected. This bucket already holds MOS backups${archives.length > 1 ? ` from ${archives.length} servers` : ''}, which Backups lists once it is connected.`,
      ok: true,
    };
  } catch (error) {
    return { message: error?.message || 'MOS could not reach this storage.', ok: false };
  } finally {
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}

// Anything that backs up without being asked names this instead of a place.
const PRIMARY_DESTINATION = 'primary';
async function primaryDestination() {
  const chosen = primary.read();
  if (!chosen) {
    throw Object.assign(new Error('No destination is set for automatic backups, so there is nowhere to write this backup.'), { code: 'NO_PRIMARY_DESTINATION' });
  }
  const destination = primary.resolve((await survey()).places);
  const absentCode = isObjectDestinationId(chosen.destinationId) ? 'DESTINATION_UNREACHABLE' : 'DESTINATION_ABSENT';
  if (!destination) throw Object.assign(new Error('The destination automatic backups are written to is not available right now.'), { code: absentCode });
  if (destination.reason) throw Object.assign(new Error(destination.reason), { code: absentCode });
  return destination;
}
// A place is a connected bucket or a drive's filesystem UUID; whether a backup
// can go there right now is the survey's to say.
function normalizeDestinationId(candidate) {
  const value = String(candidate || '');
  if (isObjectDestinationId(value)) return objectRegistry.get(value) ? value : null;
  return DRIVE_ID_PATTERN.test(value) ? value : null;
}
async function knownPlace(candidate) {
  const id = normalizeDestinationId(candidate);
  const place = id ? (await survey()).places.find((entry) => entry.id === id) : null;
  if (!place) throw new Error('That drive or storage is not connected. Choose another place.');
  return place;
}
async function knownArchive(candidate) {
  const archive = (await survey()).archives.find((entry) => entry.id === String(candidate || ''));
  if (!archive) throw new Error('Those backups are not connected right now. Plug in the drive or check the connection, then try again.');
  return archive;
}
function listJobFiles() {
  ensureDir(jobsDir);
  return fs.readdirSync(jobsDir).filter((name) => name.endsWith('.json')).map((name) => path.join(jobsDir, name));
}
function readCurrentJob() { try { return fs.existsSync(currentJobPath) ? readJson(currentJobPath) : null; } catch { return null; } }
function commandLineOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return '';
  }
}
function workerAlive(jobFile) {
  return directoryNames('/proc').some((entry) => {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) return false;
    const cmdline = commandLineOf(entry);
    return cmdline.includes('--worker') && cmdline.includes(jobFile);
  });
}
// A worker is a detached process, so a power loss can leave current-job.json
// claiming an active job forever; the grace period covers the worker's exec.
function reconcileCurrentJob() {
  const job = readCurrentJob();
  if (!isActive(job)) return job;
  const startedMs = new Date(job.createdAt || 0).getTime();
  if (Date.now() - startedMs < 15_000) return job;
  if (workerAlive(jobPath(job.id))) return job;
  // A killed worker ran no cleanup: whatever it wrote is referenced by nothing.
  if (job.kind === 'backup') core.noteUncollectedData(job.destinationId);
  return updateJob(jobPath(job.id), (entry) => {
    entry.error = `The ${entry.kind || 'backup'} stopped during "${entry.stage || 'an unknown step'}" because the backup worker is no longer running (for example after a power loss or restart).`;
    entry.stage = 'failed';
    entry.status = 'failed';
  });
}
function latestJob() {
  return listJobFiles().map((file) => { try { const job = readJson(file); return { job, time: new Date(job.updatedAt || job.createdAt || 0).getTime() }; } catch { return null; } })
    .filter(Boolean).sort((left, right) => right.time - left.time)[0]?.job || null;
}
// The last handful of jobs, newest first, with only what a sentence about each needs.
function recentJobs(limit = 6) {
  return listJobFiles().map((file) => { try { return readJson(file); } catch { return null; } })
    .filter(Boolean)
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime())
    .slice(0, limit)
    .map((job) => ({
      destinationId: job.destinationId || null,
      error: job.error || null,
      id: job.id,
      initiator: job.initiator || null,
      kind: job.kind || null,
      note: job.note || null,
      sentence: isActive(job) ? job.progress?.sentence || stageSentence(job.stage) : null,
      stage: job.stage || null,
      status: job.status || null,
      step: isActive(job) ? job.progress?.step ?? null : null,
      steps: isActive(job) ? job.progress?.steps ?? null : null,
      updatedAt: job.updatedAt || job.createdAt || null,
      updateTarget: job.updateTarget || null,
    }));
}
// Every finished job with a timeline, which is what this machine's estimates are
// read off; a failed job says nothing about how long one takes.
function jobHistory() {
  return listJobFiles().map((file) => { try { return readJson(file); } catch { return null; } })
    .filter((job) => job && job.status === 'succeeded' && Array.isArray(job.timeline));
}
// The name an app is shown under, from the catalog package in this checkout.
const displayNames = new Map();
function displayNameOf(packageId) {
  const id = String(packageId || '');
  if (!id) return null;
  if (displayNames.has(id)) return displayNames.get(id);
  let name = id;
  try {
    const appsDir = path.join(repoDir, 'apps');
    const manifestPath = path.join(appsDir, id, 'manifest.json');
    if (path.resolve(manifestPath).startsWith(`${path.resolve(appsDir)}${path.sep}`)) {
      const manifest = readJson(manifestPath);
      if (typeof manifest.name === 'string' && manifest.name.trim()) name = manifest.name.trim();
    }
  } catch { /* not a package in this checkout: named by its id */ }
  displayNames.set(id, name);
  return name;
}
function appsWithNames(apps) {
  return (apps || []).map((app) => ({ displayName: displayNameOf(app.packageId), packageId: app.packageId }));
}
function expectationInputs({ apps, sizeBytes }) {
  return { apps: appsWithNames(apps), buildTimings: readBuildTimings(buildTimingsPath), cpus: os.cpus().length, history: jobHistory(), sizeBytes: sizeBytes ?? null };
}
function summarizeJob(job) {
  if (!job) return null;
  return { address: job.address && typeof job.address === 'object' ? job.address : null, backupPath: job.backupPath || null, appsNotStarted: Array.isArray(job.appsNotStarted) ? job.appsNotStarted : [], controlPlane: job.controlPlane || null, destinationId: job.destinationId || null, error: job.error || null, id: job.id, kind: job.kind || null, logs: Array.isArray(job.logs) ? job.logs.slice(-20) : [], outputPath: job.outputPath || null, progress: job.progress || null, rescuePath: job.rescuePath || null, stage: job.stage || null, status: job.status || null, summary: job.summary || null, updatedAt: job.updatedAt || null, validation: job.validation || null, verification: job.verification || null };
}
function isActive(job) { return job && (job.status === 'queued' || job.status === 'running'); }
function jobPath(id) { return path.join(jobsDir, `${id}.json`); }
// Refused before anything is written when it could not run: the code on a busy
// refusal lets the checkpoint before an update wait rather than report.
function createJob(kind, payload) {
  engine.assertInstalled();
  if (isActive(reconcileCurrentJob())) throw Object.assign(new Error('A backup or restore job is already running.'), { code: 'JOB_ACTIVE' });
  const interrupted = core.interruptedRestore();
  // Validation never touches the running suite, so it stays available while an
  // interrupted restore blocks destructive work.
  if (interrupted && kind !== 'validate') throw new Error(`A restore did not complete (stopped during "${interrupted.phase}"). Acknowledge it before starting new backup or restore work; the pre-restore rescue copy is at ${interrupted.rescuePath || 'the backup agent state directory'}.`);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const destinationId = kind === 'backup' ? normalizeDestinationId(payload.destinationId) : null;
  const backupPath = kind === 'restore' || kind === 'validate' || kind === 'delete' ? normalizeBackupLocator(payload.backupPath) : null;
  const note = kind === 'backup' ? String(payload.note || '').trim().slice(0, 500) : '';
  if (kind === 'backup' && !destinationId) throw new Error('Choose a connected drive or a storage connection to back up to.');
  if ((kind === 'restore' || kind === 'validate' || kind === 'delete') && !backupPath) throw new Error('Choose a detected backup from a connected destination.');
  if (kind === 'restore' && payload.confirmation !== 'RESTORE') throw new Error('Type RESTORE to confirm this destructive restore.');
  const initiator = payload.initiator === 'schedule' || payload.initiator === 'update' ? payload.initiator : 'owner';
  const updateTarget = kind === 'backup' && initiator === 'update' ? String(payload.updateTarget || '').trim().slice(0, 60) : '';
  const job = { backupPath, createdAt: now, destinationId, error: null, id, initiator, kind, logs: [], outputPath: null, rescuePath: null, stage: 'queued', status: 'queued', updatedAt: now, ...(note ? { note } : {}), ...(updateTarget ? { updateTarget } : {}) };
  writeJson(jobPath(id), job);
  writeJson(currentJobPath, job);
  spawn(process.execPath, [__filename, '--worker', jobPath(id)], { cwd: repoDir, detached: true, env: process.env, stdio: 'ignore' }).unref();
  return job;
}
// A locator names one restore point: a manifest file under the storage mount
// root, or a storage connection and a point id. It must resolve to something this
// machine has. Still called backupPath on the wire and in job records.
function normalizeBackupLocator(candidate) {
  const value = String(candidate || '');
  const object = parseObjectLocator(value);
  if (object) return objectRegistry.get(object.placeId) ? value : null;
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${STORAGE_MOUNT_ROOT}${path.sep}`) || !isRestorePointPath(resolved)) return null;
  return fs.existsSync(resolved) && fs.existsSync(`${resolved}.sha256`) ? resolved : null;
}
// Restore points of every archive MOS can open; a locked archive lists none.
async function listBackups(archives) {
  const backups = [];
  const history = jobHistory();
  const buildTimings = readBuildTimings(buildTimingsPath);
  const cpus = os.cpus().length;
  for (const entry of archives) {
    if (entry.keyState === 'locked') continue;
    let archive;
    try {
      archive = destinationResolver.resolve(entry.id);
    } catch {
      continue;
    }
    const descriptor = archive.kind === 'disk' ? archive.descriptor() : null;
    let points = [];
    try {
      points = await archive.points.summaries();
    } catch { /* an archive that will not answer hides nothing else */ }
    for (const point of points) {
      backups.push({
        ...point,
        archiveId: entry.id,
        encrypted: true,
        engineName: point.engineName || descriptor?.engineName || ENGINE_NAME,
        expect: {
          check: checkExpectation({ history, sizeBytes: point.sizeBytes }),
          restore: restoreExpectation({ apps: appsWithNames(point.apps), buildTimings, cpus, history, sizeBytes: point.sizeBytes }),
        },
        owner: entry.owner,
        path: point.locator,
        placeId: entry.placeId,
        placeLabel: entry.placeLabel,
        repositoryId: descriptor?.repositoryId || null,
      });
    }
  }
  return backups.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
}
// Every change to a job goes through here, so the progress record and the public
// file the busy page polls always say what the job record says.
function updateJob(file, mutator, { count } = {}) {
  const job = readJson(file);
  mutator(job);
  const now = new Date().toISOString();
  job.updatedAt = now;
  refreshProgress(job, now, count);
  writeJson(file, job);
  writeJson(currentJobPath, job);
  if (isActive(job)) progressPublisher.publish(job.progress);
  else progressPublisher.clear();
  return job;
}
function refreshProgress(job, now, count) {
  if (!isActive(job)) {
    closeTimeline(job, now);
    return;
  }
  // Kept once known, a null too, so a kind with no expectation is not re-read per log line.
  if (job.expect === undefined && job.subject) {
    try { job.expect = runningExpectation(job.kind, expectationInputs(job.subject)) || null; } catch { job.expect = null; }
  }
  const next = progressFor(job, { count: count ?? null, now });
  // A count belongs to the stage it was reported in.
  if (count === undefined && job.progress?.stage === job.stage && job.progress.count) next.count = job.progress.count;
  job.progress = next;
}
function log(file, message) { updateJob(file, (job) => { job.logs.push({ at: new Date().toISOString(), message }); }); }
function stage(file, name) {
  updateJob(file, (job) => { advanceTimeline(job, name); job.stage = name; job.substage = null; job.status = 'running'; }, { count: null });
  log(file, name);
}
// Not a stage: it opens no timeline entry, since estimates are read off whole stages.
function substage(file, name) {
  updateJob(file, (job) => { job.substage = name; });
  log(file, name);
}
// Which item of how many the stage is on; the host adds the app's name and usual cost.
function progress(file, count) {
  const displayName = count.displayName || displayNameOf(count.packageId);
  updateJob(file, () => {}, {
    count: {
      current: displayName,
      done: count.done,
      expectSeconds: count.unit === 'apps' ? expectedBuildSeconds(readBuildTimings(buildTimingsPath), count.packageId) : null,
      total: count.total,
      unit: count.unit,
    },
  });
}
function packageBackupInventory() {
  const store = new SuiteManagerStore(stateDir);
  try {
    return store.getAppInstances().map((instance) => {
      readAppPackageManifest(instance.snapshotPath);
      const manifest = verifySnapshotIdentity(instance.snapshotPath, { errorMessage: `Installed package snapshot is invalid for ${instance.packageId}.`, expectedDigest: instance.packageDigest, packageId: instance.packageId });
      const expected = path.join(stateRoot, 'app-packages', instance.id, 'installed');
      if (path.resolve(instance.snapshotPath) !== path.resolve(expected)) throw new Error(`Installed package snapshot path is invalid for ${instance.packageId}.`);
      return {
        instanceId: instance.id,
        manifestDigest: instance.manifestDigest,
        packageDigest: instance.packageDigest,
        packageId: instance.packageId,
        packageVersion: instance.packageVersion,
        payload: collectPackageFiles(instance.snapshotPath, { manifest }).map((file) => ({ bytes: file.size, path: file.relativePath, sha256: sha256(file.absolutePath) })),
        source: { kind: instance.sourceKind, path: instance.sourcePath, repository: instance.sourceRepository, revision: instance.sourceRevision, trust: instance.sourceTrust },
      };
    });
  } finally {
    store.close();
  }
}
function installedAppInstances() {
  const store = new SuiteManagerStore(stateDir);
  try {
    return store.getAppInstances().map((instance) => ({ enabled: instance.enabled, instanceId: instance.id, packageId: instance.packageId }));
  } finally {
    store.close();
  }
}
// The address apps are rebuilt on during a restore: this machine's recorded
// address, whatever the backup was written on.
function restoreBaseUrl() {
  const address = suiteAddress.read();
  return { homeHost: address.host, scheme: address.scheme };
}
function recordedDomain() {
  const address = suiteAddress.readOrNull();
  return address?.kind === 'domain' ? address : null;
}
// Generated on this machine's first start and kept beside the engine key where
// nothing backs it up: the one fact a restore point carries that says which machine wrote it.
function installId() {
  try {
    const existing = fs.readFileSync(installIdPath, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first start: no id yet */ }
  const id = crypto.randomUUID();
  ensureDir(agentStateDir);
  fs.writeFileSync(installIdPath, `${id}\n`, 'utf8');
  return id;
}
// Who this machine is. A restore never touches the address: the name a backup
// carried becomes an offer in Settings, and serving it is the domain module's job.
const identity = {
  acmeEmail: () => recordedDomain()?.acmeEmail || null,
  // A takeover restore makes the other machine's key this machine's own, disk
  // first: a rekey that fails abandons the whole adoption, and the archive stays
  // readable with the borrowed key, which the screen already explains.
  assumeArchiveKey: async (archiveId) => {
    const key = guestKeys.keyFor(archiveId);
    if (!key) return false;

    try {
      const rekeyed = await vaultAgent.rekey(key);
      if (!rekeyed.ok) return { ok: false, reason: rekeyed.reason || 'rekey-failed' };
    } catch (error) {
      return { ok: false, reason: error?.code === 'VAULT_AGENT_UNAVAILABLE' ? 'vault-agent-unavailable' : 'rekey-failed' };
    }

    engine.adoptRecoveryKey(key);
    keyStore.adopt(recoveryKeyFingerprint(key));
    guestKeys.forget(archiveId);
    destinationResolver.forgetAll();
    // The archive is this server's now; with nowhere chosen for automatic backups
    // yet, they go on where the suite came from.
    if (!primary.read()) {
      const place = (await survey()).places.find((entry) => entry.id === destinationResolver.resolve(archiveId).placeId);
      if (place) primary.save({ destinationId: place.id, label: place.label });
    }
    return true;
  },
  domain: () => recordedDomain()?.baseDomain || null,
  hostname: () => os.hostname(),
  installId,
  offerAddress: async ({ acmeEmail = null, baseDomain }) => suiteAddress.writeOffer({ acmeEmail, baseDomain, from: 'restore' }),
};
function restoreRequestContext(packageId) {
  const { homeHost, scheme } = restoreBaseUrl();
  const baseHost = homeHost.startsWith('home.') ? homeHost.slice(5) : homeHost;
  const appHost = `${packageId}.${baseHost}`;
  return {
    appHost,
    baseHost,
    publicUrl: `${scheme}://${appHost}/`,
    publicUrlFor: (nextPackageId) => restoreRequestContext(nextPackageId),
    scheme,
  };
}
// Homepage's services projection and its Caddy routes, re-rendered from the
// restored config on this machine's address.
async function rebuildRestoredHomepage(logMessage) {
  const store = new SuiteManagerStore(stateDir);
  try {
    const appPackages = new AppPackageService({ agent: new AppAgentClient(), appsDir: path.join(repoDir, 'apps'), store });
    const homepageService = new HomepageService({ agent: new HomepageAgentClient(), store, suiteAddress });
    const result = await appPackages.reconcileHomepageUrls(homepageService, { publicUrlFor: (packageId) => restoreRequestContext(packageId) });
    if (result.homepage?.status === 'failed') throw new Error(result.homepage.errorCode || 'HOMEPAGE_PUBLIC_URL_RECONCILE_FAILED');
    logMessage('Homepage re-rendered on this machine\'s address');
  } finally {
    store.close();
  }
}
// One app that will not start is reported and the rest carry on: its data is
// restored either way, and its own page records why and can try again.
async function reconcileRestoredApps(logMessage, onProgress = () => {}) {
  const store = new SuiteManagerStore(stateDir);
  const notStarted = [];
  try {
    const appPackages = new AppPackageService({
      agent: new AppAgentClient(),
      appsDir: path.join(repoDir, 'apps'),
      store,
    });
    const instances = store.getAppInstances().filter((instance) => instance.status === 'installed' && instance.enabled);
    if (!instances.length) logMessage('No installed app runtimes to restore');
    for (const [index, instance] of instances.entries()) {
      const displayName = instance.displayNameSnapshot || displayNameOf(instance.packageId);
      onProgress({ displayName, done: index, packageId: instance.packageId, total: instances.length, unit: 'apps' });
      logMessage(`Restoring ${displayName}`);
      try {
        await appPackages.enablePackage(instance.packageId, restoreRequestContext(instance.packageId));
      } catch (error) {
        logMessage(`${displayName} did not start: ${error.message}`);
        notStarted.push({ displayName, packageId: instance.packageId });
      }
    }
    return notStarted;
  } finally {
    store.close();
  }
}

const RECOVERY_KEY_UNACKNOWLEDGED = 'Save your recovery key first. It is the only thing that can open these backups on a replacement server, and MOS shows it once before the first backup.';
// Only what would create a backup is gated: a replacement machine in the middle
// of recovering must not be blocked by a dialog about its own future backups.
const RECOVERY_KEY_GATED_ROUTES = Object.freeze(['/v1/backups', '/v1/schedule']);

// Enforced here as well as by the screen, so a page left open from before the
// key existed cannot get past it.
function assertRecoveryKeyAcknowledged(pathname, body = {}) {
  if (!RECOVERY_KEY_GATED_ROUTES.includes(pathname) || keyStore.acknowledged()) return;
  if (pathname === '/v1/schedule' && body.enabled !== true) return;
  throw Object.assign(new Error(RECOVERY_KEY_UNACKNOWLEDGED), { code: 'RECOVERY_KEY_UNACKNOWLEDGED' });
}

function recoveryKeyStatus() {
  const record = keyStore.readRecord();
  return {
    acknowledged: Boolean(record.acknowledgedAt),
    acknowledgedAt: record.acknowledgedAt,
    // Set when this key was typed off another server's kit rather than made here.
    adoptedAt: record.adoptedAt,
    // From the key itself, so the screen shows what this machine holds before it is acknowledged.
    fingerprint: recoveryKeyFingerprint(engine.recoveryKey()),
    keyFile: engine.keyFile,
  };
}

// The address the kit tells an owner to come back to.
function homeAddress() {
  try {
    const { homeHost, scheme } = restoreBaseUrl();
    return `${scheme}://${homeHost}/`;
  } catch {
    return null;
  }
}

// Composed out of what a provider's console cannot tell an owner afterwards,
// never out of the credentials it holds for them.
async function recoveryKit(key) {
  const { archives, places } = await survey();
  const chosen = primary.read()?.destinationId;
  const holding = places.filter((place) => place.id === chosen || archives.some((archive) => archive.placeId === place.id && archive.owner === 'this'));
  const destinations = holding.map((place) => (place.kind === 'disk'
    ? { kind: 'drive', label: place.label }
    : { bucket: place.bucket, endpoint: place.endpoint, folder: place.folder || '', kind: 'bucket', label: place.label, region: place.region || '' }));
  const hostname = os.hostname();
  const now = new Date();
  return {
    // The vault descriptor is read rather than the vault agent asked: one more
    // socket that can be down is one more way for a printed sheet to come out wrong.
    kit: recoveryKitText({
      asksForPassword: vaultAsksForPassword(readVaultDescriptor()),
      destinations,
      encryptedDisk: machineHasVault(),
      homeAddress: homeAddress(),
      hostname,
      key,
      now,
    }),
    kitFilename: recoveryKitFilename({ hostname, now }),
  };
}

async function revealRecoveryKey() {
  const key = engine.recoveryKey();
  return { key, recoveryKey: recoveryKeyStatus(), ...await recoveryKit(key) };
}

// What a rotation can reach right now: this server's own archives on connected
// drives and buckets. A drive in a drawer is the reason a rotation reports what
// it could not finish; other servers' archives are never rekeyed.
async function attachedDestinations() {
  return (await survey()).archives.filter((archive) => archive.owner === 'this').map((archive) => destinationResolver.resolve(archive.id));
}

// The disk half goes first, over the same vault socket a takeover uses, so a
// vault that will not follow stops the whole thing before anything moves.
async function rotateRecoveryKey() {
  const rotated = await rotateKey({
    attached: attachedDestinations,
    destinations: destinationResolver,
    engine,
    record: keyStore,
    rekeyDisk: async (nextKey) => {
      try {
        const result = await vaultAgent.rekey(nextKey);
        return result.ok === false ? { ok: false, reason: result.reason || 'rekey-failed' } : { ok: true };
      } catch (error) {
        return { ok: false, reason: error?.code === 'VAULT_AGENT_UNAVAILABLE' ? 'vault-agent-unavailable' : 'rekey-failed' };
      }
    },
  });
  if (!rotated.ok) return rotated;
  return { ...rotated, recoveryKey: recoveryKeyStatus(), ...await recoveryKit(rotated.key) };
}

// Opening backups another server wrote without changing them: the entered key is
// checked against the archive and kept here, against that archive. Becoming that
// server is a separate act, at restore.
async function unlockArchive(body) {
  const normalized = normalizeRecoveryKey(body.recoveryKey);
  if (normalized.error) throw Object.assign(new Error(normalized.error), { code: 'RECOVERY_KEY_MISTYPED' });
  const listed = await knownArchive(body.archiveId);
  if (listed.owner === 'this') throw new Error('These are this server\'s own backups; its own recovery key already opens them.');
  const archive = destinationResolver.resolve(listed.id);
  const probe = await engine.probeRepository({ ...archive.repositorySpec(), noun: archive.noun, password: normalized.key });
  if (probe.state === 'locked') throw new Error(`That key does not open these backups on this ${archive.noun}.`);
  if (probe.state === 'absent') throw new Error(`There are no MOS backups here to unlock.`);
  if (probe.state !== 'open') throw new Error(probe.message || `MOS could not reach this ${archive.noun}.`);
  guestKeys.save(listed.id, normalized.key);
  destinationResolver.forget(listed.id);
  return {
    message: `Unlocked. MOS keeps this key to open these backups and changed nothing in them.`,
    recoveryKey: recoveryKeyStatus(),
  };
}

// Which keys open an archive, and taking one back out. Both need a key that
// already opens it, which is also what stops this being a way to lock someone out.
async function archiveKeys(body) {
  const { archive, key, repository } = await openWithEnteredKey(body);
  const entries = engine.keyList({ password: key, repository });
  return {
    keys: entries.map((entry) => ({
      createdAt: entry.created || null,
      current: entry.current === true,
      hostname: entry.hostName || null,
      id: entry.id,
      username: entry.userName || null,
    })),
    noun: archive.noun,
  };
}

async function removeArchiveKey(body) {
  const keyId = String(body.keyId || '').trim();
  if (!keyId) throw new Error('Choose which key to remove.');
  const { key, repository } = await openWithEnteredKey(body);
  const entries = engine.keyList({ password: key, repository });
  const target = entries.find((entry) => entry.id === keyId);
  if (!target) throw new Error('That key is not on this archive anymore.');
  // So this cannot end in an archive nobody opens: the removing key stays, and the last one stays.
  if (target.current === true) throw new Error('That is the key you entered, so it cannot remove itself. Enter another key that opens this archive to remove this one.');
  if (entries.length < 2) throw new Error('This is the only key that opens these backups, so removing it would make them unreadable.');
  engine.keyRemove({ keyId, password: key, repository });
  return { removed: keyId };
}

async function openWithEnteredKey(body) {
  const normalized = normalizeRecoveryKey(body.recoveryKey);
  if (normalized.error) throw Object.assign(new Error(normalized.error), { code: 'RECOVERY_KEY_MISTYPED' });
  const archive = destinationResolver.resolve((await knownArchive(body.archiveId)).id);
  const spec = archive.repositorySpec();
  const probe = await engine.probeRepository({ ...spec, noun: archive.noun, password: normalized.key });
  if (probe.state !== 'open') throw new Error(probe.state === 'locked' ? `That key does not open these backups on this ${archive.noun}.` : probe.message || `MOS could not reach this ${archive.noun}.`);
  return { archive, key: normalized.key, repository: { engineName: engine.name, ...spec, password: undefined } };
}

// A note or a deletion changes an archive, so neither is made in another server's.
async function assertOwnRestorePoint(locator) {
  const { destination } = core.resolveBackup(locator);
  if (destination.guestKey() || (await destination.health()).keyState !== 'own') throw new Error('These backups belong to another server, so MOS does not change them.');
}

// The archive is untouched: the key stops being on this machine.
function forgetGuestKey(body) {
  const archiveId = String(body.archiveId || '');
  const forgotten = guestKeys.forget(archiveId);
  destinationResolver.forget(archiveId);
  return { forgotten };
}

// Erasing one archive another server made, on a drive. The folder is moved aside
// first, so the space is the owner's the moment this answers.
async function eraseOtherServersArchive(body) {
  if (body.confirmation !== 'ERASE') throw new Error('Confirm that these backups are to be erased.');
  const listed = await knownArchive(body.archiveId);
  if (listed.placeKind !== 'disk') throw new Error('MOS erases backups only on a drive. Remove them in the storage provider\'s own console.');
  if (listed.owner === 'this') throw new Error('These are this server\'s own backups. Delete them one restore point at a time in the list of backups.');
  if (isActive(reconcileCurrentJob())) throw new Error('A backup or restore is running. Erase these once it has finished.');
  const archive = destinationResolver.resolve(listed.id);
  const doomed = `${archive.root}.erasing-${Date.now()}`;
  try {
    fs.renameSync(archive.root, doomed);
  } catch (error) {
    if (error.code === 'EROFS') throw new Error('MOS can read this drive but cannot change it until it is checked in Settings → Storage.');
    throw error;
  }
  eraseBehind(doomed);
  guestKeys.forget(listed.id);
  destinationResolver.forget(listed.id);
  return { erased: true };
}

function eraseBehind(doomed) {
  void fs.promises.rm(doomed, { force: true, recursive: true }).catch((error) => process.stderr.write(`[mos-backup-agent] ${doomed} was not fully erased: ${error.message}\n`));
}

// An erase cut off by a crash leaves its folder aside, invisible and holding the
// space; the next start finishes it on every drive mounted then.
function sweepInterruptedErases() {
  for (const driveId of directoryNames(STORAGE_MOUNT_ROOT)) {
    const backups = path.join(STORAGE_MOUNT_ROOT, driveId, BACKUPS_DIR);
    for (const name of directoryNames(backups)) {
      if (ERASING_PATTERN.test(name)) eraseBehind(path.join(backups, name));
    }
  }
}

// What retention needs about a destination's restore points, asked of the
// destination so it does not depend on which drives happen to be mounted.
async function scheduledRestorePoints(destinationId) {
  const points = await (await destinationResolver.target(destinationId)).points.summaries();
  return points.map((point) => ({ automatic: point.automatic, createdAt: point.createdAt, initiator: point.initiator, path: point.locator }));
}

const keyStore = new RecoveryKeyStore({ stateDir: agentStateDir });
const lastBackups = new LastBackups({ agentStateDir });
const appAgent = new AppAgentClient();
const progressPublisher = new ProgressPublisher({ dir: statusDir, filename: PROGRESS_FILENAME });
const engine = createEngine({ agentStateDir, keys: keyStore, onKeyUsed: () => keyStore.noteFirstUse() });
const objectRegistry = new ObjectDestinationRegistry({ registryPath: path.join(stateRoot, STORAGE_REGISTRY_FILENAME) });
const backupSystem = new BackupSystemAdapter({ agentStateDir, repoDir, stateDir, stateRoot });
const guestKeys = new GuestKeyStore({ agentStateDir });
// Only ever asked to rekey the disk at the end of a takeover restore.
const vaultAgent = new VaultAgentClient({ socketPath: process.env.MOS_VAULT_AGENT_SOCKET || '/run/mos-vault-agent/agent.sock' });
// Every archive this server creates says which machine made it, readable without its key.
const destinationResolver = new DestinationResolver({ agentStateDir, createdBy: () => ({ hostname: os.hostname(), installId: installId() }), engine, guestKeys, objectRegistry, system: backupSystem });
const updateAgent = new UpdateAgentClient();

// An update restarts this agent partway through, so a backup started underneath
// one would be cut off; an update agent that does not answer is not an update.
async function updateInProgress() {
  try {
    const summary = await updateAgent.summary();
    return isActive(summary?.currentJob);
  } catch {
    return false;
  }
}

const primary = new PrimaryDestination({ agentStateDir });
const logLine = (message) => process.stdout.write(`[mos-backup-agent] ${message}\n`);
// What a server updated from MOS 0.22 left behind, made today's on sight.
const carryOver = new CarryOver({ agentStateDir, lastBackups, log: logLine, primary, registryPath: path.join(stateRoot, STORAGE_REGISTRY_FILENAME) });

const scheduler = new BackupScheduler({
  agentStateDir,
  createJob: (kind, payload) => createJob(kind, payload),
  places: async () => (await survey()).places,
  log: logLine,
  primary,
  // Reconciled first, so a worker killed by a power loss does not keep the
  // scheduler waiting until somebody opens the Backups screen.
  readJob: (id) => { reconcileCurrentJob(); try { return readJson(jobPath(id)); } catch { return null; } },
  restorePoints: scheduledRestorePoints,
  updateInProgress,
});

const core = new BackupAgentCore({
  apps: { installedInstances: installedAppInstances, reconcile: reconcileRestoredApps },
  destinations: destinationResolver,
  engine,
  homepage: { rebuild: rebuildRestoredHomepage },
  identity,
  jobs: { log, progress, stage, substage, update: updateJob },
  packages: { inventory: packageBackupInventory, validatePayloads: validatePackagePayloads },
  paths: { agentStateDir, stateDir, stateRoot },
  system: backupSystem,
});

if (require.main === module && process.argv[2] === '--worker') {
  (async () => {
    try {
      const file = process.argv[3];
      const job = readJson(file);
      if (job.kind === 'restore') await core.restore(file);
      else if (job.kind === 'validate') await core.validateBackup(file);
      else if (job.kind === 'delete') await core.deleteBackupJob(file);
      else await core.backup(file);
    } catch (error) {
      const file = process.argv[3];
      updateJob(file, (job) => { job.error = error instanceof Error ? error.message : String(error); job.stage = 'failed'; job.status = 'failed'; });
    }
    process.exit(0);
  })();
} else if (require.main === module) {
  ensureDir(agentStateDir);
  ensureDir(jobsDir);
  // The screen has to be able to show an owner their recovery key before a backup exists.
  engine.recoveryKey();
  installId();
  // A worker that died with the machine never cleared the file the busy page reads.
  if (!isActive(reconcileCurrentJob())) progressPublisher.clear();
  sweepInterruptedErases();
  carryOver.atStart();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        const { archives, places } = await survey();
        respond(response, 200, {
          archives,
          backups: await listBackups(archives),
          capabilities: { backups: ['create', 'delete', 'list', 'schedule', 'validate'], places: ['connect-object', 'list', 'primary'], archives: ['erase', 'forget-key', 'keys', 'unlock'], recoveryKey: ['acknowledge', 'reveal', 'rotate'], restores: ['acknowledge-interruption', 'apply', 'list'], storage: { engine: ENGINE_NAME, model: 'archives' } },
          currentJob: summarizeJob(reconcileCurrentJob()),
          // Without the engine binary nothing can be written anywhere; said once here, not per destination.
          engine: { installed: engine.installed(), reason: engine.installed() ? null : ENGINE_MISSING_MESSAGE },
          hostname: os.hostname(),
          interruptedRestore: core.interruptedRestore(),
          lastJob: summarizeJob(latestJob()),
          places,
          recentJobs: recentJobs(),
          // Where everything that backs up on its own writes.
          primaryDestination: primary.state(),
          recoveryKey: recoveryKeyStatus(),
          schedule: scheduler.state(),
          service: 'mos-backup-agent',
        });
        return;
      }
      // The cheap read for the two questions another agent asks often: is a job
      // running, and where do unattended backups go.
      if (request.method === 'GET' && url.pathname === '/v1/summary') {
        respond(response, 200, {
          currentJob: summarizeJob(reconcileCurrentJob()),
          primaryDestination: primary.state(),
          schedule: scheduler.state(),
          service: 'mos-backup-agent',
        });
        return;
      }
      // One job by id: the current job may already be someone else's by the time a caller looks.
      if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
        const id = path.basename(url.pathname);
        reconcileCurrentJob();
        let job = null;
        try { job = readJson(jobPath(id)); } catch { /* no such job: 404 below */ }
        if (!job) { respond(response, 404, { code: 'NOT_FOUND', error: 'Job was not found.' }); return; }
        respond(response, 200, { job: summarizeJob(job) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/primary') {
        const body = await readBody(request);
        if (body.destinationId === null) { respond(response, 200, { primaryDestination: primary.clear() }); return; }
        const known = await knownPlace(body.destinationId);
        respond(response, 200, { primaryDestination: primary.save({ destinationId: known.id, label: known.label }) });
        return;
      }
      // Nothing is written by a test: a repository is created by the first backup, not by connecting.
      if (request.method === 'POST' && url.pathname === '/v1/destinations/object/test') {
        respond(response, 200, { result: await testObjectDestination(await readBody(request)) });
        return;
      }
      // Asked on its own so Suite Manager can decide whether showing the key needs
      // the owner password without paying for a full status.
      if (request.method === 'GET' && url.pathname === '/v1/recovery-key') {
        respond(response, 200, { recoveryKey: recoveryKeyStatus() });
        return;
      }
      // Suite Manager decides whether a password was required: it holds the owner's account.
      if (request.method === 'POST' && url.pathname === '/v1/recovery-key/reveal') {
        respond(response, 200, await revealRecoveryKey());
        return;
      }
      // 200 with `ok: false` when the vault refused: a rotation that stopped early
      // is a state to explain, and the key the owner has still opens everything.
      if (request.method === 'POST' && url.pathname === '/v1/recovery-key/rotate') {
        respond(response, 200, await rotateRecoveryKey());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/recovery-key/acknowledge') {
        keyStore.acknowledge(recoveryKeyFingerprint(engine.recoveryKey()));
        respond(response, 200, { recoveryKey: recoveryKeyStatus() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/archives/unlock') {
        respond(response, 200, { result: await unlockArchive(await readBody(request)) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/archives/keys') {
        respond(response, 200, { result: await archiveKeys(await readBody(request)) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/archives/keys/remove') {
        respond(response, 200, { result: await removeArchiveKey(await readBody(request)) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/archives/erase') {
        respond(response, 200, await eraseOtherServersArchive(await readBody(request)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/archives/forget-key') {
        respond(response, 200, { result: forgetGuestKey(await readBody(request)) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/object') {
        const record = objectRegistry.save(await readBody(request));
        destinationResolver.forget(record.id);
        respond(response, 200, { destination: publicObjectDestination(record) });
        return;
      }
      // Disconnecting forgets how to reach the bucket and never deletes what is in it.
      if (request.method === 'POST' && url.pathname === '/v1/destinations/object/remove') {
        const body = await readBody(request);
        if (primary.read()?.destinationId === body.destinationId) {
          throw new Error('Automatic backups are set to use this storage. Choose another destination for them first.');
        }
        const removed = objectRegistry.remove(String(body.destinationId || ''));
        destinationResolver.forget(removed.id);
        respond(response, 200, { destination: publicObjectDestination(removed) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/backups') {
        const body = await readBody(request);
        assertRecoveryKeyAcknowledged(url.pathname, body);
        const place = body.destinationId === PRIMARY_DESTINATION ? await primaryDestination() : await knownPlace(body.destinationId);
        if (place.reason) throw new Error(place.reason);
        await (await destinationResolver.target(place.id)).assertAvailable();
        const job = createJob('backup', { ...body, destinationId: place.id });
        if (body.makePrimary === true) primary.save({ destinationId: place.id, label: place.label });
        respond(response, 202, { job });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/backups/validate') { respond(response, 202, { job: createJob('validate', await readBody(request)) }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/schedule') {
        const body = await readBody(request);
        assertRecoveryKeyAcknowledged(url.pathname, body);
        // Where they go is part of the same choice, so a schedule is never on with nowhere to write.
        if (body.destinationId) {
          const place = await knownPlace(body.destinationId);
          primary.save({ destinationId: place.id, label: place.label });
        }
        if (body.enabled === true && !primary.read()) throw new Error('Choose where automatic backups go before turning them on.');
        respond(response, 200, { primaryDestination: primary.state(), schedule: scheduler.save(body) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/backups/note') {
        const body = await readBody(request);
        const locator = normalizeBackupLocator(body.backupPath);
        if (!locator) { respond(response, 400, { code: 'INVALID_BACKUP', error: 'Choose a detected backup from a connected destination.' }); return; }
        await assertOwnRestorePoint(locator);
        const note = String(body.note || '').trim().slice(0, 500);
        const { destination, pointId } = core.resolveBackup(locator);
        await destination.points.writeNote(pointId, note);
        respond(response, 200, { note: note || null });
        return;
      }
      // Deleting rewrites the shared repository, so it runs as a queued job: the
      // one-at-a-time pipeline is what keeps it clear of every backup, check and restore.
      if (request.method === 'POST' && url.pathname === '/v1/backups/delete') {
        const body = await readBody(request);
        const locator = normalizeBackupLocator(body.backupPath);
        if (locator) await assertOwnRestorePoint(locator);
        respond(response, 202, { job: createJob('delete', body) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/restores') { respond(response, 202, { job: createJob('restore', await readBody(request)) }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/restores/acknowledge-interruption') {
        respond(response, 200, { acknowledged: core.acknowledgeInterruptedRestore(await readBody(request)) });
        return;
      }
      respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' });
    } catch (error) {
      // The code travels, so the screen can tell a refusal it can act on from a failure.
      respond(response, 409, { code: error?.code || 'BACKUP_AGENT_ERROR', error: error instanceof Error ? error.message : 'Backup agent operation failed.' });
    }
  });
  serveOnSocket(server, {
    name: 'mos-backup-agent',
    // A machine that was off through its backup window owes a run; the early tick
    // makes it happen shortly after boot rather than a day later.
    onReady() {
      setTimeout(() => { void scheduler.tick().catch(() => {}); }, 10_000).unref();
      scheduler.start();
    },
    onShutdown: () => scheduler.stop(),
    socketPath,
  });
}

module.exports = { RECOVERY_KEY_GATED_ROUTES, RECOVERY_KEY_UNACKNOWLEDGED, packageBackupInventory, sha256, survey, validatePackagePayloads };
