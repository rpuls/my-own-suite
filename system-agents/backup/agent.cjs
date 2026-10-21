#!/usr/bin/env node

// Host wiring for the MOS backup agent: destination discovery, the job store,
// the unix-socket API, and the worker process entry. The backup/restore
// engine itself lives in agent-core.cjs behind injected adapters so its
// guarantees (rescue copy, absence reconciliation, journal, verification)
// are covered by unit tests instead of only Hyper-V drills.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
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
const { DestinationResolver, OTHER_SERVERS_BUCKET, parseObjectLocator } = require('./destinations.cjs');
const { isObjectDestinationId, normalizeObjectDestination, ObjectDestinationRegistry, objectRepositorySpec, publicObjectDestination } = require('./object-destinations.cjs');
const { createEngine, ENGINE_MISSING_MESSAGE, ENGINE_NAME, repositoryUsage } = require('./engines/engine.cjs');
const { fingerprint: recoveryKeyFingerprint, normalize: normalizeRecoveryKey } = require('./recovery-key.cjs');
const { GuestKeyStore } = require('./guest-keys.cjs');
const { recoveryKitFilename, recoveryKitText } = require('./recovery-kit.cjs');
const { RecoveryKeyStore } = require('../lib/recovery-key-store.cjs');
const { rotateRecoveryKey: rotateKey } = require('./key-rotation.cjs');
const { LastBackups } = require('./last-backups.cjs');
const { machineHasVault, readVaultDescriptor, vaultAsksForPassword } = require('../../shared/vault-contract.cjs');
const { VaultAgentClient } = require('../../suite-manager/backend/src/settings/vault-agent-client.cjs');
const { AppAgentClient } = require('../../suite-manager/backend/src/apps/app-agent-client.cjs');
const { AppPackageService } = require('../../suite-manager/backend/src/apps/app-package-service.cjs');
const { HomepageAgentClient } = require('../../suite-manager/backend/src/homepage/homepage-agent-client.cjs');
const { HomepageService } = require('../../suite-manager/backend/src/homepage/homepage-service.cjs');
const { STORAGE_MOUNT_ROOT, STORAGE_REGISTRY_FILENAME } = require('../../shared/storage-contract.cjs');
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
// The suite's one recorded address: read for the manifest and for the address
// apps are rebuilt on, written only to offer a domain a restore carried.
const suiteAddress = new SuiteAddressFile({ dir: suiteAddressDir(stateRoot) });
// Where Caddy serves the busy page from, which is where the progress file
// goes: the one place an owner can still read while Suite Manager is down.
const statusDir = process.env.MOS_STATUS_DIR || UNAVAILABLE_PAGE_ROOT;
// Build times the app agent recorded on this machine, for what a rebuild of
// each app is going to cost.
const buildTimingsPath = path.join(stateRoot, BUILD_TIMINGS_FILENAME);
const DRIVE_ID_PATTERN = /^[A-Za-z0-9-]{4,64}$/u;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
const readBody = bodyReader(128 * 1024);

function command(file, args, options = {}) {
  return execFileSync(file, args, { cwd: options.cwd || repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeout || 120_000 }).trim();
}
// The drives the storage module knows, as it sees them now: it mounts them,
// names them and records what claims them. Null when it cannot say, which
// lists no drives rather than calling every one of them away.
async function storageDrives() {
  try {
    return (await appAgent.storageInventory())?.drives || [];
  } catch {
    return null;
  }
}

// Why this server cannot back up to a drive right now, or null. Said here once,
// in the words every screen and the schedule repeat.
function driveRefusal(drive) {
  if (!drive.connected) return 'This drive is not plugged in.';
  if (drive.state === 'ejected') return 'This drive was ejected. Use it again in Settings → Storage.';
  if (drive.state === 'read-only') return 'MOS can read this drive but cannot save to it until it is checked in Settings → Storage.';
  if (!drive.mountPath || drive.state !== 'ready') return drive.reason || 'MOS could not open this drive.';
  return null;
}

function driveCondition(drive) {
  if (!drive.connected) return 'away';
  if (drive.state === 'ejected' || drive.state === 'read-only') return drive.state;
  return drive.mountPath && drive.state === 'ready' ? 'ready' : 'not-open';
}

