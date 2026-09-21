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
const { execFile, execFileSync, spawn } = require('node:child_process');
const { BackupAgentCore, isRestorePointPath, sha256, UNREADABLE_LEGACY_BACKUP, validatePackagePayloads } = require('./agent-core.cjs');
const { PROGRESS_FILENAME, UNAVAILABLE_PAGE_ROOT } = require('../../infrastructure/control-plane-runtime.cjs');
const { SuiteAddressFile, suiteAddressDir } = require('../../shared/suite-address.cjs');
const { BUILD_TIMINGS_FILENAME, expectedBuildSeconds, readBuildTimings } = require('../lib/app-build-timings.cjs');
const { checkExpectation, restoreExpectation, runningExpectation } = require('./expectations.cjs');
const { ProgressPublisher, advanceTimeline, closeTimeline, progressFor, stageSentence } = require('./progress.cjs');
const { BackupSystemAdapter } = require('./system-adapter.cjs');
const { BackupScheduler } = require('./scheduler.cjs');
const { PrimaryDestination } = require('./primary.cjs');
const { DestinationResolver, parseObjectLocator } = require('./destinations.cjs');
const { isObjectDestinationId, normalizeObjectDestination, ObjectDestinationRegistry, objectRepositorySpec, publicObjectDestination } = require('./object-destinations.cjs');
const { createEngine, ENGINE_MISSING_MESSAGE, ENGINE_NAME, readRepositoryDescriptor, repositoryUsage } = require('./engines/engine.cjs');
const { fingerprint: recoveryKeyFingerprint, normalize: normalizeRecoveryKey } = require('./recovery-key.cjs');
const { GuestKeyStore } = require('./guest-keys.cjs');
const { recoveryKitFilename, recoveryKitText } = require('./recovery-kit.cjs');
const { RecoveryKeyStore } = require('../lib/recovery-key-store.cjs');
const { rotateRecoveryKey: rotateKey } = require('./key-rotation.cjs');
const { KnownDrives } = require('./known-drives.cjs');
const { machineHasVault, readVaultDescriptor, vaultAsksForPassword } = require('../../shared/vault-contract.cjs');
const { VaultAgentClient } = require('../../suite-manager/backend/src/settings/vault-agent-client.cjs');
const { AppAgentClient } = require('../../suite-manager/backend/src/apps/app-agent-client.cjs');
const { AppPackageService } = require('../../suite-manager/backend/src/apps/app-package-service.cjs');
const { HomepageAgentClient } = require('../../suite-manager/backend/src/homepage/homepage-agent-client.cjs');
const { HomepageService } = require('../../suite-manager/backend/src/homepage/homepage-service.cjs');
const { collectPackageFiles, verifySnapshotIdentity } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
const { SuiteManagerStore } = require('../../suite-manager/backend/src/state/suite-manager-store.cjs');
const { UpdateAgentClient } = require('../../suite-manager/backend/src/updates/update-agent-client.cjs');

const socketPath = process.env.MOS_BACKUP_AGENT_SOCKET || '/run/mos-backup-agent/agent.sock';
const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
const stateDir = process.env.MOS_STATE_DIR || path.join(stateRoot, 'suite-manager');
const repoDir = process.env.MOS_REPO_DIR || path.resolve(__dirname, '..', '..');
const agentStateDir = process.env.MOS_BACKUP_AGENT_STATE_DIR || path.join(stateRoot, 'backup-agent');
const bootstrapContractPath = path.join(stateRoot, 'bootstrap-contract.env');
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
const managedMountRoot = '/media/mos-backup';
const destinationRoots = ['/media', '/mnt', '/run/media'];
const mountableFileSystems = new Set(['exfat', 'ext2', 'ext3', 'ext4', 'ntfs', 'ntfs3', 'vfat', 'xfs', 'btrfs']);

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function respond(response, status, payload) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(`${JSON.stringify(payload)}\n`); }
function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 128 * 1024) reject(new Error('BODY_TOO_LARGE')); });
    request.on('end', () => { try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { reject(new Error('INVALID_JSON')); } });
    request.on('error', reject);
  });
}

