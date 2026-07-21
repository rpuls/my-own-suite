#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { buildPaths, collectStatus, readJson, repoRootFrom, writeJson, writeUpdateTrack } = require('./lib.cjs');

const repoRoot = process.env.MOS_REPO_DIR || repoRootFrom(process.cwd());
const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
const socketPath = process.env.MOS_UPDATE_AGENT_SOCKET || '/run/mos-update-agent/agent.sock';
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

function jobUnitName(jobId) {
  return `mos-update-job-${String(jobId || '').replace(/[^A-Za-z0-9:-]/gu, '-')}`;
}

function systemdUnitActive(unitName) {
  if (process.platform !== 'linux') return false;
  const result = spawnSync('systemctl', ['is-active', '--quiet', unitName], { stdio: 'ignore' });
  return result.status === 0;
}

function markLostJobIfNeeded(job) {
  if (!isActive(job) || process.platform !== 'linux') return job;
  const updatedAt = new Date(job.updatedAt || job.createdAt || 0).getTime();
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < 120_000) return job;
  if (systemdUnitActive(jobUnitName(job.id))) return job;
  const next = {
    ...job,
    completedAt: new Date().toISOString(),
    error: 'Update job stopped before reporting completion. The updater service may have restarted during reconciliation; start the update again after checking the latest status.',
    stage: 'failed',
    status: 'failed',
    updatedAt: new Date().toISOString(),
  };
  writeJson(path.join(paths.jobsDir, `${job.id}.json`), next);
  writeJson(paths.currentJobPath, summarizeJob(next));
  return next;
}

function readCurrentJob() {
  try { return markLostJobIfNeeded(readJson(paths.currentJobPath)); } catch { return null; }
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
  const workerArgs = [path.join(__dirname, 'worker.cjs'), '--job-file', path.join(paths.jobsDir, `${job.id}.json`)];
  const workerCwd = repoRoot;
  const workerEnv = { ...process.env, MOS_REPO_DIR: repoRoot, MOS_STATE_ROOT: stateRoot };
  if (process.platform === 'linux') {
    const unitName = jobUnitName(job.id);
    const systemdRun = spawnSync('systemd-run', [
      '--collect',
      `--unit=${unitName}`,
      `--working-directory=${workerCwd}`,
      `--setenv=MOS_REPO_DIR=${repoRoot}`,
      `--setenv=MOS_STATE_ROOT=${stateRoot}`,
      `--setenv=NODE_ENV=${workerEnv.NODE_ENV || 'production'}`,
      process.execPath,
      ...workerArgs,
    ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
    if (systemdRun.status === 0) return;
  }
  const child = spawn(process.execPath, workerArgs, {
    cwd: repoRoot,
    detached: true,
    env: workerEnv,
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
      respond(response, 200, { ok: true, service: 'mos-update-agent' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      respond(response, 200, {
        capabilities: { updates: { capabilities: ['apply', 'configure-track'] } },
        currentJob: summarizeJob(readCurrentJob()),
        lastJob: summarizeJob(readLatestJob()),
        repoDir: repoRoot,
        service: 'mos-update-agent',
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
  process.stdout.write('[mos-update-agent] ready\n');
});

function shutdown() {
  server.close(() => {
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