// Whose an archive is, said outright: the screen renders this and never works
// it out again. An archive this server's key opens is this server's, whoever
// made it — a takeover restore makes another server's archive this one's.
async function describeArchive(archive, containerLabel, health) {
  const { keyState, reason = null, usage = null } = health || await archive.health();
  if (!keyState || keyState === 'empty') return null;
  const points = keyState === 'locked' && archive.kind === 'object' ? [] : await archive.points.summaries().catch(() => []);
  const newest = points.slice().sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
  const descriptor = archive.kind === 'disk' ? archive.descriptor() : null;
  const writtenBy = descriptor?.createdByInstallId || descriptor?.createdByHostname
    ? { hostname: descriptor.createdByHostname || null, installId: descriptor.createdByInstallId || null }
    : newest ? { hostname: newest.sourceHostname || null, installId: newest.sourceInstallId || null } : null;
  const stored = archive.kind === 'disk' ? repositoryUsage(archive.root) : usage;
  return {
    containerId: archive.containerId,
    containerKind: archive.kind,
    containerLabel,
    id: archive.id,
    keyState,
    newestAt: newest?.createdAt || null,
    owner: keyState === 'own' ? 'this' : 'other',
    reason: keyState === 'locked' ? reason : null,
    restorePoints: keyState === 'locked' ? null : stored?.restorePoints ?? points.length,
    storedBytes: stored?.storedBytes ?? null,
    writtenBy,
  };
}

// Everything the backups screen and the schedule ask about: the places this
// server backs up to, and every archive MOS can see, this server's and other
// servers'. A drive is a place once the owner made it one in the storage
// picker; its archives are listed whatever claims the drive, because a drive
// plugged in for an app can still carry another server's backups.
async function survey() {
  const drives = await storageDrives() || [];
  const destinations = [];
  const archives = [];
  for (const drive of drives) {
    const label = drive.name || drive.label;
    if (drive.connected && drive.mountPath && drive.holdsBackupsFormat) {
      for (const archive of destinationResolver.archivesOn(drive.id)) {
        const described = await describeArchive(archive, label);
        if (described) archives.push(described);
      }
    }
    if (!drive.backups) continue;
    const refusal = driveRefusal(drive);
    destinations.push({
      availableBytes: drive.connected ? drive.availableBytes ?? null : null,
      condition: driveCondition(drive),
      earlierBackups: drive.holdsEarlierBackups === true,
      holdsAppFiles: (drive.apps || []).length > 0,
      id: drive.id,
      kind: 'disk',
      label,
      refusal,
      sizeBytes: drive.sizeBytes ?? null,
      storageKind: drive.transport === 'usb' || drive.removable ? 'external' : 'local',
      transport: drive.transport || null,
    });
  }
  for (const bucket of destinationResolver.objectDestinations()) {
    const health = await bucket.health().catch(() => ({ keyState: null, ready: false, reason: 'MOS could not reach this storage.', usage: null }));
    const described = await describeArchive(bucket, bucket.label, health);
    if (described) archives.push(described);
    // A connection holds one archive, so one another server made leaves the
    // connection no room for this server's: it is listed as that archive only.
    if (described?.owner === 'other') continue;
    destinations.push({
      ...publicObjectDestination(bucket.record),
      availableBytes: null,
      checkedAt: health.checkedAt || null,
      condition: health.ready ? 'ready' : 'unreachable',
      kind: 'object',
      refusal: health.ready ? null : health.reason || 'MOS could not reach this storage.',
      sizeBytes: null,
      storageKind: 'object',
    });
  }
  for (const destination of destinations) {
    const own = archives.filter((archive) => archive.containerId === destination.id && archive.owner === 'this')
      .sort((left, right) => String(right.newestAt || '').localeCompare(String(left.newestAt || '')))[0] || null;
    destination.ownArchive = own ? { id: own.id, restorePoints: own.restorePoints, storedBytes: own.storedBytes } : null;
    if (own?.newestAt) lastBackups.note(destination.id, own.newestAt);
    destination.lastBackupAt = own?.newestAt || lastBackups.of(destination.id);
    // Without the engine binary nothing can be written anywhere, so it is the
    // destination that is unusable, not the backup that failed. Said last so a
    // drive that is also unplugged still says the thing the owner can fix.
    if (!engine.installed() && !destination.refusal) Object.assign(destination, { condition: 'no-engine', refusal: ENGINE_MISSING_MESSAGE });
  }
  return { archives, destinations };
}

