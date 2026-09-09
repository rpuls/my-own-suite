#!/usr/bin/env node

const path = require('node:path');

const { buildPaths, collectStatus, readJson, readLastStatus, runApply, summarizeJob, writeJson } = require('./lib.cjs');
const { CANCELLED, CheckpointFailure, checkpointTarget, takeCheckpoint } = require('./checkpoint.cjs');
const { BackupAgentClient } = require('../../suite-manager/backend/src/backups/backup-agent-client.cjs');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

const jobFile = argValue('--job-file');
const repoRoot = process.env.MOS_REPO_DIR || path.resolve(__dirname, '..', '..', '..');
const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
const paths = buildPaths(repoRoot, stateRoot);

function updateJob(patch) {
  const current = readJson(jobFile);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeJson(jobFile, next);
  writeJson(paths.currentJobPath, summarizeJob(next));
  return next;
}

function mapStage(message) {
  if (/Fetching|checkout|Fast-forwarding|Repository/u.test(message)) return 'updating-checkout';
  if (/dependencies/u.test(message)) return 'installing-dependencies';
  if (/frontend/u.test(message)) return 'building-frontend';
  if (/Reconciling/u.test(message)) return 'reconciling-system';
  if (/completed/u.test(message)) return 'succeeded';
  return 'running';
}

// A checkpoint failure keeps its own stage rather than the flat "failed": the
// difference between an update that stopped before it touched anything and one
// that stopped halfway through the apply is the first thing an owner needs.
function failJob(error) {
  const checkpointFailed = error instanceof CheckpointFailure;
  const current = checkpointFailed ? (() => { try { return readJson(jobFile).checkpoint || null; } catch { return null; } })() : null;
  updateJob({
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    output: typeof error?.output === 'string' && error.output ? error.output : null,
    stage: checkpointFailed ? 'taking-checkpoint' : 'failed',
    status: 'failed',
    ...(checkpointFailed ? { checkpoint: { ...current, status: 'failed', waiting: null } } : {}),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// What the owner said while the checkpoint waited is the job file saying so:
// the agent writes it, the worker reads it between steps, and both survive a
// restart because neither holds the fact in memory.
function decisionOnDisk() {
  try {
    const job = readJson(jobFile);
    if (job.status === 'cancelled') return 'cancel';
    return job.checkpoint?.decision === 'skip' ? 'skip' : null;
  } catch {
    return null;
  }
}

// The backup before the apply. Its whole state lives on the job record rather
// than in log lines, so an owner who reloads mid-wait, or an agent that restarts
// under it, still sees which restore point is being taken and why it is waiting.
async function runCheckpoint() {
  updateJob({ checkpoint: { backupId: null, jobId: null, status: 'running', target: null, waiting: null }, stage: 'taking-checkpoint', status: 'running' });
  const target = checkpointTarget(readLastStatus(paths));
  const result = await takeCheckpoint({
    backup: new BackupAgentClient(),
    decision: async () => decisionOnDisk(),
    onState(state) {
      const current = readJson(jobFile);
      updateJob({
        checkpoint: { ...current.checkpoint, ...state },
        stage: state.status === 'waiting' ? 'waiting-for-backup-destination' : 'taking-checkpoint',
      });
    },
    sleep,
    target,
  });
  if (result.status === 'cancelled') {
    updateJob({ completedAt: new Date().toISOString(), error: CANCELLED, stage: 'cancelled', status: 'cancelled' });
    return false;
  }
  updateJob({ checkpoint: { backupId: result.backupId || null, jobId: result.jobId || null, status: result.status, target: target || null, waiting: null } });
  return true;
}

async function main() {
  if (!jobFile) throw new Error('Missing --job-file.');
  try {
    // Before the check, so a checkpoint that cannot be taken stops the update
    // while nothing has been fetched, built or reconciled.
    if (!await runCheckpoint()) return;
    updateJob({ stage: 'checking', status: 'running' });
    updateJob({ stage: 'ready-to-apply', updaterStatus: await collectStatus(paths) });
    const finalStatus = await runApply(paths, {
      log(message) {
        const current = readJson(jobFile);
        updateJob({
          logs: [...(current.logs || []), { at: new Date().toISOString(), message }].slice(-100),
          stage: mapStage(message),
        });
      },
    });
    updateJob({
      completedAt: new Date().toISOString(),
      stage: 'succeeded',
      status: 'succeeded',
      updaterStatus: finalStatus,
    });
  } catch (error) {
    failJob(error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  try { failJob(error); } catch {}
  process.exitCode = 1;
});
