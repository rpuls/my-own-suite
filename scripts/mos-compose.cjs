#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const repoRoot = process.cwd();
const baseComposeFile = path.join(repoRoot, 'deploy', 'vps', 'docker-compose.yml');
const selfhostComposeFile = path.join(repoRoot, 'deploy', 'vps', 'docker-compose.selfhost.yml');
const simulatedSelfhostComposeFile = path.join(repoRoot, 'deploy', 'vps', 'docker-compose.simulated-selfhost.yml');
const projectDirectory = path.join(repoRoot, 'deploy', 'vps');

const args = process.argv.slice(2);
const files = ['-f', baseComposeFile];
const simulateSelfHost =
  args.includes('--simulateSelfHost') ||
  args.includes('--simulate-selfhost') ||
  process.env.MOS_SIMULATE_SELFHOST === '1';
const composeArgs = args.filter((arg) => arg !== '--simulateSelfHost' && arg !== '--simulate-selfhost');

if (fs.existsSync(selfhostComposeFile)) {
  files.push('-f', selfhostComposeFile);
}

if (simulateSelfHost) {
  if (!fs.existsSync(simulatedSelfhostComposeFile)) {
    console.error(`Simulated self-host Compose override not found: ${simulatedSelfhostComposeFile}`);
    process.exit(1);
  }
  files.push('-f', simulatedSelfhostComposeFile);
}

const result = spawnSync('docker', ['compose', ...files, '--project-directory', projectDirectory, ...composeArgs], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