// Answers three different things an owner needs told apart: MOS reached the
// bucket and it already holds backups, MOS reached it and it is empty, or MOS
// could not get in and here is what the provider said.
async function testObjectDestination(input) {
  const record = normalizeObjectDestination(input, input.id ? objectRegistry.get(String(input.id)) : null);
  const spec = objectRepositorySpec(record);
  const probe = await engine.probe(spec);
  if (probe.state === 'unreachable') return { message: probe.message, ok: false };
  if (probe.state === 'locked') return { locked: true, message: `${probe.message} Connect this bucket, then choose Enter recovery key on it.`, ok: false };
  if (probe.state === 'absent') return { message: 'Connected. This bucket holds no MOS backups yet; the first backup creates the encrypted store in it.', ok: true, restorePoints: 0 };
  // Counted without touching the stored index, because this may be a
  // connection that has not been saved and must leave nothing behind.
  let restorePoints = null;
  try {
    const snapshots = await engine.listSnapshots({ repository: { engineName: engine.name, localPath: null, ...spec } });
    restorePoints = snapshots.filter((snapshot) => (snapshot.tags || []).includes('mosrole:manifest')).length;
  } catch {}
  return {
    message: restorePoints === null
      ? 'Connected. This bucket already holds a MOS backup store.'
      : `Connected. This bucket already holds ${restorePoints} MOS restore point${restorePoints === 1 ? '' : 's'}, which will be listed here.`,
    ok: true,
    restorePoints,
  };
}
// Anything that backs up without being asked names this instead of a place:
// only this agent knows where automatic backups go right now.
const PRIMARY_DESTINATION = 'primary';
async function primaryBackupDestinationId() {
  const chosen = primary.read();
  if (!chosen) {
    throw Object.assign(new Error('No destination is set for automatic backups, so there is nowhere to write this backup.'), { code: 'NO_PRIMARY_DESTINATION' });
  }
  const destination = primary.resolve((await survey()).destinations);
  const absentCode = isObjectDestinationId(chosen.destinationId) ? 'DESTINATION_UNREACHABLE' : 'DESTINATION_ABSENT';
  if (!destination) throw Object.assign(new Error('The destination automatic backups are written to is not available right now.'), { code: absentCode });
  if (destination.refusal) throw Object.assign(new Error(destination.refusal), { code: absentCode });
  return destination.id;
}
// A destination is a configured bucket or a drive's filesystem UUID; whether it
// is one this server backs up to is the survey's to say.
function normalizeDestinationId(candidate) {
  const value = String(candidate || '');
  if (isObjectDestinationId(value)) return objectRegistry.get(value) ? value : null;
  return DRIVE_ID_PATTERN.test(value) ? value : null;
}
async function knownDestination(candidate) {
  const id = normalizeDestinationId(candidate);
  const destination = id ? (await survey()).destinations.find((entry) => entry.id === id) : null;
  if (!destination) throw new Error('Choose one of this server\'s backup places.');
  return destination;
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
function workerAlive(jobFile) {
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        if (cmdline.includes('--worker') && cmdline.includes(jobFile)) return true;
      } catch {}
    }
  } catch {}
  return false;
}
// A job's worker is a detached process, so a power loss or kill can leave
// current-job.json claiming an active job forever. Reconcile against the
// actual worker process before trusting it; the grace period covers the
// window between job creation and the worker's exec.
function reconcileCurrentJob() {
  const job = readCurrentJob();
  if (!isActive(job)) return job;
  const startedMs = new Date(job.createdAt || 0).getTime();
  if (Date.now() - startedMs < 15_000) return job;
  if (workerAlive(jobPath(job.id))) return job;
  // A killed worker ran none of its own cleanup, so whatever it had already
  // written to the repository is referenced by nothing. Record the destination
  // so the next job for it collects the space.
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
// The last handful of jobs, newest first, for the activity list. Only what a
// sentence about a finished job needs: the logs and validation of a job that is
// over belong to the job itself, not to a summary of five of them.
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
      // The owner's words for where a running job is; a finished job is a
      // sentence about what happened, and needs none.
      sentence: isActive(job) ? job.progress?.sentence || stageSentence(job.stage) : null,
      stage: job.stage || null,
      status: job.status || null,
      step: isActive(job) ? job.progress?.step ?? null : null,
      steps: isActive(job) ? job.progress?.steps ?? null : null,
      updatedAt: job.updatedAt || job.createdAt || null,
      updateTarget: job.updateTarget || null,
    }));
}
// Every finished job with a timeline: what this machine's own estimates are
// read off. Failed jobs are left out — a check that stopped after a second
// says nothing about how long one takes.
function jobHistory() {
  return listJobFiles().map((file) => { try { return readJson(file); } catch { return null; } })
    .filter((job) => job && job.status === 'succeeded' && Array.isArray(job.timeline));
}
// The name an app is shown under, from the catalog package in this checkout;
// a package this checkout does not carry is named by its id.
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
  } catch {}
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
  return { address: job.address && typeof job.address === 'object' ? job.address : null, backupPath: job.backupPath || null, controlPlane: job.controlPlane || null, destinationId: job.destinationId || null, error: job.error || null, id: job.id, kind: job.kind || null, logs: Array.isArray(job.logs) ? job.logs.slice(-20) : [], outputPath: job.outputPath || null, progress: job.progress || null, rescuePath: job.rescuePath || null, stage: job.stage || null, status: job.status || null, summary: job.summary || null, updatedAt: job.updatedAt || null, validation: job.validation || null, verification: job.verification || null };
}
function isActive(job) { return job && (job.status === 'queued' || job.status === 'running'); }
function jobPath(id) { return path.join(jobsDir, `${id}.json`); }
function createJob(kind, payload) {
  // The code travels so a caller that can simply wait — the checkpoint before
  // an update — can tell "busy right now" from a refusal it has to report.
  if (isActive(reconcileCurrentJob())) throw Object.assign(new Error('A backup or restore job is already running.'), { code: 'JOB_ACTIVE' });
  const interrupted = core.interruptedRestore();
  // Validation never touches the running suite, so it stays available while an
  // interrupted restore blocks destructive work — checking whether a backup is
  // restorable is part of recovery.
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
// A locator names one restore point. On a drive it is the manifest file inside
// its archive's restore-points folder, on a drive mounted where the storage
// module mounts drives; in a bucket it is the storage connection and the
// point's id. Either way it must resolve to something this machine has, which
// is what stops a locator from the wire naming anything else.
//
// The field is still called backupPath on the wire and in job records: those
// records and the restore journal exist on installed machines, and renaming
// what they contain would be a migration with nothing to show for it.
function normalizeBackupLocator(candidate) {
  const value = String(candidate || '');
  const object = parseObjectLocator(value);
  if (object) return objectRegistry.get(object.destinationId) ? value : null;
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${STORAGE_MOUNT_ROOT}${path.sep}`) || !isRestorePointPath(resolved)) return null;
  return fs.existsSync(resolved) && fs.existsSync(`${resolved}.sha256`) ? resolved : null;
}
// Restore points of every archive MOS can open, this server's and the ones
// another server's key was entered for. A locked archive lists none: MOS
// cannot say what is in it.
async function listBackups(archives) {
  const backups = [];
  // Read once for the whole listing: every restore point's estimate is drawn
  // from the same history and the same build timings.
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
    // An archive that will not answer contributes nothing rather than failing
    // the whole listing: one unreachable bucket must not hide the backups on a
    // drive that is plugged in right now.
    let points = [];
    try {
      points = await archive.points.summaries();
    } catch {}
    for (const point of points) {
      backups.push({
        ...point,
        archiveId: entry.id,
        containerId: entry.containerId,
        containerLabel: entry.containerLabel,
        encrypted: true,
        engineName: point.engineName || descriptor?.engineName || ENGINE_NAME,
        // What checking or restoring this point will take on this machine,
        // said in the owner's words before either is started.
        expect: {
          check: checkExpectation({ history, sizeBytes: point.sizeBytes }),
          restore: restoreExpectation({ apps: appsWithNames(point.apps), buildTimings, cpus, history, sizeBytes: point.sizeBytes }),
        },
        owner: entry.owner,
        path: point.locator,
        repositoryId: descriptor?.repositoryId || null,
      });
    }
  }
  return backups.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
}
// Every change to a job goes through here, so the progress record on it and
// the public file the busy page polls are always what the job record says. An
// active job publishes; a job that is over — however it ended, and in
// whichever process noticed — takes the file with it.
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
  // Said once the job knows what it is working on, and kept from then on — a
  // null is kept too, so a kind with no expectation is not re-read for one on
  // every log line.
  if (job.expect === undefined && job.subject) {
    try { job.expect = runningExpectation(job.kind, expectationInputs(job.subject)) || null; } catch { job.expect = null; }
  }
  const next = progressFor(job, { count: count ?? null, now });
  // A count belongs to the stage it was reported in: kept through that stage's
  // log lines, dropped the moment the stage moves on.
  if (count === undefined && job.progress?.stage === job.stage && job.progress.count) next.count = job.progress.count;
  job.progress = next;
}
function log(file, message) { updateJob(file, (job) => { job.logs.push({ at: new Date().toISOString(), message }); }); }
function stage(file, name) {
  updateJob(file, (job) => { advanceTimeline(job, name); job.stage = name; job.substage = null; job.status = 'running'; }, { count: null });
  log(file, name);
}
// Which part of a long stage is running. It is not a stage: it opens no
// timeline entry, because the estimates are read off whole stages and a stage
// that suddenly measures as three would make this machine's history
// unreadable.
function substage(file, name) {
  updateJob(file, (job) => { job.substage = name; });
  log(file, name);
}
// Which item of how many the current stage is on. The engine names the app by
// package id; the name shown, and what that app usually costs here, are added
// on this side because only the host has the catalog and the timings.
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
// address, whatever the backup was written on. Nothing here derives it.
function restoreBaseUrl() {
  const address = suiteAddress.read();
  return { homeHost: address.host, scheme: address.scheme };
}
function recordedDomain() {
  const address = suiteAddress.readOrNull();
  return address?.kind === 'domain' ? address : null;
}
// Generated once, on this machine's first agent start, and kept beside the
// engine key where nothing backs it up: the one fact a restore point can carry
// that says which machine wrote it, whatever the machine was called.
function installId() {
  try {
    const existing = fs.readFileSync(installIdPath, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const id = crypto.randomUUID();
  ensureDir(agentStateDir);
  fs.writeFileSync(installIdPath, `${id}\n`, 'utf8');
  return id;
}
// Who this machine is, and what a restore does about the address: nothing. The
// address lives in a machine-local file the restore never touches, so the apps
// come back on whatever door the owner came in through — the Easy Door, the
// install-time name, or a domain this machine was already serving. The name the
// backup carried becomes an offer in Settings instead, and serving it is the
// domain module's job and happens nowhere else. A restore that wrote its own
// TLS config was how a machine came back serving a name its own Suite Manager
// refused.
const identity = {
  acmeEmail: () => recordedDomain()?.acmeEmail || null,
  // A restore that takes another machine's place makes that machine's key this
  // machine's own, and the borrowed copy is dropped: the two are now one server
  // with one key. Nothing is written to the archive to do it — adding this
  // machine's key there instead would leave every test restore's key able to
  // open it for good.
  //
  // On a machine with a vault that means the disk too, and the disk goes first.
  // Adopting the key for the backups alone would leave an owner holding a card
  // that opens their archive and not their server, and they would find out at
  // the one moment they need it. A rekey that fails therefore abandons the
  // whole adoption: the archive stays readable with the borrowed key, which is
  // a state the screen already explains.
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
    // The archive is this server's now, so where it is becomes one of this
    // server's backup places. Asked of the storage module, which owns drive
    // claims; a refusal leaves the archive this server's and the place for the
    // owner to pick, which the screen already offers.
    const containerId = destinationResolver.resolve(archiveId).containerId;
    try {
      if (isObjectDestinationId(containerId)) objectRegistry.holdBackups(containerId, true);
      else await appAgent.holdBackups({ drive: containerId, held: true });
    } catch {}
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
// restored config on this machine's address. The managed app tiles need their
// widget endpoints re-derived the same way an address change does it.
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
async function reconcileRestoredApps(logMessage, onProgress = () => {}) {
  const store = new SuiteManagerStore(stateDir);
  try {
    const appPackages = new AppPackageService({
      agent: new AppAgentClient(),
      appsDir: path.join(repoDir, 'apps'),
      store,
    });
    const instances = store.getAppInstances().filter((instance) => instance.status === 'installed' && instance.enabled);
    if (!instances.length) {
      logMessage('No installed app runtimes to restore');
      return;
    }
    for (const [index, instance] of instances.entries()) {
      const displayName = instance.displayNameSnapshot || displayNameOf(instance.packageId);
      onProgress({ displayName, done: index, packageId: instance.packageId, total: instances.length, unit: 'apps' });
      logMessage(`Restoring ${displayName}`);
      await appPackages.enablePackage(instance.packageId, restoreRequestContext(instance.packageId));
    }
  } finally {
    store.close();
  }
}

const RECOVERY_KEY_UNACKNOWLEDGED = 'Save your recovery key first. It is the only thing that can open these backups on a replacement server, and MOS shows it once before the first backup.';
// Only what would create a backup is gated: a backup now, or a schedule that is
// enabled. Mounting a drive, connecting or testing a bucket, listing, validating,
// restoring and switching a schedule off all stay available while the key is
// unsaved — none of them write a backup, and a replacement machine in the middle
// of recovering must not be blocked by a dialog about its own future backups.
const RECOVERY_KEY_GATED_ROUTES = Object.freeze(['/v1/backups', '/v1/schedule']);

// Enforced by the agent as well as by the screen, so a page left open from
// before the key existed cannot get past it.
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
    // Set when this key was typed off another server's kit rather than made
    // here, which is the difference between "your key" and "their key".
    adoptedAt: record.adoptedAt,
    // Read from the key itself rather than from the record, so the screen shows
    // what this machine actually holds even before it has been acknowledged.
    fingerprint: recoveryKeyFingerprint(engine.recoveryKey()),
    keyFile: engine.keyFile,
  };
}

// The address the kit tells an owner to come back to. Read from the restored
// identity rules rather than from install-time env alone, so an applied HTTPS
// domain is what gets printed.
function homeAddress() {
  let store = null;
  try {
    store = new SuiteManagerStore(stateDir);
  } catch {}
  try {
    const { homeHost, scheme } = restoreBaseUrl(store);
    return `${scheme}://${homeHost}/`;
  } catch {
    return null;
  } finally {
    try { store?.close(); } catch {}
  }
}

