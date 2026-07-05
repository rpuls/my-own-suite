#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { buildPaths, collectStatus, readJson, repoRootFrom, writeJson, writeUpdateTrack } = require('./lib.cjs');

const repoRoot = process.env.MOS_V2_REPO_DIR || repoRootFrom(process.cwd());
const stateRoot = process.env.MOS_V2_STATE_ROOT || '/var/lib/mos-v2';
const socketPath = process.env.MOS_V2_UPDATE_AGENT_SOCKET || '/run/mos-v2-update-agent/agent.sock';
const paths = buildPaths(repoRoot, stateRoot);

function respond(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024) reject(new Error('BODY_TOO_LARGE'));
    });
    request.on('end', () => {
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { reject(new Error('INVALID_JSON')); }
    });
    request.on('error', reject);
  });
}

function listJobFiles() {
  fs.mkdirSync(paths.jobsDir, { recursive: true });
  return fs.readdirSync(paths.jobsDir).filter((name) => name.endsWith('.json')).map((name) => path.join(paths.jobsDir, name));
}

function summarizeJob(job) {
  if (!job) return null;
  return {
    completedAt: job.completedAt || null,
    error: typeof job.error === 'string' ? job.error : null,
    id: job.id,
    logs: Array.isArray(job.logs) ? job.logs.slice(-30) : [],
    stage: job.stage || null,
    status: job.status || null,
    target: job.target || null,
    updatedAt: job.updatedAt || null,
  };
}

function readCurrentJob() {
  try { return readJson(paths.currentJobPath); } catch { return null; }
}

function readLatestJob() {
  return listJobFiles()
    .map((file) => { try { const job = readJson(file); return { job, timestamp: new Date(job.updatedAt || 0).getTime() }; } catch { return null; } })
    .filter(Boolean)
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.job || null;
}

function isActive(job) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function createJob(payload) {
  const at = new Date().toISOString();
  const job = {
    createdAt: at,
    id: crypto.randomUUID(),
    initiator: typeof payload?.initiator === 'string' ? payload.initiator.slice(0, 120) : 'owner',
    kind: 'apply',
    logs: [],
    stage: 'queued',
    status: 'queued',
    target: 'latest',
    updatedAt: at,
  };
  writeJson(path.join(paths.jobsDir, `${job.id}.json`), job);
  writeJson(paths.currentJobPath, summarizeJob(job));
  return job;
}

function startWorker(job) {
  const child = spawn(process.execPath, [path.join(__dirname, 'worker.cjs'), '--job-file', path.join(paths.jobsDir, `${job.id}.json`)], {
    cwd: path.join(repoRoot, 'version-2'),
    detached: true,
    env: { ...process.env, MOS_V2_REPO_DIR: repoRoot, MOS_V2_STATE_ROOT: stateRoot },
    stdio: 'ignore',
  });
  child.unref();
}

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.mkdirSync(paths.jobsDir, { recursive: true });
fs.rmSync(socketPath, { force: true });

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  try {
    if (request.method === 'GET' && url.pathname === '/healthz') {
      respond(response, 200, { ok: true, service: 'mos-v2-update-agent' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      respond(response, 200, {
        capabilities: { updates: { capabilities: ['apply', 'configure-track'] } },
        currentJob: summarizeJob(readCurrentJob()),
        lastJob: summarizeJob(readLatestJob()),
        repoDir: repoRoot,
        service: 'mos-v2-update-agent',
        socketPath,
        updaterStatus: await collectStatus(paths).catch((error) => ({
          checkedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
          updateAvailable: false,
        })),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/jobs') {
      const existing = readCurrentJob();
      if (isActive(existing)) {
        respond(response, 409, { currentJob: summarizeJob(existing), error: 'An update job is already running.' });
        return;
      }
      const job = createJob(await readBody(request));
      startWorker(job);
      respond(response, 202, { job: summarizeJob(job) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/track') {
      const existing = readCurrentJob();
      if (isActive(existing)) {
        respond(response, 409, { currentJob: summarizeJob(existing), error: 'Wait for the current update job to finish before switching tracks.' });
        return;
      }
      const track = writeUpdateTrack(paths, await readBody(request));
      respond(response, 200, { track, updaterStatus: await collectStatus(paths) });
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
      const id = path.basename(url.pathname);
      const jobPath = path.join(paths.jobsDir, `${id}.json`);
      if (!fs.existsSync(jobPath)) {
        respond(response, 404, { code: 'NOT_FOUND', error: 'Job was not found.' });
        return;
      }
      respond(response, 200, readJson(jobPath));
      return;
    }
    respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' });
  } catch (error) {
    respond(response, 400, { code: 'UPDATE_AGENT_ERROR', error: error instanceof Error ? error.message : 'Update agent request failed.' });
  }
});

server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o660);
  process.stdout.write('[mos-v2-update-agent] ready\n');
});

function shutdown() {
  server.close(() => {
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
