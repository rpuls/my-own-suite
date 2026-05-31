#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { spawn } = require('node:child_process');

const repoDir = process.env.MOS_BACKUP_AGENT_REPO_DIR || process.cwd();
const socketPath = process.env.MOS_BACKUP_AGENT_SOCKET_PATH || '/run/mos-backup-agent/agent.sock';
const stateDir = process.env.MOS_BACKUP_AGENT_STATE_DIR || '/var/lib/mos-backup-agent';
const tokenFile = process.env.MOS_BACKUP_AGENT_TOKEN_FILE || '/etc/mos-backup-agent/auth.token';

const jobsDir = path.join(stateDir, 'jobs');
const currentJobPath = path.join(stateDir, 'current-job.json');
const destinationRoots = ['/media', '/mnt', '/run/media'];
const managedMountRoot = '/media/mos-backup';
const mountableFileSystems = new Set(['exfat', 'ext2', 'ext3', 'ext4', 'ntfs', 'ntfs3', 'vfat', 'xfs', 'btrfs']);
const capabilities = {
  backups: {
    capabilities: ['create', 'list'],
  },
  destinations: {
    capabilities: ['list', 'mount'],
  },
  restores: {
    capabilities: ['plan', 'apply'],
  },
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function loadToken() {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function authenticate(request) {
  const token = loadToken();
  return Boolean(token && request.headers.authorization === `Bearer ${token}`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function execJson(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(stdout || 'null'));
      } catch {
        resolve(null);
      }
    });
  });
}

function execText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || `${command} failed`).trim()));
        return;
      }

      resolve(String(stdout || '').trim());
    });
  });
}

function listJobFiles() {
  ensureDir(jobsDir);
  return fs
    .readdirSync(jobsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(jobsDir, name));
}

function readCurrentJob() {
  if (!fs.existsSync(currentJobPath)) {
    return null;
  }

  try {
    return readJson(currentJobPath);
  } catch {
    return null;
  }
}

function readLatestJob() {
  let latest = null;

  for (const filePath of listJobFiles()) {
    try {
      const job = readJson(filePath);
      const timestamp = new Date(job.updatedAt || job.startedAt || 0).getTime();
      if (!latest || timestamp > latest.timestamp) {
        latest = { job, timestamp };
      }
    } catch {
      continue;
    }
  }

  return latest ? latest.job : null;
}

function jobFilePath(jobId) {
  return path.join(jobsDir, `${jobId}.json`);
}

function isActiveJob(job) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function summarizeJob(job) {
  if (!job) {
    return null;
  }

  return {
    destinationId: job.destinationId || null,
    error: typeof job.error === 'string' ? job.error : null,
    id: job.id,
    backupPath: job.backupPath || null,
    kind: job.kind || null,
    logs: Array.isArray(job.logs) ? job.logs.slice(-20) : [],
    outputPath: job.outputPath || null,
    rescuePath: job.rescuePath || null,
    stage: job.stage || null,
    status: job.status || null,
    updatedAt: job.updatedAt || null,
  };
}

function summarizeBackupBundle(bundlePath) {
  const manifestPath = path.join(bundlePath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = readJson(manifestPath);
    const volumes = Array.isArray(manifest.contents?.volumes) ? manifest.contents.volumes : [];
    const totalVolumeArchiveBytes = volumes.reduce((total, volume) => {
      const bytes = Number(volume.archiveBytes);
      return Number.isFinite(bytes) ? total + bytes : total;
    }, 0);

    return {
      activeProfiles: Array.isArray(manifest.source?.activeProfiles) ? manifest.source.activeProfiles : [],
      createdAt: typeof manifest.backup?.createdAt === 'string' ? manifest.backup.createdAt : null,
      id: typeof manifest.backup?.id === 'string' ? manifest.backup.id : path.basename(bundlePath),
      path: bundlePath,
      schemaVersion: Number(manifest.backup?.schemaVersion) || null,
      sourceCommit: typeof manifest.source?.commit === 'string' ? manifest.source.commit : null,
      sourceVersion: typeof manifest.source?.version === 'string' ? manifest.source.version : null,
      totalVolumeArchiveBytes,
      volumeCount: volumes.length,
    };
  } catch {
    return null;
  }
}

