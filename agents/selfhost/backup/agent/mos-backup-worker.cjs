#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoDir = process.env.MOS_BACKUP_AGENT_REPO_DIR || process.cwd();
const jobFile = process.argv[process.argv.indexOf('--job-file') + 1];

if (!jobFile) {
  process.stderr.write('Missing --job-file.\n');
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function updateJob(mutator) {
  const job = readJson(jobFile);
  mutator(job);
  job.updatedAt = new Date().toISOString();
  writeJson(jobFile, job);
  writeJson(path.join(path.dirname(path.dirname(jobFile)), 'current-job.json'), job);
  return job;
}

function log(message) {
  updateJob((job) => {
    job.logs = Array.isArray(job.logs) ? job.logs : [];
    job.logs.push({ at: new Date().toISOString(), message });
  });
}

function stage(name) {
  updateJob((job) => {
    job.stage = name;
    job.status = 'running';
  });
  log(name);
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: options.cwd || repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 120_000,
  }).trim();
}

function optionalCommand(commandName, args, options = {}) {
  try {
    return command(commandName, args, options);
  } catch {
    return null;
  }
}

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.cpSync(source, target, {
    dereference: false,
    errorOnExist: false,
    force: true,
    preserveTimestamps: true,
    recursive: true,
  });
}

function buildManifest(job, outputDir) {
  const versionPath = path.join(repoDir, 'VERSION');
  const stablePath = path.join(repoDir, 'releases', 'stable.json');
  return {
    backup: {
      createdAt: new Date().toISOString(),
      id: job.id,
      kind: 'mos-offline-snapshot',
      schemaVersion: 1,
    },
    source: {
      branch: optionalCommand('git', ['branch', '--show-current']),
      commit: optionalCommand('git', ['rev-parse', 'HEAD']),
      repoDir,
      version: fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : null,
      release: fs.existsSync(stablePath) ? JSON.parse(fs.readFileSync(stablePath, 'utf8')) : null,
    },
    contents: {
      configArchive: path.relative(outputDir, path.join(outputDir, 'mos-config.tar.gz')),
      notes: [
        'This first backup-agent slice captures MOS metadata and repo-managed runtime configuration.',
        'Docker volume archiving and automated restore are intentionally left out until the cold-backup format is validated on self-host hardware.',
      ],
    },
    restore: {
      status: 'planned',
      requiresVersionPairing: true,
    },
  };
}

function main() {
  const started = updateJob((job) => {
    job.stage = 'starting';
    job.status = 'running';
  });

  try {
    stage('Preparing backup directory');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(started.destinationId, 'MOS-backups', `mos-backup-${stamp}-${started.id.slice(0, 8)}`);
    fs.mkdirSync(outputDir, { recursive: true });

    stage('Collecting suite metadata');
    const manifest = buildManifest(started, outputDir);
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    stage('Copying runtime configuration');
    const configRoot = path.join(outputDir, 'config');
    fs.mkdirSync(configRoot, { recursive: true });
    copyIfExists(path.join(repoDir, 'deploy', 'vps', '.env'), path.join(configRoot, 'deploy-vps.env'));
    copyIfExists(path.join(repoDir, 'deploy', 'vps', 'services'), path.join(configRoot, 'services'));
    copyIfExists(path.join(repoDir, 'deploy', 'vps', 'docker-compose.selfhost.yml'), path.join(configRoot, 'docker-compose.selfhost.yml'));

    stage('Writing configuration archive');
    const tarOutput = path.join(outputDir, 'mos-config.tar.gz');
    optionalCommand('tar', ['-czf', tarOutput, '-C', configRoot, '.'], { timeout: 300_000 });

    updateJob((job) => {
      job.outputPath = outputDir;
      job.stage = 'completed';
      job.status = 'succeeded';
    });
  } catch (error) {
    updateJob((job) => {
      job.error = error instanceof Error ? error.message : String(error);
      job.stage = 'failed';
      job.status = 'failed';
    });
  }
}

main();
