#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = process.cwd();
const baseComposeFile = path.join(repoRoot, 'deploy', 'vps', 'docker-compose.yml');
const selfhostComposeFile = path.join(repoRoot, 'deploy', 'vps', 'docker-compose.selfhost.yml');
const projectDirectory = path.join(repoRoot, 'deploy', 'vps');

const args = process.argv.slice(2);
const files = ['-f', baseComposeFile];

if (require('node:fs').existsSync(selfhostComposeFile)) {
  files.push('-f', selfhostComposeFile);
}

const result = spawnSync('docker', ['compose', ...files, '--project-directory', projectDirectory, ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