// Built in the agent because only the agent can see the destinations — and it
// composes the kit out of what a provider's console cannot tell an owner
// afterwards, never out of the credentials it holds for them.
async function recoveryKit(key) {
  const destinations = [
    ...(await survey()).destinations.filter((entry) => entry.kind === 'disk').map((entry) => ({ kind: 'drive', label: entry.label })),
    ...objectRegistry.list().filter((record) => record.backups === true).map((record) => ({ bucket: record.bucket, endpoint: record.endpoint, folder: record.folder || '', kind: 'bucket', label: record.label, region: record.region || '' })),
  ];
  const hostname = os.hostname();
  const now = new Date();
  return {
    // Read from the descriptor rather than asked of the vault agent: this runs
    // while composing a kit an owner may be printing because their machine is in
    // trouble, and one more socket that can be down is one more way for the
    // sheet to come out wrong.
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

// What a rotation can reach right now: this server's own archives on the
// drives that are plugged in and in the buckets that are connected. A drive in
// a drawer is deliberately not here — it is the reason a rotation reports what
// it could not finish, rather than claiming a key change that a copy in a
// drawer knows nothing about. Other servers' archives are never rekeyed.
async function attachedDestinations() {
  return (await survey()).archives.filter((archive) => archive.owner === 'this').map((archive) => destinationResolver.resolve(archive.id));
}

// Replacing this machine's recovery key with a new one. The disk half is the
// vault agent's, over the same socket a takeover uses, and it goes first so a
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

// Opening backups another server wrote, without changing them. The entered key
// is checked against the archive and then kept on this machine, against that
// archive, and handed to the engine for every command aimed at it. Nothing is
// written into the archive — not its contents and not its key list: it belongs
// to the server that made it, and connecting to something is not a reason to
// alter it. Becoming that server is a separate act, and it happens at restore,
// where the owner has said this machine is taking the other one's place.
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

// Which keys open an archive, and taking one back out.
//
// An owner is entitled to know who can read their backups and to end that
// access, and MOS is the only place that can tell them without a terminal.
// Both need a key that already opens the archive, because restic will not
// list or change a key list for anyone who cannot already open it — which is
// also what stops this from being a way to lock someone else out.
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
  // Two refusals that exist so this cannot end in an archive nobody opens: the
  // key doing the removing stays, and the last one standing stays.
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

// A note or a deletion changes an archive, so neither is made in one that is
// not this server's own: it belongs to the server whose key made it.
async function assertOwnRestorePoint(locator) {
  const { destination } = core.resolveBackup(locator);
  if (destination.guestKey() || (await destination.health()).keyState !== 'own') throw new Error('These backups belong to another server, so MOS does not change them.');
}

// Forgetting a borrowed key. The archive is untouched by this too: the key
// stops being on this machine, and the archive goes back to needing it.
function forgetGuestKey(body) {
  const archiveId = String(body.archiveId || '');
  const forgotten = guestKeys.forget(archiveId);
  destinationResolver.forget(archiveId);
  return { forgotten };
}

// Erasing one archive another server made, on a drive. Never this server's
// own: those go one restore point at a time, from the list where each one is
// named. The folder is moved aside first, so the space is the owner's the
// moment this answers and the slow delete of a large archive runs behind it.
async function eraseOtherServersArchive(body) {
  if (body.confirmation !== 'ERASE') throw new Error('Confirm that these backups are to be erased.');
  const listed = await knownArchive(body.archiveId);
  if (listed.containerKind !== 'disk') throw new Error('MOS erases backups only on a drive. Remove them in the storage provider\'s own console.');
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
  void fs.promises.rm(doomed, { force: true, recursive: true }).catch((error) => process.stderr.write(`[mos-backup-agent] ${doomed} was not fully erased: ${error.message}\n`));
  guestKeys.forget(listed.id);
  destinationResolver.forget(listed.id);
  return { erased: true };
}

// What the schedule needs to know about a destination's restore points: when
// each was taken and whether the schedule itself took it. Asked of the
// destination rather than taken from listBackups, because retention must not
// depend on which drives happen to be mounted.
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
// Only ever asked to rekey the disk at the end of a takeover restore. A machine
// with no vault answers that there was nothing to do.
const vaultAgent = new VaultAgentClient({ socketPath: process.env.MOS_VAULT_AGENT_SOCKET || '/run/mos-vault-agent/agent.sock' });
// Every archive this server creates says which machine made it, readable
// without its key, so another server can name it before anyone unlocks it.
const destinationResolver = new DestinationResolver({ agentStateDir, createdBy: () => ({ hostname: os.hostname(), installId: installId() }), engine, guestKeys, objectRegistry, system: backupSystem });
// Both agents run as root under the same unit template, so this agent can ask
// the update agent what it is doing over its socket the way Suite Manager does.
const updateAgent = new UpdateAgentClient();

// Whether a platform update is running. An update restarts this agent partway
// through, so a backup that started underneath one would be cut off mid-write.
// An update agent that does not answer is not an update in progress: a backup
// refused because a socket was missing would be a backup that never happened.
async function updateInProgress() {
  try {
    const summary = await updateAgent.summary();
    return isActive(summary?.currentJob);
  } catch {
    return false;
  }
}

const primary = new PrimaryDestination({ agentStateDir });

const scheduler = new BackupScheduler({
  agentStateDir,
  createJob: (kind, payload) => createJob(kind, payload),
  destinations: async () => (await survey()).destinations,
  log: (message) => process.stdout.write(`[mos-backup-agent] ${message}\n`),
  primary,
  // Reconciled first: a worker killed by a power loss leaves its job file
  // saying "running" until something checks, and the scheduler must not wait
  // on that forever just because nobody had the Backups screen open.
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
  // Before anything can ask for it: the screen has to be able to show an owner
  // their recovery key before a backup exists.
  engine.recoveryKey();
  installId();
  // A worker that died with the machine never cleared the file the busy page
  // reads; the next agent start is the first moment anything can.
  if (!isActive(reconcileCurrentJob())) progressPublisher.clear();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        const { archives, destinations } = await survey();
        respond(response, 200, {
          archives,
          backups: await listBackups(archives),
          capabilities: { backups: ['create', 'delete', 'list', 'schedule', 'validate'], destinations: ['connect-object', 'list', 'primary'], archives: ['erase', 'forget-key', 'keys', 'unlock'], recoveryKey: ['acknowledge', 'reveal', 'rotate'], restores: ['acknowledge-interruption', 'apply', 'list'], storage: { engine: ENGINE_NAME, model: 'archives' } },
          currentJob: summarizeJob(reconcileCurrentJob()),
          destinations,
          hostname: os.hostname(),
          interruptedRestore: core.interruptedRestore(),
          lastJob: summarizeJob(latestJob()),
          recentJobs: recentJobs(),
          // Where everything that backs up on its own writes: the schedule, and
          // the checkpoint before a MOS update.
          primaryDestination: primary.state(),
          recoveryKey: recoveryKeyStatus(),
          schedule: scheduler.state(),
          service: 'mos-backup-agent',
        });
        return;
      }
      // The cheap read. A full status lists every drive and reaches every
      // connected bucket, which is far too much for the two questions another
      // agent asks often: is a job running, and where do unattended backups go.
      if (request.method === 'GET' && url.pathname === '/v1/summary') {
        respond(response, 200, {
          currentJob: summarizeJob(reconcileCurrentJob()),
          primaryDestination: primary.state(),
          schedule: scheduler.state(),
          service: 'mos-backup-agent',
        });
        return;
      }
      // One job by id, for a caller waiting on the backup it asked for: the
      // current job may already be someone else's by the time it looks.
      if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
        const id = path.basename(url.pathname);
        reconcileCurrentJob();
        let job = null;
        try { job = readJson(jobPath(id)); } catch {}
        if (!job) { respond(response, 404, { code: 'NOT_FOUND', error: 'Job was not found.' }); return; }
        respond(response, 200, { job: summarizeJob(job) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/primary') {
        const body = await readBody(request);
        if (body.destinationId === null) { respond(response, 200, { primaryDestination: primary.clear() }); return; }
        const known = await knownDestination(body.destinationId);
        respond(response, 200, { primaryDestination: primary.save({ destinationId: known.id, label: known.label }) });
        return;
      }
      // Reaching the bucket before anything is stored is the whole point of the
      // test: an owner who mistyped a key finds out here, from the provider's
      // own answer, rather than from a backup that fails at three in the
      // morning. Nothing is written — a repository is created by the first
      // backup, not by connecting.
      if (request.method === 'POST' && url.pathname === '/v1/destinations/object/test') {
        respond(response, 200, { result: await testObjectDestination(await readBody(request)) });
        return;
      }
      // Asked on its own so Suite Manager can decide whether this showing needs
      // the owner password without paying for a full status, which lists drives
      // and reaches every connected bucket.
      if (request.method === 'GET' && url.pathname === '/v1/recovery-key') {
        respond(response, 200, { recoveryKey: recoveryKeyStatus() });
        return;
      }
      // Shown before it is needed, and shown again to a signed-in owner who asks:
      // Suite Manager decides whether a password was required, because it is the
      // component that holds the owner's account.
      if (request.method === 'POST' && url.pathname === '/v1/recovery-key/reveal') {
        respond(response, 200, await revealRecoveryKey());
        return;
      }
      // Answered 200 with `ok: false` when the vault refused, because a
      // rotation that stopped early is a state to explain rather than a
      // failure: the key the owner already has still opens everything.
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
      if (request.method === 'POST' && url.pathname === '/v1/destinations/object/backups') {
        const body = await readBody(request);
        const held = body.held === true;
        if (!held && primary.read()?.destinationId === body.destinationId) {
          throw new Error('Automatic backups are set to use this storage. Choose another destination for them first.');
        }
        const record = objectRegistry.holdBackups(String(body.destinationId || ''), held);
        destinationResolver.forget(record.id);
        respond(response, 200, { destination: publicObjectDestination(record) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/object/remove') {
        const body = await readBody(request);
        // Disconnecting forgets how to reach the bucket. It never deletes what
        // is in it: the backups stay, and reconnecting the same bucket lists
        // them again.
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
        const requested = body.destinationId === PRIMARY_DESTINATION ? await primaryBackupDestinationId() : (await knownDestination(body.destinationId)).id;
        await (await destinationResolver.target(requested)).assertAvailable();
        respond(response, 202, { job: createJob('backup', { ...body, destinationId: requested }) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/backups/validate') { respond(response, 202, { job: createJob('validate', await readBody(request)) }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/schedule') {
        const body = await readBody(request);
        assertRecoveryKeyAcknowledged(url.pathname, body);
        // Where the backups go is the primary's, not the schedule's, so a
        // schedule cannot be turned on before one is chosen.
        if (body.enabled === true && !primary.read()) throw new Error('Choose the destination automatic backups go to before turning them on.');
        respond(response, 200, { schedule: scheduler.save(body) });
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
      if (request.method === 'POST' && url.pathname === '/v1/backups/delete') {
        // Deleting a restore point rewrites the shared repository with the
        // engine's concurrency safety off, so it runs as a queued job: the
        // one-at-a-time pipeline is what guarantees no backup, check, or
        // restore overlaps the rewrite in either direction. createJob also
        // refuses it while a restore sits interrupted — the backups on the
        // drive may be the only recovery material there is.
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
      // The code travels, because the screen has to tell a refusal it can act on
      // — an unsaved recovery key, a mistyped one — from a failure it can only
      // report.
      respond(response, 409, { code: error?.code || 'BACKUP_AGENT_ERROR', error: error instanceof Error ? error.message : 'Backup agent operation failed.' });
    }
  });
  serveOnSocket(server, {
    name: 'mos-backup-agent',
    // A machine that was off through its backup window owes a run; the early
    // tick is what makes it happen shortly after boot rather than a day later.
    onReady() {
      setTimeout(() => { void scheduler.tick().catch(() => {}); }, 10_000).unref();
      scheduler.start();
    },
    onShutdown: () => scheduler.stop(),
    socketPath,
  });
}

module.exports = { RECOVERY_KEY_GATED_ROUTES, RECOVERY_KEY_UNACKNOWLEDGED, packageBackupInventory, sha256, validatePackagePayloads };