function listBackupBundles(destinations) {
  const bundles = [];

  for (const destination of destinations) {
    if (!destination.mountPath) {
      continue;
    }

    const backupsRoot = path.join(destination.mountPath, 'MOS-backups');
    if (!fs.existsSync(backupsRoot)) {
      continue;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(backupsRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const bundle = summarizeBackupBundle(path.join(backupsRoot, entry.name));
      if (bundle) {
        bundles.push({
          ...bundle,
          destinationId: destination.id,
          destinationLabel: destination.label,
        });
      }
    }
  }

  return bundles.sort((left, right) => {
    const leftTime = new Date(left.createdAt || 0).getTime();
    const rightTime = new Date(right.createdAt || 0).getTime();
    return rightTime - leftTime;
  });
}

function normalizeMountpoint(candidate) {
  const value = String(candidate || '').trim();
  if (!value) {
    return null;
  }

  return normalizeDestination(value);
}

function isLikelyExternalDevice(device, inheritedExternal = false) {
  return (
    inheritedExternal ||
    device.tran === 'usb' ||
    device.rm === true ||
    device.rm === 1 ||
    device.rm === '1' ||
    device.rm === 'true'
  );
}

function sanitizeMountName(value) {
  const safe = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return safe || 'drive';
}

function mountBlockReason(device, external) {
  const fileSystem = String(device.fstype || '').toLowerCase();
  const label = String(device.label || '').trim().toLowerCase();
  const sizeBytes = Number(device.size) || 0;

  if (!external) {
    return 'Only removable or USB drives can be mounted from Suite Manager.';
  }

  if (device.type !== 'part') {
    return 'Choose a data partition, not the whole device.';
  }

  if (!device.path) {
    return 'The device path was not reported by Linux.';
  }

  if (!fileSystem) {
    return 'The partition has no detected filesystem.';
  }

  if (!mountableFileSystems.has(fileSystem)) {
    return `The ${fileSystem} filesystem is not mounted automatically yet.`;
  }

  if (label === 'efi' || (fileSystem === 'vfat' && sizeBytes > 0 && sizeBytes < 1024 * 1024 * 1024)) {
    return 'This looks like a small EFI/system partition, not a backup drive.';
  }

  return null;
}

function normalizeDestination(candidate) {
  const resolved = path.resolve(String(candidate || ''));
  const allowed = destinationRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));

  if (!allowed) {
    return null;
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return resolved;
}

async function listDestinations() {
  const lsblk = await execJson('lsblk', [
    '--json',
    '--bytes',
    '--output',
    'NAME,PATH,LABEL,MODEL,TRAN,RM,TYPE,FSTYPE,SIZE,MOUNTPOINTS',
  ]);
  const candidates = [];

  function visit(device, inheritedExternal = false) {
    const external = isLikelyExternalDevice(device, inheritedExternal);
    const points = Array.isArray(device.mountpoints) ? device.mountpoints : [];
    const label = device.label || device.model || device.name || device.path || 'External drive';
    const devicePath = device.path || (device.name ? `/dev/${device.name}` : null);
    let hasSupportedMount = false;

    for (const mountpoint of points) {
      const normalized = normalizeMountpoint(mountpoint);
      if (normalized) {
        hasSupportedMount = true;
        candidates.push({
          canMount: false,
          devicePath,
          fileSystem: device.fstype || null,
          id: normalized,
          label,
          mountPath: normalized,
          mountState: 'mounted',
          transport: device.tran || null,
          sizeBytes: Number(device.size) || null,
        });
      }
    }

    if (external && !hasSupportedMount && device.type !== 'disk') {
      const blockedReason = mountBlockReason(device, external);
      candidates.push({
        canMount: !blockedReason && !points.some(Boolean),
        devicePath,
        fileSystem: device.fstype || null,
        id: devicePath || label,
        label,
        mountBlockedReason: blockedReason,
        mountPath: points.find(Boolean) || null,
        mountState: points.some(Boolean) ? 'unsupported-mount' : 'unmounted',
        transport: device.tran || null,
        sizeBytes: Number(device.size) || null,
      });
    }

    for (const child of device.children || []) {
      visit(child, external);
    }
  }

  for (const device of lsblk?.blockdevices || []) {
    visit(device);
  }

  const unique = new Map();
  for (const destination of candidates) {
    unique.set(destination.id, destination);
  }

  return Array.from(unique.values()).map((destination) => {
    let availableBytes = null;
    if (destination.mountState === 'mounted' && destination.mountPath) {
      try {
        const stat = fs.statfsSync(destination.mountPath);
        availableBytes = stat.bavail * stat.bsize;
      } catch {}
    }

    return {
      ...destination,
      availableBytes,
      writable: destination.mountState === 'mounted' && destination.mountPath ? isWritable(destination.mountPath) : false,
    };
  });
}

async function mountDestination(payload) {
  const destinationId = String(payload.destinationId || '').trim();
  const destinations = await listDestinations();
  const destination = destinations.find((candidate) => candidate.id === destinationId);

  if (!destination) {
    throw new Error('Selected drive is no longer available. Scan again and retry.');
  }

  if (destination.mountState === 'mounted' && destination.mountPath) {
    return destination;
  }

  if (!destination.canMount || !destination.devicePath) {
    throw new Error(destination.mountBlockedReason || 'Selected drive cannot be mounted automatically.');
  }

  const mountName = sanitizeMountName(`${destination.label || 'drive'}-${path.basename(destination.devicePath)}`);
  const mountPath = path.join(managedMountRoot, mountName);
  ensureDir(mountPath);

  await execText('mount', [destination.devicePath, mountPath]);

  const refreshed = await listDestinations();
  const mounted = refreshed.find(
    (candidate) => candidate.devicePath === destination.devicePath && candidate.mountState === 'mounted',
  );

  if (!mounted) {
    throw new Error('The drive was mounted, but Suite Manager could not verify the mounted destination.');
  }

  return mounted;
}

