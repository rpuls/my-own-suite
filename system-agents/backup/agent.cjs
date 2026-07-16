#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { AppAgentClient } = require('../../suite-manager/backend/src/apps/app-agent-client.cjs');
const { AppPackageService } = require('../../suite-manager/backend/src/apps/app-package-service.cjs');
const { collectPackageFiles, verifySnapshotIdentity } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
const { SuiteManagerStore } = require('../../suite-manager/backend/src/state/suite-manager-store.cjs');

const socketPath = process.env.MOS_V2_BACKUP_AGENT_SOCKET || '/run/mos-v2-backup-agent/agent.sock';
const stateRoot = process.env.MOS_V2_STATE_ROOT || '/var/lib/mos-v2';
const stateDir = process.env.MOS_V2_STATE_DIR || path.join(stateRoot, 'suite-manager');
const repoDir = process.env.MOS_V2_REPO_DIR || path.resolve(__dirname, '..', '..');
const agentStateDir = process.env.MOS_V2_BACKUP_AGENT_STATE_DIR || path.join(stateRoot, 'backup-agent');
const bootstrapContractPath = path.join(stateRoot, 'bootstrap-contract.env');
const jobsDir = path.join(agentStateDir, 'jobs');
const currentJobPath = path.join(agentStateDir, 'current-job.json');
const managedMountRoot = '/media/mos-v2-backup';
const destinationRoots = ['/media', '/mnt', '/run/media'];
const mountableFileSystems = new Set(['exfat', 'ext2', 'ext3', 'ext4', 'ntfs', 'ntfs3', 'vfat', 'xfs', 'btrfs']);
const caddyFiles = ['/etc/caddy/Caddyfile', '/etc/caddy/mos-v2-homepage-routes.caddy', '/etc/caddy/mos-v2-app-routes.caddy'];
const httpsSecret = '/etc/mos-v2/secrets/caddy-cloudflare.env';
const completeMarker = 'COMPLETE';

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
function optionalCommand(file, args, options = {}) {
  try { return command(file, args, options); } catch { return null; }
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
function listJobFiles() {
  ensureDir(jobsDir);
  return fs.readdirSync(jobsDir).filter((name) => name.endsWith('.json')).map((name) => path.join(jobsDir, name));
}
function readCurrentJob() { try { return fs.existsSync(currentJobPath) ? readJson(currentJobPath) : null; } catch { return null; } }
function latestJob() {
  return listJobFiles().map((file) => { try { const job = readJson(file); return { job, time: new Date(job.updatedAt || job.createdAt || 0).getTime() }; } catch { return null; } })
    .filter(Boolean).sort((left, right) => right.time - left.time)[0]?.job || null;
}
function summarizeJob(job) {
  if (!job) return null;
  return { backupPath: job.backupPath || null, destinationId: job.destinationId || null, error: job.error || null, id: job.id, kind: job.kind || null, logs: Array.isArray(job.logs) ? job.logs.slice(-20) : [], outputPath: job.outputPath || null, rescuePath: job.rescuePath || null, stage: job.stage || null, status: job.status || null, updatedAt: job.updatedAt || null };
}
function isActive(job) { return job && (job.status === 'queued' || job.status === 'running'); }
function jobPath(id) { return path.join(jobsDir, `${id}.json`); }
function createJob(kind, payload) {
  if (isActive(readCurrentJob())) throw new Error('A backup or restore job is already running.');
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const destinationId = kind === 'backup' ? normalizeDestination(payload.destinationId) : null;
  const backupPath = kind === 'restore' ? normalizeBundlePath(payload.backupPath) : null;
  if (kind === 'backup' && !destinationId) throw new Error('Choose a mounted destination under /media, /mnt, or /run/media.');
  if (kind === 'restore' && !backupPath) throw new Error('Choose a detected backup bundle from mounted storage.');
  if (kind === 'restore' && payload.confirmation !== 'RESTORE') throw new Error('Type RESTORE to confirm this destructive restore.');
  const job = { backupPath, createdAt: now, destinationId, error: null, id, initiator: payload.initiator || 'owner', kind, logs: [], outputPath: null, rescuePath: null, stage: 'queued', status: 'queued', updatedAt: now };
  writeJson(jobPath(id), job);
  writeJson(currentJobPath, job);
  spawn(process.execPath, [__filename, '--worker', jobPath(id)], { cwd: repoDir, detached: true, env: process.env, stdio: 'ignore' }).unref();
  return job;
}
function normalizeBundlePath(candidate) {
  const resolved = path.resolve(String(candidate || ''));
  if (!destinationRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))) return null;
  if (!fs.existsSync(path.join(resolved, 'manifest.json'))) return null;
  if (!fs.existsSync(path.join(resolved, completeMarker))) return null;
  return resolved;
}
function listBundles(destinations) {
  const bundles = [];
  for (const destination of destinations) {
    if (!destination.mountPath) continue;
    const root = path.join(destination.mountPath, 'MOS-v2-backups');
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bundlePath = path.join(root, entry.name);
      try {
        if (!fs.existsSync(path.join(bundlePath, completeMarker))) continue;
        if (!fs.existsSync(path.join(bundlePath, 'bundle.tar.gz'))) continue;
        const manifest = readJson(path.join(bundlePath, 'manifest.json'));
        bundles.push({ appCount: manifest.contents?.apps?.length || 0, archivePath: path.join(bundlePath, 'bundle.tar.gz'), createdAt: manifest.backup?.createdAt || null, destinationId: destination.id, destinationLabel: destination.label, id: manifest.backup?.id || entry.name, path: bundlePath, schemaVersion: manifest.backup?.schemaVersion || null, sourceCommit: manifest.source?.commit || null, sourceVersion: manifest.source?.version || null, volumeCount: manifest.contents?.volumes?.length || 0 });
      } catch {}
    }
  }
  return bundles.sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
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
function validatePackagePayloads(root, packages) {
  for (const item of packages || []) {
    const packageDir = path.join(root, 'var-lib-mos-v2', 'app-packages', item.instanceId, 'installed');
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
function copyIfExists(source, target) { if (fs.existsSync(source)) fs.cpSync(source, target, { dereference: false, force: true, preserveTimestamps: true, recursive: true }); }
function repoRoot() {
  return repoDir;
}
function readBootstrapContract() {
  if (!fs.existsSync(bootstrapContractPath)) return {};
  return Object.fromEntries(fs.readFileSync(bootstrapContractPath, 'utf8').split(/\r?\n/u).map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (!match) return null;
    return [match[1], match[2].trim().replace(/^['"]|['"]$/gu, '')];
  }).filter(Boolean));
}
function runtimeUser() {
  return process.env.MOS_V2_RUNTIME_USER || readBootstrapContract().MOS_V2_RUNTIME_USER || 'mos';
}
function restoreBaseUrl() {
  const contract = readBootstrapContract();
  if (process.env.MOS_V2_HOME_HOST) return { homeHost: process.env.MOS_V2_HOME_HOST, scheme: 'http' };
  if (contract.MOS_V2_HOME_URL) {
    try {
      const parsed = new URL(contract.MOS_V2_HOME_URL);
      return { homeHost: parsed.hostname, scheme: parsed.protocol === 'https:' ? 'https' : 'http' };
    } catch {}
  }
  if (contract.MOS_V2_DOMAIN) return { homeHost: `home.${contract.MOS_V2_DOMAIN}`, scheme: 'http' };
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
function restoreStateOwnership() {
  const user = runtimeUser();
  for (const target of [stateDir, path.join(stateRoot, 'homepage', 'config')]) {
    if (fs.existsSync(target)) optionalCommand('chown', ['-R', `${user}:${user}`, target], { timeout: 300_000 });
  }
  // Restoring app-packages recreates it from the bundle, which carries modes but
  // no ownership, so the root agent's snapshots come back owned root:root and
  // Suite Manager can no longer read the packages it must re-verify on every
  // read — every restored app would report an unreadable snapshot. Put the
  // provisioned identity back: root owns the writes, mos-v2-agent reads them,
  // and the setgid root keeps that true for snapshots written after the restore.
  const packageRoot = path.join(stateRoot, 'app-packages');
  if (fs.existsSync(packageRoot)) {
    optionalCommand('chown', ['-R', 'root:mos-v2-agent', packageRoot], { timeout: 300_000 });
    optionalCommand('chmod', ['2750', packageRoot], { timeout: 60_000 });
  }
}
async function reconcileRestoredApps(jobFile) {
  const store = new SuiteManagerStore(stateDir);
  try {
    const appPackages = new AppPackageService({
      agent: new AppAgentClient(),
      appsDir: path.join(repoRoot(), 'apps'),
      store,
    });
    const instances = store.getAppInstances().filter((instance) => instance.status === 'installed' && instance.enabled);
    if (!instances.length) {
      log(jobFile, 'No installed app runtimes to restore');
      return;
    }
    for (const instance of instances) {
      log(jobFile, `Restoring ${instance.displayNameSnapshot || instance.packageId}`);
      await appPackages.enablePackage(instance.packageId, restoreRequestContext(instance.packageId));
    }
  } finally {
    store.close();
  }
}
function dockerVolumes() {
  const output = optionalCommand('docker', ['volume', 'ls', '--format', '{{.Name}}']) || '';
  return output.split(/\r?\n/u).map((line) => line.trim()).filter((name) => name.startsWith('mos-v2-app-')).sort();
}
function inspectVolume(name) {
  const parsed = JSON.parse(command('docker', ['volume', 'inspect', name]));
  return { mountpoint: parsed[0].Mountpoint, name };
}
function runningAppContainers() {
  const output = optionalCommand('docker', ['ps', '--filter', 'name=mos-v2-app-', '--format', '{{.Names}}']) || '';
  return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).sort();
}
function systemctl(action, service) { optionalCommand('systemctl', [action, service], { timeout: 120_000 }); }
function archiveVolume(volume, targetDir) {
  ensureDir(targetDir);
  const archive = `${volume.name}.tar.gz`;
  const archivePath = path.join(targetDir, archive);
  command('tar', ['-czf', archivePath, '-C', volume.mountpoint, '.'], { timeout: 1_800_000 });
  return { archive: `volumes/${archive}`, archiveBytes: fs.statSync(archivePath).size, archiveSha256: sha256(archivePath), name: volume.name };
}
function backup(jobFile) {
  const started = updateJob(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const bundleDir = path.join(started.destinationId, 'MOS-v2-backups', `mos-v2-backup-${stamp}-${started.id.slice(0, 8)}`);
  const stateStage = path.join(bundleDir, 'state');
  const volumesDir = path.join(bundleDir, 'volumes');
  ensureDir(bundleDir);
  ensureDir(volumesDir);
  updateJob(jobFile, (job) => { job.outputPath = bundleDir; });
  const stoppedContainers = runningAppContainers();
  const packageInventory = packageBackupInventory();
  try {
    stage(jobFile, 'Preparing backup bundle');
    stage(jobFile, 'Stopping app runtime for volume snapshot');
    for (const container of stoppedContainers) optionalCommand('docker', ['stop', container], { timeout: 120_000 });
    systemctl('stop', 'mos-v2-homepage.service');

    stage(jobFile, 'Copying suite state');
    copyIfExists(stateDir, path.join(stateStage, 'var-lib-mos-v2', 'suite-manager'));
    copyIfExists(path.join(stateRoot, 'app-packages'), path.join(stateStage, 'var-lib-mos-v2', 'app-packages'));
    copyIfExists(path.join(stateRoot, 'homepage', 'config'), path.join(stateStage, 'var-lib-mos-v2', 'homepage', 'config'));
    for (const file of caddyFiles) copyIfExists(file, path.join(stateStage, 'etc', 'caddy', path.basename(file)));
    copyIfExists(httpsSecret, path.join(stateStage, 'etc', 'mos-v2', 'secrets', path.basename(httpsSecret)));
    command('tar', ['-czf', path.join(bundleDir, 'state.tar.gz'), '-C', stateStage, '.'], { timeout: 300_000 });

    stage(jobFile, 'Archiving app volumes');
    const archivedVolumes = dockerVolumes().map(inspectVolume).map((volume) => {
      log(jobFile, `Archiving ${volume.name}`);
      return archiveVolume(volume, volumesDir);
    });

    stage(jobFile, 'Writing manifest');
    const manifest = {
      backup: { createdAt: new Date().toISOString(), id: started.id, kind: 'mos-v2-whole-suite', schemaVersion: 2 },
      contents: {
        apps: packageInventory,
        stateArchive: 'state.tar.gz',
        stateArchiveBytes: fs.statSync(path.join(bundleDir, 'state.tar.gz')).size,
        stateArchiveSha256: sha256(path.join(bundleDir, 'state.tar.gz')),
        volumes: archivedVolumes,
      },
      source: { branch: optionalCommand('git', ['branch', '--show-current']), commit: optionalCommand('git', ['rev-parse', 'HEAD']), repoDir, version: fs.existsSync(path.join(repoDir, 'VERSION')) ? fs.readFileSync(path.join(repoDir, 'VERSION'), 'utf8').trim() : null },
    };
    writeJson(path.join(bundleDir, 'manifest.json'), manifest);
    fs.writeFileSync(path.join(bundleDir, 'MANIFEST.sha256'), `${sha256(path.join(bundleDir, 'manifest.json'))}  manifest.json\n`);
    command('tar', ['-czf', path.join(bundleDir, 'bundle.tar.gz'), '-C', bundleDir, 'manifest.json', 'MANIFEST.sha256', 'state.tar.gz', 'volumes'], { timeout: 1_800_000 });
    fs.writeFileSync(path.join(bundleDir, completeMarker), `${new Date().toISOString()}\n`, 'utf8');
  } finally {
    stage(jobFile, 'Restarting runtime');
    systemctl('start', 'mos-v2-homepage.service');
    for (const container of stoppedContainers) optionalCommand('docker', ['start', container], { timeout: 120_000 });
  }
  updateJob(jobFile, (job) => { job.stage = 'completed'; job.status = 'succeeded'; });
}
async function restore(jobFile) {
  const started = updateJob(jobFile, (job) => { job.status = 'running'; job.stage = 'starting'; });
  const bundleDir = started.backupPath;
  let runtimeStopped = false;
  stage(jobFile, 'Validating backup bundle');
  const manifest = readJson(path.join(bundleDir, 'manifest.json'));
  if (manifest.backup?.kind !== 'mos-v2-whole-suite') throw new Error('Backup bundle is not a MOS V2 whole-suite backup.');
  if (manifest.backup?.schemaVersion !== 2) throw new Error('Backup bundle schema is not supported by package-aware restore.');
  if (sha256(path.join(bundleDir, 'manifest.json')) !== fs.readFileSync(path.join(bundleDir, 'MANIFEST.sha256'), 'utf8').trim().split(/\s+/u)[0]) throw new Error('Backup manifest checksum is invalid.');
  if (sha256(path.join(bundleDir, 'state.tar.gz')) !== manifest.contents?.stateArchiveSha256) throw new Error('Backup state archive checksum is invalid.');
  for (const volume of manifest.contents?.volumes || []) if (sha256(path.join(bundleDir, volume.archive)) !== volume.archiveSha256) throw new Error(`Backup volume checksum is invalid for ${volume.name}.`);
  command('tar', ['-tzf', path.join(bundleDir, 'state.tar.gz')], { timeout: 300_000 });
  for (const volume of manifest.contents?.volumes || []) command('tar', ['-tzf', path.join(bundleDir, volume.archive)], { timeout: 300_000 });
  const validationRoot = fs.mkdtempSync(path.join(agentStateDir, 'validate-'));
  try {
    command('tar', ['-xzf', path.join(bundleDir, 'state.tar.gz'), '-C', validationRoot], { timeout: 300_000 });
    validatePackagePayloads(validationRoot, manifest.contents?.apps);
  } finally {
    fs.rmSync(validationRoot, { force: true, recursive: true });
  }

  stage(jobFile, 'Saving pre-restore rescue copy');
  const rescueDir = path.join(agentStateDir, 'pre-restore-rescue', started.id);
  ensureDir(rescueDir);
  const rescueState = path.join(rescueDir, 'state');
  copyIfExists(stateDir, path.join(rescueState, 'var-lib-mos-v2', 'suite-manager'));
  copyIfExists(path.join(stateRoot, 'homepage', 'config'), path.join(rescueState, 'var-lib-mos-v2', 'homepage', 'config'));
  command('tar', ['-czf', path.join(rescueDir, 'state-before-restore.tar.gz'), '-C', rescueState, '.'], { timeout: 300_000 });
  updateJob(jobFile, (job) => { job.rescuePath = rescueDir; });

  stage(jobFile, 'Stopping current runtime');
  const containers = runningAppContainers();
  for (const container of containers) optionalCommand('docker', ['rm', '-f', container], { timeout: 120_000 });
  systemctl('stop', 'mos-v2-suite-manager.service');
  systemctl('stop', 'mos-v2-homepage.service');
  runtimeStopped = true;

  try {
    stage(jobFile, 'Restoring suite state');
    const temp = fs.mkdtempSync(path.join(agentStateDir, 'restore-'));
    command('tar', ['-xzf', path.join(bundleDir, 'state.tar.gz'), '-C', temp], { timeout: 300_000 });
    fs.rmSync(stateDir, { force: true, recursive: true });
    copyIfExists(path.join(temp, 'var-lib-mos-v2', 'suite-manager'), stateDir);
    fs.rmSync(path.join(stateRoot, 'app-packages'), { force: true, recursive: true });
    copyIfExists(path.join(temp, 'var-lib-mos-v2', 'app-packages'), path.join(stateRoot, 'app-packages'));
    fs.rmSync(path.join(stateRoot, 'homepage', 'config'), { force: true, recursive: true });
    copyIfExists(path.join(temp, 'var-lib-mos-v2', 'homepage', 'config'), path.join(stateRoot, 'homepage', 'config'));
    copyIfExists(path.join(temp, 'etc', 'caddy'), '/etc/caddy');
    copyIfExists(path.join(temp, 'etc', 'mos-v2', 'secrets'), '/etc/mos-v2/secrets');

    stage(jobFile, 'Restoring app volumes');
    for (const volume of manifest.contents?.volumes || []) {
      log(jobFile, `Restoring ${volume.name}`);
      optionalCommand('docker', ['volume', 'rm', volume.name], { timeout: 300_000 });
      command('docker', ['volume', 'create', volume.name], { timeout: 300_000 });
      const inspected = inspectVolume(volume.name);
      command('tar', ['-xzf', path.join(bundleDir, volume.archive), '-C', inspected.mountpoint], { timeout: 1_800_000 });
    }

    stage(jobFile, 'Restoring app runtime');
    await reconcileRestoredApps(jobFile);
  } finally {
    if (runtimeStopped) {
      restoreStateOwnership();
      stage(jobFile, 'Starting restored control plane');
      systemctl('start', 'mos-v2-homepage.service');
      systemctl('start', 'mos-v2-suite-manager.service');
      systemctl('reload', 'caddy.service');
    }
  }
  updateJob(jobFile, (job) => { job.stage = 'completed'; job.status = 'succeeded'; });
}

if (require.main === module && process.argv[2] === '--worker') {
  (async () => {
    try {
      const file = process.argv[3];
      const job = readJson(file);
      if (job.kind === 'restore') await restore(file);
      else backup(file);
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
        respond(response, 200, { backups: listBundles(destinations), capabilities: { backups: ['create', 'download', 'list'], destinations: ['list', 'mount'], restores: ['apply', 'list'] }, currentJob: summarizeJob(readCurrentJob()), destinations, lastJob: summarizeJob(latestJob()), service: 'mos-v2-backup-agent' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/destinations/mount') { respond(response, 200, { destination: await mountDestination((await readBody(request)).destinationId) }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/backups') { respond(response, 202, { job: createJob('backup', await readBody(request)) }); return; }
      if (request.method === 'POST' && url.pathname === '/v1/restores') { respond(response, 202, { job: createJob('restore', await readBody(request)) }); return; }
      respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' });
    } catch (error) {
      respond(response, 409, { code: 'BACKUP_AGENT_ERROR', error: error instanceof Error ? error.message : 'Backup agent operation failed.' });
    }
  });
  server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o660); process.stdout.write('[mos-v2-backup-agent] ready\n'); });
  function shutdown() { server.close(() => { fs.rmSync(socketPath, { force: true }); process.exit(0); }); }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { packageBackupInventory, sha256, validatePackagePayloads };
