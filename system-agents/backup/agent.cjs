#!/usr/bin/env node

// Host wiring for the MOS backup agent: destination discovery, the job store,
// the unix-socket API, and the worker process entry. The backup/restore
// engine itself lives in agent-core.cjs behind injected adapters so its
// guarantees (rescue copy, absence reconciliation, journal, verification)
// are covered by unit tests instead of only Hyper-V drills.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { BackupAgentCore, COMPLETE_MARKER, isRestorePointPath, sha256, validatePackagePayloads } = require('./agent-core.cjs');
const { BackupSystemAdapter } = require('./system-adapter.cjs');
const { createEngine, engineNameFromEnv, readRepositoryDescriptor, restorePointsDir } = require('./engines/engine.cjs');
const { AppAgentClient } = require('../../suite-manager/backend/src/apps/app-agent-client.cjs');
const { AppPackageService } = require('../../suite-manager/backend/src/apps/app-package-service.cjs');
const { collectPackageFiles, verifySnapshotIdentity } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
const { SuiteManagerStore } = require('../../suite-manager/backend/src/state/suite-manager-store.cjs');

const socketPath = process.env.MOS_BACKUP_AGENT_SOCKET || '/run/mos-backup-agent/agent.sock';
const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
const stateDir = process.env.MOS_STATE_DIR || path.join(stateRoot, 'suite-manager');
const repoDir = process.env.MOS_REPO_DIR || path.resolve(__dirname, '..', '..');
const agentStateDir = process.env.MOS_BACKUP_AGENT_STATE_DIR || path.join(stateRoot, 'backup-agent');
const bootstrapContractPath = path.join(stateRoot, 'bootstrap-contract.env');
const jobsDir = path.join(agentStateDir, 'jobs');
const currentJobPath = path.join(agentStateDir, 'current-job.json');
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
function isSystemMountpoint(mountpoint) {
  const resolved = path.resolve(String(mountpoint || ''));
  return resolved === '/' || resolved === '/boot' || resolved === '/boot/efi' || resolved === '/var' || resolved === '/var/lib' || resolved.startsWith('/var/lib/docker/');
}
function mountBlockReason(device) {
  const fileSystem = String(device.fstype || '').toLowerCase();
  if (device.type !== 'part') return 'Choose a data partition, not the whole device.';
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
async function listDestinations() {
  const lsblk = await execJson('lsblk', ['--json', '--bytes', '--output', 'NAME,PATH,LABEL,MODEL,TRAN,RM,TYPE,FSTYPE,SIZE,MOUNTPOINTS']);
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
      add({ availableBytes: availableBytes(mountPath), canMount: false, devicePath, fileSystem: device.fstype || null, id: mountPath, label, mountPath, mountState: 'mounted', sizeBytes: Number(device.size) || null, storageKind: externalMount ? 'external' : 'local', transport: device.tran || (externalMount ? 'removable' : 'local'), writable: isWritable(mountPath) });
    }
    if (!mounted && device.type !== 'disk') {
      const blocked = mountBlockReason(device);
      add({ availableBytes: null, canMount: !blocked && !points.some(Boolean), devicePath, fileSystem: device.fstype || null, id: devicePath || label, label, mountBlockedReason: blocked, mountPath: points.find(Boolean) || null, mountState: points.some(Boolean) ? 'unsupported-mount' : 'unmounted', sizeBytes: Number(device.size) || null, storageKind: external ? 'external' : 'local', transport: device.tran || (external ? 'removable' : 'local'), writable: false });
    }
    for (const child of device.children || []) visit(child, external);
  }
  for (const device of lsblk?.blockdevices || []) visit(device);
  return [...candidates.values()].filter((item) => item.mountState === 'mounted' || item.canMount === true);
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
  ensureDir(mountPath);
  command('mount', [destination.devicePath, mountPath]);
  const mounted = (await listDestinations()).find((item) => item.devicePath === destination.devicePath && item.mountState === 'mounted');
  if (!mounted) throw new Error('The drive was mounted, but the backup agent could not verify it.');
  return mounted;
}
// A destination is a mount path; the directory outlives the mount, so path
// checks alone would happily aim a backup at the system disk after the drive
// disappears. Only a currently mounted, writable destination is acceptable.
async function assertMountedDestination(destinationId) {
  const mounted = (await listDestinations()).find((item) => item.mountState === 'mounted' && item.mountPath === destinationId);
  if (!mounted) throw new Error('The selected backup drive is not mounted anymore. Reconnect it, click Refresh drives, and try again.');
  if (!mounted.writable) throw new Error('The selected backup drive is not writable.');
  return mounted;
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
function summarizeJob(job) {
  if (!job) return null;
  return { backupPath: job.backupPath || null, destinationId: job.destinationId || null, error: job.error || null, id: job.id, kind: job.kind || null, logs: Array.isArray(job.logs) ? job.logs.slice(-20) : [], outputPath: job.outputPath || null, rescuePath: job.rescuePath || null, stage: job.stage || null, status: job.status || null, summary: job.summary || null, updatedAt: job.updatedAt || null, validation: job.validation || null, verification: job.verification || null };
}
function isActive(job) { return job && (job.status === 'queued' || job.status === 'running'); }
function jobPath(id) { return path.join(jobsDir, `${id}.json`); }
function createJob(kind, payload) {
  if (isActive(reconcileCurrentJob())) throw new Error('A backup or restore job is already running.');
  const interrupted = core.interruptedRestore();
  // Validation and upload never touch the running suite, so they stay
  // available while an interrupted restore blocks destructive work — checking
  // or bringing in a bundle is part of recovery.
  if (interrupted && kind !== 'validate' && kind !== 'upload') throw new Error(`A restore did not complete (stopped during "${interrupted.phase}"). Acknowledge it before starting new backup or restore work; the pre-restore rescue copy is at ${interrupted.rescuePath || 'the backup agent state directory'}.`);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const destinationId = kind === 'backup' || kind === 'upload' ? normalizeDestination(payload.destinationId) : null;
  const backupPath = kind === 'restore' || kind === 'validate' || kind === 'delete' ? normalizeBundlePath(payload.backupPath) : null;
  const uploadPath = kind === 'upload' ? path.resolve(String(payload.uploadPath || '')) : null;
  const note = kind === 'backup' ? String(payload.note || '').trim().slice(0, 500) : '';
  if ((kind === 'backup' || kind === 'upload') && !destinationId) throw new Error('Choose a mounted destination under /media, /mnt, or /run/media.');
  if ((kind === 'restore' || kind === 'validate' || kind === 'delete') && !backupPath) throw new Error('Choose a detected backup bundle from mounted storage.');
  if (kind === 'upload' && (!uploadPath.startsWith(`${destinationId}${path.sep}`) || !fs.existsSync(uploadPath))) throw new Error('The uploaded file is no longer available on the destination.');
  if (kind === 'restore' && payload.confirmation !== 'RESTORE') throw new Error('Type RESTORE to confirm this destructive restore.');
  const job = { backupPath, createdAt: now, destinationId, error: null, id, initiator: payload.initiator || 'owner', kind, logs: [], outputPath: null, rescuePath: null, stage: 'queued', status: 'queued', updatedAt: now, ...(uploadPath ? { uploadPath } : {}), ...(note ? { note } : {}) };
  writeJson(jobPath(id), job);
  writeJson(currentJobPath, job);
  spawn(process.execPath, [__filename, '--worker', jobPath(id)], { cwd: repoDir, detached: true, env: process.env, stdio: 'ignore' }).unref();
  return job;
}
// One opaque locator covers both storage kinds: a restore point is its
// manifest file inside the destination's restore-points directory, a legacy
// bundle is its directory. Either way the locator must resolve under mounted
// storage and name something complete.
function normalizeBundlePath(candidate) {
  const resolved = path.resolve(String(candidate || ''));
  if (!destinationRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))) return null;
  if (isRestorePointPath(resolved)) {
    if (!fs.existsSync(resolved) || !fs.existsSync(`${resolved}.sha256`)) return null;
    return resolved;
  }
  if (!fs.existsSync(path.join(resolved, 'manifest.json'))) return null;
  if (!fs.existsSync(path.join(resolved, COMPLETE_MARKER))) return null;
  return resolved;
}
function notePathFor(backupPath) {
  return isRestorePointPath(backupPath) ? `${backupPath}.note.txt` : path.join(backupPath, 'note.txt');
}
// An operator note is a sidecar file, never part of the checksummed manifest
// or the downloadable archive — it annotates this destination's copy without
// touching backup integrity.
function readNote(backupPath) {
  try {
    const note = fs.readFileSync(notePathFor(backupPath), 'utf8').trim();
    return note || null;
  } catch { return null; }
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
// Restore points and legacy bundles are listed together and typed, so the UI
// can be honest about what each one can still do: a bundle is a file an owner
// can download, a restore point is data inside the destination's repository.
function listBundles(destinations) {
  const backups = [];
  for (const destination of destinations) {
    if (!destination.mountPath) continue;
    const root = path.join(destination.mountPath, 'MOS-backups');
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bundlePath = path.join(root, entry.name);
      try {
        if (!fs.existsSync(path.join(bundlePath, COMPLETE_MARKER))) continue;
        if (!fs.existsSync(path.join(bundlePath, 'bundle.tar.gz'))) continue;
        const manifest = readJson(path.join(bundlePath, 'manifest.json'));
        backups.push({ appCount: manifest.contents?.apps?.length || 0, archivePath: path.join(bundlePath, 'bundle.tar.gz'), createdAt: manifest.backup?.createdAt || null, destinationId: destination.id, destinationLabel: destination.label, downloadable: true, encrypted: false, id: manifest.backup?.id || entry.name, kind: 'bundle', note: readNote(bundlePath), path: bundlePath, schemaVersion: manifest.backup?.schemaVersion || null, sizeBytes: treeBytes(bundlePath), sourceCommit: manifest.source?.commit || null, sourceVersion: manifest.source?.version || null, volumeCount: manifest.contents?.volumes?.length || 0 });
      } catch {}
    }
    const descriptor = readRepositoryDescriptor(destination.mountPath);
    const pointsDir = restorePointsDir(destination.mountPath);
    if (!fs.existsSync(pointsDir)) continue;
    for (const name of fs.readdirSync(pointsDir)) {
      if (!name.endsWith('.json')) continue;
      const manifestPath = path.join(pointsDir, name);
      try {
        if (!fs.existsSync(`${manifestPath}.sha256`)) continue;
        const manifest = readJson(manifestPath);
        const volumes = manifest.contents?.volumes || [];
        const rawBytes = (manifest.contents?.stateRawBytes || 0) + volumes.reduce((sum, volume) => sum + (volume.rawBytes || 0), 0);
        backups.push({ appCount: manifest.contents?.apps?.length || 0, archivePath: null, createdAt: manifest.backup?.createdAt || null, destinationId: destination.id, destinationLabel: destination.label, downloadable: false, encrypted: true, engineName: manifest.backup?.engine || descriptor?.engineName || null, id: manifest.backup?.id || path.basename(name, '.json'), kind: 'restore-point', note: readNote(manifestPath), path: manifestPath, repositoryId: descriptor?.repositoryId || null, schemaVersion: manifest.backup?.schemaVersion || null, sizeBytes: rawBytes, sourceCommit: manifest.source?.commit || null, sourceVersion: manifest.source?.version || null, volumeCount: volumes.length });
      } catch {}
    }
  }
  return backups.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
}
function updateJob(file, mutator) {
  const job = readJson(file);
  mutator(job);
  job.updatedAt = new Date().toISOString();
  writeJson(file, job);
  writeJson(currentJobPath, job);
  return job;
}
function log(file, message) { updateJob(file, (job) => { job.logs.push({ at: new Date().toISOString(), message }); }); }
function stage(file, name) { updateJob(file, (job) => { job.stage = name; job.status = 'running'; }); log(file, name); }
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
function readBootstrapContract() {
  if (!fs.existsSync(bootstrapContractPath)) return {};
  return Object.fromEntries(fs.readFileSync(bootstrapContractPath, 'utf8').split(/\r?\n/u).map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (!match) return null;
    return [match[1], match[2].trim().replace(/^['"]|['"]$/gu, '')];
  }).filter(Boolean));
}
function restoreBaseUrl() {
  const contract = readBootstrapContract();
  if (process.env.MOS_HOME_HOST) return { homeHost: process.env.MOS_HOME_HOST, scheme: 'http' };
  if (contract.MOS_HOME_URL) {
    try {
      const parsed = new URL(contract.MOS_HOME_URL);
      return { homeHost: parsed.hostname, scheme: parsed.protocol === 'https:' ? 'https' : 'http' };
    } catch {}
  }
  if (contract.MOS_DOMAIN) return { homeHost: `home.${contract.MOS_DOMAIN}`, scheme: 'http' };
  return { homeHost: 'home.mos.home', scheme: 'http' };
}
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
async function reconcileRestoredApps(logMessage) {
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
    for (const instance of instances) {
      logMessage(`Restoring ${instance.displayNameSnapshot || instance.packageId}`);
      await appPackages.enablePackage(instance.packageId, restoreRequestContext(instance.packageId));
    }
  } finally {
    store.close();
  }
}