function isWritable(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function createJob(payload) {
  const destinationId = normalizeDestination(payload.destinationId);
  if (!destinationId) {
    throw new Error('Choose a mounted destination under /media, /mnt, or /run/media.');
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    destinationId,
    kind: 'backup',
    stage: 'queued',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    initiator: payload.initiator || 'unknown',
    logs: [],
    outputPath: null,
  };

  writeJson(jobFilePath(id), job);
  writeJson(currentJobPath, job);
  return job;
}

function normalizeBackupPath(candidate) {
  const resolved = normalizeDestination(path.dirname(path.dirname(String(candidate || ''))))
    ? path.resolve(String(candidate || ''))
    : null;

  if (!resolved) {
    return null;
  }

  const manifestPath = path.join(resolved, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  return resolved;
}

function createRestoreJob(payload) {
  const backupPath = normalizeBackupPath(payload.backupPath);
  if (!backupPath) {
    throw new Error('Choose a detected backup bundle from a mounted destination.');
  }

  if (payload.confirmation !== 'RESTORE') {
    throw new Error('Restore confirmation is required.');
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    backupPath,
    kind: 'restore',
    stage: 'queued',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    initiator: payload.initiator || 'unknown',
    logs: [],
    outputPath: backupPath,
  };

  writeJson(jobFilePath(id), job);
  writeJson(currentJobPath, job);
  return job;
}

function spawnWorker(job) {
  const workerPath = path.join(repoDir, 'agents', 'selfhost', 'backup', 'agent', 'mos-backup-worker.cjs');
  const args = [workerPath, '--job-id', job.id, '--job-file', jobFilePath(job.id)];
  const child = spawn(process.execPath, args, {
    cwd: repoDir,
    detached: true,
    env: {
      ...process.env,
      MOS_BACKUP_AGENT_REPO_DIR: repoDir,
      MOS_BACKUP_AGENT_JOB_ID: job.id,
      MOS_BACKUP_AGENT_STATE_DIR: stateDir,
    },
    stdio: 'ignore',
  });
  child.unref();
}

async function handleCreateJob(request, response) {
  const existing = readCurrentJob();
  if (isActiveJob(existing)) {
    json(response, 409, {
      currentJob: summarizeJob(existing),
      error: 'A backup job is already running.',
    });
    return;
  }

  let payload = {};
  try {
    const rawBody = await readBody(request);
    payload = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    json(response, 400, { error: 'Invalid JSON request body.' });
    return;
  }

  try {
    const job = createJob(payload);
    spawnWorker(job);
    json(response, 202, { job });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : 'Unable to start backup.' });
  }
}

async function handleMountDestination(request, response) {
  let payload = {};
  try {
    const rawBody = await readBody(request);
    payload = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    json(response, 400, { error: 'Invalid JSON request body.' });
    return;
  }

  try {
    const destination = await mountDestination(payload);
    json(response, 200, { destination });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : 'Unable to mount drive.' });
  }
}

async function handleCreateRestoreJob(request, response) {
  const existing = readCurrentJob();
  if (isActiveJob(existing)) {
    json(response, 409, {
      currentJob: summarizeJob(existing),
      error: 'A backup or restore job is already running.',
    });
    return;
  }

  let payload = {};
  try {
    const rawBody = await readBody(request);
    payload = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    json(response, 400, { error: 'Invalid JSON request body.' });
    return;
  }

  try {
    const job = createRestoreJob(payload);
    spawnWorker(job);
    json(response, 202, { job });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : 'Unable to start restore.' });
  }
}

function cleanupSocket() {
  if (process.platform === 'win32') {
    return;
  }

  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {}
}

ensureDir(path.dirname(socketPath));
ensureDir(stateDir);
ensureDir(jobsDir);
cleanupSocket();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/healthz') {
    json(response, 200, { ok: true, service: 'mos-backup-agent' });
    return;
  }

  if (!authenticate(request)) {
    json(response, 401, { error: 'Unauthorized.' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/status') {
    const destinations = await listDestinations();
    json(response, 200, {
      backups: listBackupBundles(destinations),
      capabilities,
      currentJob: summarizeJob(readCurrentJob()),
      destinations,
      lastJob: summarizeJob(readLatestJob()),
      repoDir,
      service: 'mos-backup-agent',
      socketPath,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/jobs') {
    await handleCreateJob(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/destinations/mount') {
    await handleMountDestination(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/restores') {
    await handleCreateRestoreJob(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
    const jobId = url.pathname.slice('/v1/jobs/'.length).trim();
    const filePath = jobFilePath(jobId);
    if (!fs.existsSync(filePath)) {
      json(response, 404, { error: 'Not found.' });
      return;
    }

    try {
      json(response, 200, readJson(filePath));
    } catch {
      json(response, 500, { error: 'Job state could not be read.' });
    }
    return;
  }

  json(response, 404, { error: 'Not found.' });
});

server.listen(socketPath, () => {
  process.stdout.write(`[mos-backup-agent] listening on ${socketPath}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanupSocket();
    server.close(() => process.exit(0));
  });
}
