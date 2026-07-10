#!/usr/bin/env node

const path = require('node:path');

const { buildPaths, collectStatus, readJson, runApply, writeJson } = require('./lib.cjs');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

const jobFile = argValue('--job-file');
const repoRoot = process.env.MOS_V2_REPO_DIR || path.resolve(__dirname, '..', '..', '..');
const stateRoot = process.env.MOS_V2_STATE_ROOT || '/var/lib/mos-v2';
const paths = buildPaths(repoRoot, stateRoot);

function updateJob(patch) {
  const current = readJson(jobFile);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeJson(jobFile, next);
  writeJson(paths.currentJobPath, summarizeJob(next));
  return next;
}

function summarizeJob(job) {
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

function mapStage(message) {
  if (/Fetching|checkout|Fast-forwarding|Repository/u.test(message)) return 'updating-checkout';
  if (/dependencies/u.test(message)) return 'installing-dependencies';
  if (/frontend/u.test(message)) return 'building-frontend';
  if (/Reconciling/u.test(message)) return 'reconciling-system';
  if (/completed/u.test(message)) return 'succeeded';
  return 'running';
}

async function main() {
  if (!jobFile) throw new Error('Missing --job-file.');
  updateJob({ stage: 'checking', status: 'running' });
  try {
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
    updateJob({
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      stage: 'failed',
      status: 'failed',
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  try {
    updateJob({
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      stage: 'failed',
      status: 'failed',
    });
  } catch {}
  process.exitCode = 1;
});
