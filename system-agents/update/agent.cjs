#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { buildPaths, collectStatus, readJson, readLastStatus, repoRootFrom, summarizeJob, writeJson, writeUpdateTrack } = require('./lib.cjs');
const { BackupAgentClient } = require('../../suite-manager/backend/src/backups/backup-agent-client.cjs');
const { CANCELLABLE_STAGES, CANCELLED, SKIPPABLE_STAGES } = require('./checkpoint.cjs');

const repoRoot = process.env.MOS_REPO_DIR || repoRootFrom(process.cwd());
const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
const socketPath = process.env.MOS_UPDATE_AGENT_SOCKET || '/run/mos-update-agent/agent.sock';
const backupSocketPath = process.env.MOS_BACKUP_AGENT_SOCKET || '/run/mos-backup-agent/agent.sock';
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

const backupAgent = new BackupAgentClient({ socketPath: backupSocketPath });

// An update restarts the host agents, the backup agent included, so it must not
// begin while a backup, restore, check or delete is running: the reconcile step
// would cut it off mid-write. Asked at the start, which is the only moment it
// can be answered usefully — once the checkpoint has the backup queue, nothing
// else can take it before the apply.
async function activeBackupJob() {
  try {
    const summary = await backupAgent.summary();
    return isActive(summary?.currentJob) ? summary.currentJob : null;
  } catch {
    return null;
  }
}

function backupBusyMessage(job) {
  const noun = job?.kind === 'restore' ? 'restore' : job?.kind === 'validate' ? 'backup check' : job?.kind === 'delete' ? 'backup deletion' : 'backup';
  return `A ${noun} is running. Start the update when it finishes.`;
}

function createJob(payload) {
  const at = new Date().toISOString();
  const job = {
    checkpoint: { backupId: null, jobId: null, status: 'pending', target: null, waiting: null },
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

// While a job runs, the worker is the one talking to the origin; a poll gets
// the check the job started from instead of a new one.
async function currentStatus(currentJob) {
  if (isActive(currentJob)) {
    const last = readLastStatus(paths);
    if (last) return last;
  }
  return collectStatus(paths).catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      checkFailure: { at: new Date().toISOString(), details: [], reason },
      checkedAt: new Date().toISOString(),
      error: reason,
      updateAvailable: null,
    };
  });
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
      // A transient unit inherits nothing, and the worker is what asks the
      // backup agent for the backup this update takes before it applies.
      `--setenv=MOS_BACKUP_AGENT_SOCKET=${backupSocketPath}`,
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
      const currentJob = readCurrentJob();
      respond(response, 200, {
        capabilities: { updates: { capabilities: ['apply', 'cancel', 'checkpoint', 'configure-track', 'skip-backup'] } },
        currentJob: summarizeJob(currentJob),
        lastJob: summarizeJob(readLatestJob()),
        repoDir: repoRoot,
        service: 'mos-update-agent',
        socketPath,
        updaterStatus: await currentStatus(currentJob),
      });
      return;
    }
    // The cheap read. A full status asks the origin what the latest release is,
    // which is far too much for the one question the backup agent asks often.
    if (request.method === 'GET' && url.pathname === '/v1/summary') {
      respond(response, 200, { currentJob: summarizeJob(readCurrentJob()), service: 'mos-update-agent' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/jobs') {
      const existing = readCurrentJob();
      if (isActive(existing)) {
        respond(response, 409, { currentJob: summarizeJob(existing), error: 'An update job is already running.' });
        return;
      }
      const backupJob = await activeBackupJob();
      if (backupJob) {
        respond(response, 409, { code: 'BACKUP_RUNNING', error: backupBusyMessage(backupJob) });
        return;
      }
      const job = createJob(await readBody(request));
      startWorker(job);
      respond(response, 202, { job: summarizeJob(job) });
      return;
    }
    // The two answers an owner can give while the update waits for its backup.
    // Cancel is honoured until the apply begins: past that the checkout, the
    // build and the reconcile are under way and stopping them partway is what a
    // rollback is for. Going on without a backup is honoured only while there is
    // nowhere to write one; a backup already running is left to finish.
    if (request.method === 'POST' && url.pathname.startsWith('/v1/jobs/') && (url.pathname.endsWith('/cancel') || url.pathname.endsWith('/skip-backup'))) {
      const skip = url.pathname.endsWith('/skip-backup');
      const id = path.basename(path.dirname(url.pathname));
      const jobPath = path.join(paths.jobsDir, `${id}.json`);
      if (!fs.existsSync(jobPath)) {
        respond(response, 404, { code: 'NOT_FOUND', error: 'Job was not found.' });
        return;
      }
      const job = readJson(jobPath);
      if (!isActive(job) || !(skip ? SKIPPABLE_STAGES : CANCELLABLE_STAGES).includes(job.stage)) {
        respond(response, 409, { code: 'UPDATE_UNDERWAY', error: skip ? 'The update is no longer waiting for a backup.' : 'The update has already started applying and can no longer be cancelled.' });
        return;
      }
      const at = new Date().toISOString();
      const next = skip
        ? { ...job, checkpoint: { ...job.checkpoint, decision: 'skip' }, updatedAt: at }
        : { ...job, completedAt: at, error: CANCELLED, stage: 'cancelled', status: 'cancelled', updatedAt: at };
      writeJson(jobPath, next);
      writeJson(paths.currentJobPath, summarizeJob(next));
      respond(response, 200, { job: summarizeJob(next) });
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