function command(file, args, options = {}) {
  return execFileSync(file, args, { cwd: options.cwd || repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeout || 120_000 }).trim();
}
function execJson(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout || 'null')); } catch { resolve(null); }
    });
  });
}
function normalizeDestination(candidate) {
  const resolved = path.resolve(String(candidate || ''));
  if (!destinationRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) return null;
  try { return fs.statSync(resolved).isDirectory() ? resolved : null; } catch { return null; }
}
function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}
// Resolved as POSIX because these are Linux mountpoints reported by lsblk, not
// paths on whatever machine is running the code. `path.resolve` is
// platform-dependent and turns "/" into a drive letter off Linux, which would
// silently stop recognising the system disk anywhere the agent is exercised.
function isSystemMountpoint(mountpoint) {
  const resolved = path.posix.resolve('/', String(mountpoint || ''));
  return resolved === '/' || resolved === '/boot' || resolved === '/boot/efi' || resolved === '/var' || resolved === '/var/lib' || resolved.startsWith('/var/lib/docker/');
}
// A drive formatted end to end carries no partition table, so lsblk reports a
// single `disk` with a filesystem on it and no children. That is an ordinary
// backup drive and it is also the shape a whole-disk drive comes back as after
// a restore drill, which is why refusing it made such a drive unre-attachable
// from the UI. A disk that does have partitions stays a container: its
// partitions are the candidates, and it is not one itself.
function isWholeDiskFilesystem(device) {
  return device.type === 'disk'
    && Boolean(String(device.fstype || '').trim())
    && (device.children || []).length === 0;
}
function mountBlockReason(device) {
  const fileSystem = String(device.fstype || '').toLowerCase();
  if (device.type !== 'part' && !isWholeDiskFilesystem(device)) return 'Choose a data partition, not the whole device.';
  if (!device.path) return 'The device path was not reported by Linux.';
  if (!fileSystem) return 'The partition has no detected filesystem.';
  if (!mountableFileSystems.has(fileSystem)) return `The ${fileSystem} filesystem is not mounted automatically yet.`;
  const label = String(device.label || '').toLowerCase();
  const sizeBytes = Number(device.size) || 0;
  const points = Array.isArray(device.mountpoints) ? device.mountpoints.filter(Boolean) : [];
  if (label === 'efi' || (fileSystem === 'vfat' && sizeBytes > 0 && sizeBytes < 1024 * 1024 * 1024) || points.some(isSystemMountpoint)) {
    return 'This looks like a system partition, not a backup drive.';
  }
  return null;
}
function sanitizeMountName(value) {
  return String(value || 'drive').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'drive';
}
// A mounted filesystem has a different device id from the directory it is
// mounted over, which is the only positive proof available that a path is the
// drive rather than the mountpoint left behind on the system disk. Anything that
// cannot be determined answers "mounted", because the one caller deletes what
// this says is not a drive.
function isMountPoint(dir) {
  try {
    return fs.statSync(dir).dev !== fs.statSync(path.dirname(dir)).dev;
  } catch {
    return true;
  }
}
function directorySize(dir) {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else { try { total += fs.lstatSync(full).size; } catch {} }
    }
  }
  return total;
}
// A drive pulled mid-backup leaves its mountpoint behind as an ordinary
// directory on the system disk, holding whatever was written after the drive
// went away — measured at 34 MB in the drills. It is invisible the moment the
// drive is plugged back in, because the mount covers it, so nothing ever
// reclaimed it. Only directories MOS itself created under its own mount root are
// considered, and only ones proved not to be a mount right now.
function reclaimUnmountedDestinations(root = managedMountRoot) {
  const reclaimed = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return reclaimed; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (isMountPoint(dir)) continue;
    const bytes = directorySize(dir);
    try {
      fs.rmSync(dir, { force: true, recursive: true });
      if (bytes > 0) reclaimed.push({ bytes, path: dir });
    } catch {}
  }
  return reclaimed;
}
function logReclaimed(reclaimed) {
  for (const entry of reclaimed) process.stdout.write(`[mos-backup-agent] reclaimed ${entry.bytes} bytes an interrupted backup left under ${entry.path}\n`);
}
async function listDestinations() {
  const lsblk = await execJson('lsblk', ['--json', '--bytes', '--output', 'NAME,PATH,LABEL,MODEL,TRAN,RM,TYPE,FSTYPE,UUID,SIZE,MOUNTPOINTS']);
  const candidates = new Map();
  function add(destination) { if (destination.id) candidates.set(destination.id, destination); }
  function visit(device, inheritedExternal = false) {
    const external = inheritedExternal || device.tran === 'usb' || device.rm === true || device.rm === 1 || device.rm === '1';
    const points = Array.isArray(device.mountpoints) ? device.mountpoints : [];
    const devicePath = device.path || (device.name ? `/dev/${device.name}` : null);
    const label = device.label || device.model || device.name || devicePath || 'Backup storage';
    let mounted = false;
    for (const point of points) {
      const mountPath = normalizeDestination(point);
      if (!mountPath) continue;
      mounted = true;
      const externalMount = external || mountPath.startsWith('/media/');
      add({ availableBytes: availableBytes(mountPath), canMount: false, devicePath, fileSystem: device.fstype || null, fsUuid: device.uuid || null, id: mountPath, label, mountPath, mountState: 'mounted', sizeBytes: Number(device.size) || null, storageKind: externalMount ? 'external' : 'local', transport: device.tran || (externalMount ? 'removable' : 'local'), writable: isWritable(mountPath) });
    }
    if (!mounted && (device.type !== 'disk' || isWholeDiskFilesystem(device))) {
      const blocked = mountBlockReason(device);
      add({ availableBytes: null, canMount: !blocked && !points.some(Boolean), devicePath, fileSystem: device.fstype || null, fsUuid: device.uuid || null, id: devicePath || label, label, mountBlockedReason: blocked, mountPath: points.find(Boolean) || null, mountState: points.some(Boolean) ? 'unsupported-mount' : 'unmounted', sizeBytes: Number(device.size) || null, storageKind: external ? 'external' : 'local', transport: device.tran || (external ? 'removable' : 'local'), writable: false });
    }
    for (const child of device.children || []) visit(child, external);
  }
  for (const device of lsblk?.blockdevices || []) visit(device);
  // `ready` is the single question every destination answers, so nothing above
  // this has to know that one kind proves itself by being mounted and another by
  // answering a request. A drive holding another server's backups is neither
  // ready nor a failure: it is one recovery key away from both.
  const disks = await Promise.all([...candidates.values()].filter((item) => item.mountState === 'mounted' || item.canMount === true)
    .map(async (item) => {
      const notReadyReason = item.mountState !== 'mounted'
        ? item.mountBlockedReason || 'This drive is not mounted.'
        : item.writable ? null : 'This drive is not writable.';
      const health = notReadyReason ? { locked: false } : await destinationResolver.resolve(item.id).health().catch(() => ({ locked: false }));
      return {
        ...item,
        borrowedKey: Boolean(guestKeys.keyFor(item.id)),
        kind: 'disk',
        locked: health.locked === true,
        notReadyReason: notReadyReason || (health.locked ? health.reason : null),
        ready: !notReadyReason && !health.locked,
      };
    }));
  const destinations = [...disks, ...await listObjectDestinations()];
  // Without the engine binary nothing can be written anywhere, so it is the
  // destination that is unusable, not the backup that failed. Reported last so
  // a drive that is also unplugged still says the thing the owner can fix.
  if (engine.installed()) return destinations;
  return destinations.map((item) => ({ ...item, notReadyReason: item.notReadyReason || ENGINE_MISSING_MESSAGE, ready: false }));
}
// Configured buckets are destinations whether or not they answer right now: an
// owner whose connection is down has to be able to see what they connected and
// why it is not usable, which dropping it from the list would take away.
async function listObjectDestinations() {
  const entries = [];
  for (const destination of destinationResolver.objectDestinations()) {
    const health = await destination.health().catch(() => ({ locked: false, ready: false, reason: 'MOS could not reach this storage.', usage: null }));
    entries.push({
      ...publicObjectDestination(destination.record),
      availableBytes: null,
      borrowedKey: Boolean(guestKeys.keyFor(destination.id)),
      canMount: false,
      checkedAt: health.checkedAt || null,
      kind: 'object',
      locked: health.locked === true,
      mountPath: null,
      notReadyReason: health.reason || null,
      ready: health.ready === true,
      repository: health.usage || null,
      sizeBytes: null,
      storageKind: 'object',
      writable: true,
    });
  }
  return entries;
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
function availableBytes(dir) {
  try { const stat = fs.statfsSync(dir); return stat.bavail * stat.bsize; } catch { return null; }
}
async function mountDestination(destinationId) {
  const destinations = await listDestinations();
  const destination = destinations.find((item) => item.id === destinationId);
  if (!destination) throw new Error('Selected drive is no longer available.');
  if (destination.mountState === 'mounted') return destination;
  if (!destination.canMount || !destination.devicePath) throw new Error(destination.mountBlockedReason || 'Selected drive cannot be mounted automatically.');
  const mountPath = path.join(managedMountRoot, sanitizeMountName(`${destination.label}-${path.basename(destination.devicePath)}`));
  // Whatever a previous run wrote here after the drive was pulled is on the
  // system disk, and mounting over it would hide it again.
  logReclaimed(reclaimUnmountedDestinations());
  ensureDir(mountPath);
  command('mount', [destination.devicePath, mountPath]);
  const mounted = (await listDestinations()).find((item) => item.devicePath === destination.devicePath && item.mountState === 'mounted');
  if (!mounted) throw new Error('The drive was mounted, but the backup agent could not verify it.');
  return mounted;
}
// A destination id names either a mount path or a configured bucket, and
// nothing else. A path that is not a mount path is refused because the
// directory outlives the mount: without this, a backup aimed at a drive that
// has been unplugged writes silently onto the system disk.
// Anything that backs up without being asked names this instead of a drive:
// only this agent knows which mounted destination is the primary right now,
// including a drive that came back on a different mount path.
const PRIMARY_DESTINATION = 'primary';
async function primaryBackupDestinationId() {
  const chosen = primary.read();
  if (!chosen) {
    throw Object.assign(new Error('No destination is set for automatic backups, so there is nowhere to write this backup.'), { code: 'NO_PRIMARY_DESTINATION' });
  }
  const mounted = (await listDestinations()).filter((destination) => destination.ready);
  const destination = primary.resolve(mounted);
  const absentCode = isObjectDestinationId(chosen.destinationId) ? 'DESTINATION_UNREACHABLE' : 'DESTINATION_ABSENT';
  if (!destination) throw Object.assign(new Error('The destination automatic backups are written to is not available right now.'), { code: absentCode });
  if (!destination.writable) throw Object.assign(new Error('The backup drive is connected but not writable.'), { code: absentCode });
  return destination.id;
}
function normalizeDestinationId(candidate) {
  const value = String(candidate || '');
  if (isObjectDestinationId(value)) return objectRegistry.get(value) ? value : null;
  return normalizeDestination(value);
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
  // A leftover backup in the retired tar format can be deleted but never read,
  // so the refusal happens here rather than after a job has been queued.
  if ((kind === 'restore' || kind === 'validate') && !isRestorePointPath(backupPath) && !parseObjectLocator(backupPath)) throw new Error(UNREADABLE_LEGACY_BACKUP);
  if (kind === 'restore' && payload.confirmation !== 'RESTORE') throw new Error('Type RESTORE to confirm this destructive restore.');
  const initiator = payload.initiator === 'schedule' || payload.initiator === 'update' ? payload.initiator : 'owner';
  const updateTarget = kind === 'backup' && initiator === 'update' ? String(payload.updateTarget || '').trim().slice(0, 60) : '';
  const job = { backupPath, createdAt: now, destinationId, error: null, id, initiator, kind, logs: [], outputPath: null, rescuePath: null, stage: 'queued', status: 'queued', updatedAt: now, ...(note ? { note } : {}), ...(updateTarget ? { updateTarget } : {}) };
  writeJson(jobPath(id), job);
  writeJson(currentJobPath, job);
  spawn(process.execPath, [__filename, '--worker', jobPath(id)], { cwd: repoDir, detached: true, env: process.env, stdio: 'ignore' }).unref();
  return job;
}
// A locator names one backup. On a drive it is the manifest file inside the
// destination's restore-points directory, and a directory holding a retired
// tar-format backup still resolves because deleting one is the only thing MOS
// can still do with it; in a bucket it is the storage connection and the
// restore point's id. Either way it must resolve to a destination this machine
// has, which is what stops a locator from the wire naming anything else.
//
// The field is still called backupPath on the wire and in job records: those
// records and the restore journal exist on installed machines, and renaming
// what they contain would be a migration with nothing to show for it.
function normalizeBackupLocator(candidate) {
  const value = String(candidate || '');
  const object = parseObjectLocator(value);
  if (object) return objectRegistry.get(object.destinationId) ? value : null;
  const resolved = path.resolve(value);
  if (!destinationRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))) return null;
  if (isRestorePointPath(resolved)) {
    if (!fs.existsSync(resolved) || !fs.existsSync(`${resolved}.sha256`)) return null;
    return resolved;
  }
  return fs.existsSync(path.join(resolved, 'manifest.json')) ? resolved : null;
}
function treeBytes(root) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) total += treeBytes(absolute);
      else if (entry.isFile()) total += fs.statSync(absolute).size;
    }
  } catch {}
  return total;
}
// Restore points are the only backups MOS can read. Backups left on a drive in
// the retired tar format are still listed, marked unrestorable: they occupy
// real space, and an owner who cannot see them cannot reclaim it.
async function listBackups(destinations) {
  const backups = [];
  // Read once for the whole listing: every restore point's estimate is drawn
  // from the same history and the same build timings.
  const history = jobHistory();
  const buildTimings = readBuildTimings(buildTimingsPath);
  const cpus = os.cpus().length;
  for (const entry of destinations) {
    if (entry.kind === 'disk' && !entry.mountPath) continue;
    if (entry.kind === 'object' && !entry.ready) continue;
    let destination;
    try {
      destination = destinationResolver.resolve(entry.id);
    } catch {
      continue;
    }
    if (entry.mountPath) backups.push(...legacyBundlesOn(entry));
    const descriptor = entry.mountPath ? readRepositoryDescriptor(entry.mountPath) : null;
    // A destination that will not answer contributes nothing rather than
    // failing the whole listing: one unreachable bucket must not hide the
    // backups on a drive that is plugged in right now.
    let points = [];
    try {
      points = await destination.points.summaries();
    } catch {}
    for (const point of points) {
      backups.push({
        ...point,
        destinationId: entry.id,
        destinationLabel: entry.label,
        encrypted: true,
        engineName: point.engineName || descriptor?.engineName || ENGINE_NAME,
        // What checking or restoring this point will take on this machine,
        // said in the owner's words before either is started.
        expect: {
          check: checkExpectation({ history, sizeBytes: point.sizeBytes }),
          restore: restoreExpectation({ apps: appsWithNames(point.apps), buildTimings, cpus, history, sizeBytes: point.sizeBytes }),
        },
        kind: 'restore-point',
        path: point.locator,
        repositoryId: descriptor?.repositoryId || entry.repository?.repositoryId || null,
        restorable: true,
      });
    }
  }
  return backups.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
}
function legacyBundlesOn(destination) {
  const found = [];
  const root = path.join(destination.mountPath, 'MOS-backups');
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const legacyPath = path.join(root, entry.name);
    try {
      const manifest = readJson(path.join(legacyPath, 'manifest.json'));
      let note = null;
      try { note = fs.readFileSync(path.join(legacyPath, 'note.txt'), 'utf8').trim() || null; } catch {}
      found.push({ appCount: manifest.contents?.apps?.length || 0, createdAt: manifest.backup?.createdAt || null, destinationId: destination.id, destinationLabel: destination.label, encrypted: false, id: manifest.backup?.id || entry.name, kind: 'legacy-bundle', note, path: legacyPath, restorable: false, schemaVersion: manifest.backup?.schemaVersion || null, sizeBytes: treeBytes(legacyPath), sourceCommit: manifest.source?.commit || null, sourceVersion: manifest.source?.version || null, volumeCount: manifest.contents?.volumes?.length || 0 });
    } catch {}
  }
  return found;
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
  updateJob(file, (job) => { advanceTimeline(job, name); job.stage = name; job.status = 'running'; }, { count: null });
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
    return store.getAppInstances().filter((instance) => instance.status !== 'uninstalled').map((instance) => {
      if (instance.snapshotState !== 'installed' || !instance.snapshotPath || !instance.packageDigest) throw new Error(`Installed package snapshot is unavailable for ${instance.packageId}.`);
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
    return store.getAppInstances().filter((instance) => instance.status !== 'uninstalled').map((instance) => ({ enabled: instance.enabled === true || instance.enabled === 1, instanceId: instance.id, packageId: instance.packageId }));
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
  assumeArchiveKey: async (destinationId) => {
    const key = guestKeys.keyFor(destinationId);
    if (!key) return false;

    try {
      const rekeyed = await vaultAgent.rekey(key);
      if (!rekeyed.ok) return { ok: false, reason: rekeyed.reason || 'rekey-failed' };
    } catch (error) {
      return { ok: false, reason: error?.code === 'VAULT_AGENT_UNAVAILABLE' ? 'vault-agent-unavailable' : 'rekey-failed' };
    }

    engine.adoptRecoveryKey(key);
    keyStore.adopt(recoveryKeyFingerprint(key));
    guestKeys.forget(destinationId);
    destinationResolver.forgetAll();
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
    legacyKeyPresent: Boolean(engine.legacyKey()),
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
    ...(await listDestinations()).filter((entry) => entry.kind === 'disk' && entry.mountState === 'mounted').map((entry) => ({ kind: 'drive', label: entry.label })),
    ...objectRegistry.list().map((record) => ({ bucket: record.bucket, endpoint: record.endpoint, folder: record.folder || '', kind: 'bucket', label: record.label, region: record.region || '' })),
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

// What a rotation can reach right now: the drives that are plugged in and the
// buckets that are configured. A drive in a drawer is deliberately not here —
// it is the reason a rotation reports what it could not finish, rather than
// claiming a key change that a copy in a drawer knows nothing about.
async function attachedDestinations() {
  const mounted = (await listDestinations())
    .filter((entry) => entry.kind === 'disk' && entry.mountState === 'mounted')
    .map((entry) => destinationResolver.resolve(entry.id));
  return [...mounted, ...destinationResolver.objectDestinations()];
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
// is checked against the destination and then kept on this machine, against
// that destination, and handed to the engine for every command aimed at it.
// Nothing is written into the archive — not its contents and not its key list:
// it belongs to the server that made it, and connecting to something is not a
// reason to alter it. Becoming that server is a separate act, and it happens at
// restore, where the owner has said this machine is taking the other one's
// place.
async function unlockDestination(body) {
  const normalized = normalizeRecoveryKey(body.recoveryKey);
  if (normalized.error) throw Object.assign(new Error(normalized.error), { code: 'RECOVERY_KEY_MISTYPED' });
  const destinationId = normalizeDestinationId(body.destinationId);
  if (!destinationId) throw new Error('Choose a connected drive or a storage connection to unlock.');
  const destination = destinationResolver.resolve(destinationId);
  const spec = destination.repositorySpec();
  const probe = await engine.probeRepository({ ...spec, noun: destination.noun, password: normalized.key });
  if (probe.state === 'locked') throw new Error(`That key does not open the backups in this ${destination.noun}.`);
  if (probe.state === 'absent') throw new Error(`This ${destination.noun} holds no MOS backups yet, so there is nothing here to unlock.`);
  if (probe.state !== 'open') throw new Error(probe.message || `MOS could not reach this ${destination.noun}.`);
  guestKeys.save(destinationId, normalized.key);
  destinationResolver.forget(destinationId);
  return {
    message: `Unlocked. MOS keeps this key to open this ${destination.noun} and changed nothing in it.`,
    recoveryKey: recoveryKeyStatus(),
  };
}

// Which keys open an archive, and taking one back out.
//
// An owner is entitled to know who can read their backups and to end that
// access, and MOS is the only place that can tell them without a terminal.
// Both need the key of the server that owns the archive, because restic will
// not list or change a key list for anyone who cannot already open it — which
// is also what stops this from being a way to lock someone else out.
async function archiveKeys(body) {
  const { destination, key, repository } = await openWithEnteredKey(body);
  const entries = engine.keyList({ password: key, repository });
  return {
    keys: entries.map((entry) => ({
      createdAt: entry.created || null,
      current: entry.current === true,
      hostname: entry.hostName || null,
      id: entry.id,
      username: entry.userName || null,
    })),
    noun: destination.noun,
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
  const destinationId = normalizeDestinationId(body.destinationId);
  if (!destinationId) throw new Error('Choose a connected drive or a storage connection.');
  const destination = destinationResolver.resolve(destinationId);
  const spec = destination.repositorySpec();
  const probe = await engine.probeRepository({ ...spec, noun: destination.noun, password: normalized.key });
  if (probe.state !== 'open') throw new Error(probe.state === 'locked' ? `That key does not open the backups in this ${destination.noun}.` : probe.message || `MOS could not reach this ${destination.noun}.`);
  return { destination, key: normalized.key, repository: { engineName: engine.name, ...spec, password: undefined } };
}

// Forgetting a borrowed key. The archive is untouched by this too: the key
// stops being on this machine, and the destination goes back to needing it
// entered.
function forgetGuestKey(body) {
  const destinationId = normalizeDestinationId(body.destinationId);
  if (!destinationId) throw new Error('Choose a destination.');
  const forgotten = guestKeys.forget(destinationId);
  destinationResolver.forget(destinationId);
  return { forgotten };
}

// What the schedule needs to know about a destination's restore points: when
// each was taken and whether the schedule itself took it. Asked of the
// destination rather than taken from listBackups, because retention must not
// depend on which drives happen to be mounted.
async function scheduledRestorePoints(destinationId) {
  const points = await destinationResolver.resolve(destinationId).points.summaries();
  return points.map((point) => ({ automatic: point.automatic, createdAt: point.createdAt, initiator: point.initiator, path: point.locator }));
}

const keyStore = new RecoveryKeyStore({ stateDir: agentStateDir });
const knownDrives = new KnownDrives({ agentStateDir });
const progressPublisher = new ProgressPublisher({ dir: statusDir, filename: PROGRESS_FILENAME });
const engine = createEngine({ agentStateDir, keys: keyStore, onKeyUsed: () => keyStore.noteFirstUse() });
const objectRegistry = new ObjectDestinationRegistry({ agentStateDir });
const backupSystem = new BackupSystemAdapter({ agentStateDir, repoDir, stateDir, stateRoot });
const guestKeys = new GuestKeyStore({ agentStateDir });
// Only ever asked to rekey the disk at the end of a takeover restore. A machine
// with no vault answers that there was nothing to do.
const vaultAgent = new VaultAgentClient({ socketPath: process.env.MOS_VAULT_AGENT_SOCKET || '/run/mos-vault-agent/agent.sock' });
const destinationResolver = new DestinationResolver({ agentStateDir, engine, guestKeys, objectRegistry, system: backupSystem });
// Both agents run as root under the same unit template, so this agent can ask
// the update agent what it is doing over its socket the way Suite Manager does.
const updateAgent = new UpdateAgentClient();

// A drive is identified by the descriptor MOS wrote beside its repository; a
// bucket by the repository's own id, which the connection settings can be
// re-entered around without becoming a different destination.
function destinationRepositoryId(destinationId) {
  if (!destinationId) return null;
  if (isObjectDestinationId(destinationId)) return destinationResolver.resolve(destinationId).descriptorRepositoryId();
  return readRepositoryDescriptor(destinationId)?.repositoryId || null;
}

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

const primary = new PrimaryDestination({ agentStateDir, repositoryId: destinationRepositoryId });

const scheduler = new BackupScheduler({
  agentStateDir,
  createJob: (kind, payload) => createJob(kind, payload),
  destinations: async () => (await listDestinations()).filter((destination) => destination.ready),
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
  jobs: { log, progress, stage, update: updateJob },
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
  ensureDir(path.dirname(socketPath));
  ensureDir(agentStateDir);
  ensureDir(jobsDir);
  // Before anything can ask for it: the screen has to be able to show an owner
  // their recovery key before a backup exists, and a machine coming off the
  // pre-release password gets one the same moment.
  engine.migrateLegacyKey();
  engine.recoveryKey();
  installId();
  // A worker that died with the machine never cleared the file the busy page
  // reads; the next agent start is the first moment anything can.
  if (!isActive(reconcileCurrentJob())) progressPublisher.clear();
  fs.rmSync(socketPath, { force: true });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        const attached = (await listDestinations()).map((destination) => (
          destination.mountPath ? { ...destination, repository: repositoryUsage(destination.mountPath) } : destination
        ));
        const backups = await listBackups(attached);
        // A drive that is not plugged in is the one backup an attacker on this
        // machine cannot reach, so it is worth more said than unsaid. It is
        // listed from what MOS recorded while it was here, and it is the only
        // entry in this list that describes something MOS cannot currently see.
        const away = knownDrives.reconcile({
          attached: attached.filter((destination) => destination.kind === 'disk'),
          lastBackupAt: (id) => backups.find((backup) => backup.destinationId === id)?.createdAt || null,
        }).map((drive) => ({
          availableBytes: null,
          fsUuid: drive.fsUuid,
          id: drive.id,
          kind: 'disk',
          label: drive.label,
          lastBackupAt: drive.lastBackupAt,
          lastSeenAt: drive.lastSeenAt,
          locked: false,
          mountPath: null,
          mountState: 'away',
          notReadyReason: 'This drive is not plugged in.',
          ready: false,
          sizeBytes: null,
          storageKind: 'external',
          writable: false,
        }));
        const destinations = [...attached, ...away];
        respond(response, 200, {
          backups,
          capabilities: { backups: ['create', 'delete', 'list', 'schedule', 'validate'], destinations: ['connect-object', 'forget-drive', 'list', 'mount', 'primary'], recoveryKey: ['acknowledge', 'forget-key', 'keys', 'reveal', 'rotate', 'unlock'], restores: ['acknowledge-interruption', 'apply', 'list'], storage: { engine: ENGINE_NAME, model: 'engine-repository' } },
          currentJob: summarizeJob(reconcileCurrentJob()),
          destinations,
          // Named so the screen can say which machine wrote a restore point, and
          // stay quiet about the ones this machine wrote itself.
          hostname: os.hostname(),
          installId: installId(),
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
        const destinationId = normalizeDestinationId(body.destinationId);
        if (!destinationId) throw new Error('Choose a connected drive or a storage connection for automatic backups.');
        const known = (await listDestinations()).find((destination) => destination.id === destinationId);
        respond(response, 200, { primaryDestination: primary.save({ destinationId, label: known?.label || null }) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/mount') { respond(response, 200, { destination: await mountDestination((await readBody(request)).destinationId) }); return; }
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
      if (request.method === 'POST' && url.pathname === '/v1/destinations/unlock') {
        respond(response, 200, { result: await unlockDestination(await readBody(request)) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/keys') {
        respond(response, 200, { result: await archiveKeys(await readBody(request)) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/keys/remove') {
        respond(response, 200, { result: await removeArchiveKey(await readBody(request)) });
        return;
      }
      // A drive the owner has finished with. Only the memory of it goes: MOS
      // never writes to a drive that is not here, so nothing on the drive
      // itself changes and plugging it back in lists it again.
      if (request.method === 'POST' && url.pathname === '/v1/destinations/forget-drive') {
        const body = await readBody(request);
        knownDrives.forget(String(body.fsUuid || ''));
        respond(response, 200, { forgotten: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/forget-key') {
        respond(response, 200, { result: forgetGuestKey(await readBody(request)) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/object') {
        const record = objectRegistry.save(await readBody(request));
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
        const requested = body.destinationId === PRIMARY_DESTINATION ? await primaryBackupDestinationId() : body.destinationId;
        const destinationId = normalizeDestinationId(requested);
        if (destinationId) await destinationResolver.resolve(destinationId).assertAvailable();
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
        const note = String(body.note || '').trim().slice(0, 500);
        const { destination, kind, pointId } = core.resolveBackup(locator);
        // A retired-format backup keeps its note as a file inside its own
        // folder, which is where the MOS that wrote it put one.
        if (kind === 'legacy-bundle') {
          const notePath = path.join(locator, 'note.txt');
          if (note) fs.writeFileSync(notePath, `${note}\n`, 'utf8');
          else fs.rmSync(notePath, { force: true });
        } else {
          await destination.points.writeNote(pointId, note);
        }
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
        respond(response, 202, { job: createJob('delete', await readBody(request)) });
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
  // Before the socket opens, so nothing can mount over a leftover first.
  logReclaimed(reclaimUnmountedDestinations());
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o660);
    process.stdout.write('[mos-backup-agent] ready\n');
    // A machine that was off through its backup window owes a run; the early
    // tick is what makes it happen shortly after boot rather than a day later.
    setTimeout(() => { void scheduler.tick().catch(() => {}); }, 10_000).unref();
    scheduler.start();
  });
  function shutdown() { scheduler.stop(); server.close(() => { fs.rmSync(socketPath, { force: true }); process.exit(0); }); }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { isMountPoint, isWholeDiskFilesystem, mountBlockReason, RECOVERY_KEY_GATED_ROUTES, RECOVERY_KEY_UNACKNOWLEDGED, reclaimUnmountedDestinations, packageBackupInventory, sha256, validatePackagePayloads };
