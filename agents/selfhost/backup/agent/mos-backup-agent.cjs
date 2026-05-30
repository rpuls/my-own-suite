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
const capabilities = {
  backups: {
    capabilities: ['create'],
  },
  destinations: {
    capabilities: ['list'],
  },
  restores: {
    capabilities: ['plan'],
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
    logs: Array.isArray(job.logs) ? job.logs.slice(-20) : [],
    outputPath: job.outputPath || null,
    stage: job.stage || null,
    status: job.status || null,
    updatedAt: job.updatedAt || null,
  };
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
  const lsblk = await execJson('lsblk', ['--json', '--bytes', '--output', 'NAME,LABEL,MODEL,TRAN,SIZE,MOUNTPOINTS']);
  const mountpoints = [];

  function visit(device) {
    const points = Array.isArray(device.mountpoints) ? device.mountpoints : [];
    for (const mountpoint of points) {
      const normalized = normalizeDestination(mountpoint);
      if (normalized) {
        mountpoints.push({
          id: normalized,
          label: device.label || device.model || path.basename(normalized),
          mountPath: normalized,
          transport: device.tran || null,
          sizeBytes: Number(device.size) || null,
        });
      }
    }

    for (const child of device.children || []) {
      visit(child);
    }
  }

  for (const device of lsblk?.blockdevices || []) {
    visit(device);
  }

  const unique = new Map();
  for (const destination of mountpoints) {
    unique.set(destination.mountPath, destination);
  }

  return Array.from(unique.values()).map((destination) => {
    let availableBytes = null;
    try {
      const stat = fs.statfsSync(destination.mountPath);
      availableBytes = stat.bavail * stat.bsize;
    } catch {}

    return {
      ...destination,
      availableBytes,
      writable: isWritable(destination.mountPath),
    };
  });
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
    json(response, 200, {
      capabilities,
      currentJob: summarizeJob(readCurrentJob()),
      destinations: await listDestinations(),
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
