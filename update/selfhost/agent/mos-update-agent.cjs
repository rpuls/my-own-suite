#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { buildPaths, collectStatus } = require('../../../scripts/mos-updater-lib.cjs');

const repoDir = process.env.MOS_UPDATE_AGENT_REPO_DIR || process.cwd();
const socketPath = process.env.MOS_UPDATE_AGENT_SOCKET_PATH || '/run/mos-update-agent/agent.sock';
const stateDir = process.env.MOS_UPDATE_AGENT_STATE_DIR || '/var/lib/mos-update-agent';
const tokenFile = process.env.MOS_UPDATE_AGENT_TOKEN_FILE || '/etc/mos-update-agent/auth.token';

const jobsDir = path.join(stateDir, 'jobs');
const currentJobPath = path.join(stateDir, 'current-job.json');

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

function loadToken() {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function json(c, statusCode, body) {
  c.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  c.end(`${JSON.stringify(body, null, 2)}\n`);
}

function notFound(c) {
  json(c, 404, { error: 'Not found.' });
}

function unauthorized(c) {
  json(c, 401, { error: 'Unauthorized.' });
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
  const files = listJobFiles();
  let latest = null;

  for (const filePath of files) {
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

function createJob(payload) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    kind: 'apply',
    stage: 'queued',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    target: payload.target || 'latest',
    track: payload.track || null,
    initiator: payload.initiator || 'unknown',
    logs: [],
    updaterStatus: null,
  };

  writeJson(jobFilePath(id), job);
  writeJson(currentJobPath, job);
  return job;
}

function authenticate(request) {
  const token = loadToken();
  if (!token) {
    return false;
  }

  const header = request.headers.authorization || '';
  return header === `Bearer ${token}`;
}

function spawnWorker(job) {
  const workerPath = path.join(repoDir, 'update', 'selfhost', 'agent', 'mos-update-worker.cjs');
  const args = [workerPath, '--job-id', job.id, '--job-file', jobFilePath(job.id)];
  const child = spawn(process.execPath, args, {
    cwd: repoDir,
    detached: true,
    env: {
      ...process.env,
      MOS_UPDATE_AGENT_REPO_DIR: repoDir,
      MOS_UPDATE_AGENT_STATE_DIR: stateDir,
      MOS_UPDATE_AGENT_TOKEN_FILE: tokenFile,
    },
    stdio: 'ignore',
  });
  child.unref();
}

function summarizeJob(job) {
  if (!job) {
    return null;
  }

  return {
    error: typeof job.error === 'string' ? job.error : null,
    id: job.id,
    logs: Array.isArray(job.logs) ? job.logs.slice(-20) : [],
    stage: job.stage || null,
    status: job.status || null,
    target: job.target || null,
    updatedAt: job.updatedAt || null,
  };
}

async function handleStatus(response) {
  const updaterStatus = await collectStatus({
    fail(message) {
      throw new Error(message);
    },
    log() {},
    paths: buildPaths(repoDir),
  }).catch((error) => ({
    checkedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    latestRelease: null,
    latestRevision: null,
    track: null,
    updateAvailable: false,
  }));

  json(response, 200, {
    currentJob: summarizeJob(readCurrentJob()),
    lastJob: summarizeJob(readLatestJob()),
    repoDir,
    service: 'mos-update-agent',
    socketPath,
    updaterStatus,
  });
}

async function handleCreateJob(request, response) {
  const existing = readCurrentJob();
  if (isActiveJob(existing)) {
    json(response, 409, {
      currentJob: summarizeJob(existing),
      error: 'An update job is already running.',
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

  const job = createJob(payload);
  spawnWorker(job);
  json(response, 202, {
    job,
  });
}

function handleReadJob(response, jobId) {
  const filePath = jobFilePath(jobId);
  if (!fs.existsSync(filePath)) {
    notFound(response);
    return;
  }

  try {
    json(response, 200, readJson(filePath));
  } catch {
    json(response, 500, { error: 'Job state could not be read.' });
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
    json(response, 200, { ok: true, service: 'mos-update-agent' });
    return;
  }

  if (!authenticate(request)) {
    unauthorized(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/status') {
    await handleStatus(response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/jobs') {
    await handleCreateJob(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
    const jobId = url.pathname.slice('/v1/jobs/'.length).trim();
    handleReadJob(response, jobId);
    return;
  }

  notFound(response);
});

server.listen(socketPath, () => {
  process.stdout.write(`[mos-update-agent] listening on ${socketPath}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanupSocket();
    server.close(() => process.exit(0));
  });
}
