#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { buildPaths, collectStatus, runApply } = require('../../../scripts/mos-updater-lib.cjs');

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return '';
}

const repoDir = process.env.MOS_UPDATE_AGENT_REPO_DIR || process.cwd();
const stateDir = process.env.MOS_UPDATE_AGENT_STATE_DIR || '/var/lib/mos-update-agent';
const currentJobPath = path.join(stateDir, 'current-job.json');
const jobFile = readArg('--job-file');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mapStage(message) {
  if (message.includes('release metadata')) return 'validating-release';
  if (message.includes('Rendering and validating VPS env files')) return 'rendering-env';
  if (message.includes('Validating Docker Compose config')) return 'validating-compose';
  if (message.includes('Building stack images')) return 'building-images';
  if (message.includes('Recreating stack containers')) return 'applying-compose';
  if (message.includes('Fetching git tags') || message.includes('Fetching latest commit')) return 'fetching-git';
  if (message.includes('Checking out')) return 'switching-target';
  if (message.includes('Update applied successfully')) return 'succeeded';
  return 'running';
}

function updateJob(patch) {
  const current = readJson(jobFile);
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeJson(jobFile, next);
  writeJson(currentJobPath, next);
  return next;
}

function completeCurrentJob(job) {
  writeJson(currentJobPath, {
    error: typeof job.error === 'string' ? job.error : null,
    id: job.id,
    stage: job.stage,
    status: job.status,
    target: job.target,
    updatedAt: job.updatedAt,
  });
}

async function main() {
  const initialJob = readJson(jobFile);

  updateJob({
    stage: 'checking',
    status: 'running',
  });

  const paths = buildPaths(repoDir);
  const context = {
    fail(message) {
      throw new Error(message);
    },
    log(message) {
      const current = readJson(jobFile);
      const nextLogs = [...(current.logs || []), { at: new Date().toISOString(), message }];
      updateJob({
        logs: nextLogs.slice(-100),
        stage: mapStage(message),
      });
    },
    paths,
  };

  try {
    const updaterStatus = await collectStatus(context);
    updateJob({
      stage: 'ready-to-apply',
      updaterStatus,
    });

    const flags = {
      target: initialJob.target || 'latest',
      yes: true,
    };

    await runApply(context, flags);

    const finalJob = updateJob({
      completedAt: new Date().toISOString(),
      stage: 'succeeded',
      status: 'succeeded',
      updaterStatus: await collectStatus(context),
    });
    completeCurrentJob(finalJob);
  } catch (error) {
    const failedJob = updateJob({
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      stage: 'failed',
      status: 'failed',
    });
    completeCurrentJob(failedJob);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const failedJob = readJson(jobFile);
  writeJson(jobFile, {
    ...failedJob,
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    stage: 'failed',
    status: 'failed',
    updatedAt: new Date().toISOString(),
  });
  process.exitCode = 1;
});