const core = new BackupAgentCore({
  apps: { installedInstances: installedAppInstances, reconcile: reconcileRestoredApps },
  engine: createEngine({ agentStateDir, name: engineNameFromEnv() }),
  jobs: { log, stage, update: updateJob },
  packages: { inventory: packageBackupInventory, validatePayloads: validatePackagePayloads },
  paths: { agentStateDir, stateDir, stateRoot },
  system: new BackupSystemAdapter({ agentStateDir, repoDir, stateDir, stateRoot }),
});

if (require.main === module && process.argv[2] === '--worker') {
  (async () => {
    try {
      const file = process.argv[3];
      const job = readJson(file);
      if (job.kind === 'restore') await core.restore(file);
      else if (job.kind === 'validate') await core.validateBackup(file);
      else if (job.kind === 'upload') await core.importBundle(file);
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
  fs.rmSync(socketPath, { force: true });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        const destinations = await listDestinations();
        respond(response, 200, {
          backups: listBundles(destinations),
          capabilities: { backups: ['create', 'delete', 'download', 'list', 'upload', 'validate'], destinations: ['list', 'mount'], restores: ['acknowledge-interruption', 'apply', 'list'], storage: { engine: engineNameFromEnv(), model: 'engine-repository' } },
          currentJob: summarizeJob(reconcileCurrentJob()),
          destinations,
          interruptedRestore: core.interruptedRestore(),
          lastJob: summarizeJob(latestJob()),
          service: 'mos-backup-agent',
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/mount') { respond(response, 200, { destination: await mountDestination((await readBody(request)).destinationId) }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/backups') {
        const body = await readBody(request);
        const destination = normalizeDestination(body.destinationId);
        if (destination) await assertMountedDestination(destination);
        respond(response, 202, { job: createJob('backup', body) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/backups/upload') {
        // Raw octet stream, not JSON: the body is the downloaded bundle
        // archive itself, saved onto the destination before an `upload` job
        // unpacks and validates it.
        const destinationId = normalizeDestination(url.searchParams.get('destinationId'));
        if (!destinationId) { respond(response, 400, { code: 'INVALID_DESTINATION', error: 'Choose a mounted, writable destination under /media, /mnt, or /run/media.' }); return; }
        await assertMountedDestination(destinationId);
        if (isActive(reconcileCurrentJob())) { respond(response, 409, { code: 'JOB_ACTIVE', error: 'A backup or restore job is already running.' }); return; }
        const contentLength = Number.parseInt(request.headers['content-length'] || '', 10);
        if (!Number.isFinite(contentLength) || contentLength <= 0) { respond(response, 411, { code: 'LENGTH_REQUIRED', error: 'The upload needs a known file size.' }); return; }
        // The stored file and its unpacked copy both land on the destination.
        const free = availableBytes(destinationId);
        if (free !== null && free < contentLength * 2) { respond(response, 409, { code: 'NO_SPACE', error: 'The destination does not have enough free space to store and unpack this upload.' }); return; }
        const uploadRoot = path.join(destinationId, 'MOS-backups');
        ensureDir(uploadRoot);
        const uploadPath = path.join(uploadRoot, `.upload-${crypto.randomUUID().slice(0, 8)}.tar.gz`);
        try {
          await new Promise((resolve, reject) => {
            const sink = fs.createWriteStream(uploadPath, { flags: 'wx' });
            request.on('error', reject);
            sink.on('error', reject);
            sink.on('finish', resolve);
            request.pipe(sink);
          });
          respond(response, 202, { job: createJob('upload', { destinationId, uploadPath }) });
        } catch (error) {
          fs.rmSync(uploadPath, { force: true });
          throw error;
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/backups/validate') { respond(response, 202, { job: createJob('validate', await readBody(request)) }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/backups/note') {
        const body = await readBody(request);
        const backupPath = normalizeBundlePath(body.backupPath);
        if (!backupPath) { respond(response, 400, { code: 'INVALID_BUNDLE', error: 'Choose a detected backup bundle from mounted storage.' }); return; }
        const note = String(body.note || '').trim().slice(0, 500);
        const notePath = notePathFor(backupPath);
        if (note) fs.writeFileSync(notePath, `${note}\n`, 'utf8');
        else fs.rmSync(notePath, { force: true });
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
      respond(response, 409, { code: 'BACKUP_AGENT_ERROR', error: error instanceof Error ? error.message : 'Backup agent operation failed.' });
    }
  });
  server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o660); process.stdout.write('[mos-backup-agent] ready\n'); });
  function shutdown() { server.close(() => { fs.rmSync(socketPath, { force: true }); process.exit(0); }); }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { packageBackupInventory, sha256, validatePackagePayloads };
