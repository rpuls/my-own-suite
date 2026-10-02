#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { buildPaths, collectStatus, readJson, readLastStatus, repoRootFrom, resolveTrack, summarizeJob, writeJson, writeUpdateTrack } = require('./lib.cjs');
const { BackupAgentClient } = require('../../suite-manager/backend/src/backups/backup-agent-client.cjs');
const { readSigningPublicKey, verifyCatalogSignature } = require('../../suite-manager/backend/src/apps/catalog-signature.cjs');
const { hostHeldPackages, validateAdvisoryIndex } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { CANCELLABLE_STAGES, CANCELLED, SKIPPABLE_STAGES } = require('./checkpoint.cjs');
const { HOLDS_CONFIG_PATH, REBOOT_REQUIRED_PATH, readEnablementState, renderHoldsConfig } = require('../../infrastructure/host-patching.cjs');

const repoRoot = process.env.MOS_REPO_DIR || repoRootFrom(process.cwd());
const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
const socketPath = process.env.MOS_UPDATE_AGENT_SOCKET || '/run/mos-update-agent/agent.sock';
const backupSocketPath = process.env.MOS_BACKUP_AGENT_SOCKET || '/run/mos-backup-agent/agent.sock';
const paths = buildPaths(repoRoot, stateRoot);

function respond(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readBody(request, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) reject(new Error('BODY_TOO_LARGE'));
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

// Long enough for the response to reach the browser over a connection that may
// be going through Caddy, short enough that the owner does not wonder whether
// the button worked.
const RESTART_DELAY_MS = 5_000;

function scheduleHostRestart() {
  if (process.platform !== 'linux') return;
  // A transient unit, so the reboot is owned by systemd rather than by this
  // agent: `systemctl reboot` stops mos-update-agent among everything else, and
  // a child of the process being stopped is not a safe place to run it from.
  const armed = spawnSync('systemd-run', [
    '--collect',
    '--unit=mos-host-restart',
    `--on-active=${Math.round(RESTART_DELAY_MS / 1000)}s`,
    '/usr/bin/systemctl',
    'reboot',
  ], { stdio: 'ignore' });
  if (armed.status === 0) return;
  const child = spawn('/bin/sh', ['-c', `sleep ${Math.round(RESTART_DELAY_MS / 1000)}; systemctl reboot`], { detached: true, stdio: 'ignore' });
  child.unref();
}

// The public half of the catalog signing key, read from this installed release
// rather than from whoever sent the feed. Missing key, bad signature and feed
// that does not validate all answer the same way: no holds are written, and the
// file already on disk is left as it was.
function verifiedHeldPackages(body) {
  const text = typeof body?.advisoriesText === 'string' ? body.advisoriesText : '';
  const signature = typeof body?.advisoriesSignature === 'string' ? body.advisoriesSignature : '';
  if (!text || !signature) return null;
  let publicKey;
  try {
    publicKey = readSigningPublicKey(fs.readFileSync(path.join(repoRoot, 'trust', 'official-catalog.pub'), 'utf8'));
  } catch {
    return null;
  }
  if (!verifyCatalogSignature({ bytes: text, publicKey, signature })) return null;
  let index;
  try { index = JSON.parse(text); } catch { return null; }
  if (validateAdvisoryIndex(index).length) return null;
  return hostHeldPackages(index);
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
    // The track rides along because it is free here — `resolveTrack` reads the
    // checkout and the config file and talks to nothing — and Suite Manager
    // needs it per catalog refresh to know which ref to fetch.
    if (request.method === 'GET' && url.pathname === '/v1/summary') {
      respond(response, 200, { currentJob: summarizeJob(readCurrentJob()), service: 'mos-update-agent', track: resolveTrack(paths) });
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
    // The restart a patched kernel needs. It is a privileged mutation, so it is
    // here rather than in the read-only diagnostics agent that reported the need
    // for it — and it is here at all because the UI that says a restart is
    // needed has to be able to perform it. An owner must never be sent to a
    // terminal for something MOS told them to do.
    //
    // MOS never reboots on its own: nothing reaches this but an owner who
    // confirmed it, and only for a restart Ubuntu asked for. That is checked
    // here, on the privileged side, rather than trusted from the web app that
    // relayed the click. The two refusals after it are the same two an update
    // takes, for the same reason — a reboot in the middle of either cuts it off
    // mid-write.
    if (request.method === 'POST' && url.pathname === '/v1/host/restart') {
      if (!fs.existsSync(REBOOT_REQUIRED_PATH)) {
        respond(response, 409, { code: 'RESTART_NOT_NEEDED', error: 'This server does not need a restart.' });
        return;
      }
      const existing = readCurrentJob();
      if (isActive(existing)) {
        respond(response, 409, { code: 'UPDATE_RUNNING', currentJob: summarizeJob(existing), error: 'A MOS update is running. Restart the server when it finishes.' });
        return;
      }
      const backupJob = await activeBackupJob();
      if (backupJob) {
        respond(response, 409, { code: 'BACKUP_RUNNING', error: backupBusyMessage(backupJob) });
        return;
      }
      const restartingAt = new Date(Date.now() + RESTART_DELAY_MS).toISOString();
      // Answered first, and the reboot armed on a delay, so the owner's browser
      // gets the acknowledgement rather than a dropped connection it would have
      // to guess the meaning of.
      respond(response, 202, { restartingAt, service: 'mos-update-agent' });
      scheduleHostRestart();
      return;
    }

    // Packages unattended-upgrades must not install, from the signed advisory
    // feed. The feed is re-verified here rather than trusted from the caller:
    // Suite Manager is an unprivileged web app, and a privileged write it could
    // name the contents of would be a way to stop a server taking security
    // patches at all. What it can do is hand over bytes somebody signed.
    if (request.method === 'POST' && url.pathname === '/v1/host/holds') {
      const body = await readBody(request, 512 * 1024);
      const held = verifiedHeldPackages(body);
      if (held === null) {
        respond(response, 400, { code: 'ADVISORIES_SIGNATURE_INVALID', error: 'The advisory feed was not signed by the key this MOS release trusts.' });
        return;
      }
      // The hold file clears the blacklist before it fills it, so on a server
      // whose policy is the owner's it would erase theirs. MOS writes into a
      // policy only where MOS owns the policy.
      const managedBy = readEnablementState(stateRoot)?.managedBy || 'unknown';
      if (managedBy !== 'mos') {
        fs.rmSync(HOLDS_CONFIG_PATH, { force: true });
        respond(response, 200, { heldPackages: [], managedBy, service: 'mos-update-agent' });
        return;
      }
      fs.writeFileSync(HOLDS_CONFIG_PATH, renderHoldsConfig(held), 'utf8');
      fs.chmodSync(HOLDS_CONFIG_PATH, 0o644);
      respond(response, 200, { heldPackages: held, managedBy, service: 'mos-update-agent' });
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
