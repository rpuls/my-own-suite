#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function readArg(name, fallback = '') {
  const prefixed = `--${name}=`;
  const valueWithEquals = process.argv.find((arg) => arg.startsWith(prefixed));
  if (valueWithEquals) {
    return valueWithEquals.slice(prefixed.length).trim();
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1].trim();
  }

  return fallback;
}

function requireArg(name, fallback = '') {
  const value = readArg(name, fallback);
  if (!value) {
    console.error(`Missing required --${name} argument.`);
    process.exit(1);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || 'pipe',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    console.error(`Command failed: ${command} ${args.join(' ')}`);
    process.exit(result.status || 1);
  }

  return result;
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`${label} not found: ${filePath}`);
    process.exit(1);
  }
}

function resolveInputIso(repoRoot) {
  const explicitIso = readArg('ubuntu-iso');
  if (explicitIso) {
    return path.resolve(repoRoot, explicitIso);
  }

  const isoDropDir = path.join(repoRoot, 'deploy', 'self-host', 'autoinstall', 'ubuntu-iso');
  if (!fs.existsSync(isoDropDir)) {
    console.error(`Ubuntu ISO drop folder not found: ${isoDropDir}`);
    process.exit(1);
  }

  const isoFiles = fs
    .readdirSync(isoDropDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.iso'))
    .map((entry) => path.join(isoDropDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  if (isoFiles.length === 0) {
    console.error(`No Ubuntu ISO found in ${isoDropDir}`);
    console.error('Drop one Ubuntu Server ISO into that folder and run the builder again.');
    process.exit(1);
  }

  if (isoFiles.length > 1) {
    console.error(`Found multiple ISO files in ${isoDropDir}. Keep only one there or pass --ubuntu-iso explicitly.`);
    for (const isoFile of isoFiles) {
      console.error(`- ${isoFile}`);
    }
    process.exit(1);
  }

  return isoFiles[0];
}

const repoRoot = process.cwd();
const inputIso = resolveInputIso(repoRoot);
const outputIso = path.resolve(
  repoRoot,
  readArg('output-iso', 'deploy/self-host/output/my-own-suite-selfhost-installer.iso'),
);
const buildRoot = path.resolve(repoRoot, readArg('build-dir', '.tmp/selfhost-iso-build'));
const seedDir = path.join(buildRoot, 'seed');
const builderTag = readArg('builder-tag', 'mos-selfhost-iso-builder:latest');

assertFile(inputIso, 'Ubuntu ISO');

fs.rmSync(buildRoot, { force: true, recursive: true });
fs.mkdirSync(seedDir, { recursive: true });
fs.mkdirSync(path.dirname(outputIso), { recursive: true });

const passThroughArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--ubuntu-iso') || arg.startsWith('--output-iso') || arg.startsWith('--build-dir') || arg.startsWith('--builder-tag')) {
    continue;
  }
  passThroughArgs.push(arg);
}

run('node', ['scripts/selfhost-write-autoinstall.cjs', '--output-dir', seedDir, ...passThroughArgs], {
  stdio: 'inherit',
});

assertFile(path.join(seedDir, 'user-data'), 'Generated user-data');
assertFile(path.join(seedDir, 'meta-data'), 'Generated meta-data');

run('docker', ['build', '-t', builderTag, 'deploy/self-host/iso-builder'], {
  stdio: 'inherit',
});

const normalizedRepoRoot = repoRoot.replace(/\\/g, '/');
const normalizedSeedDir = seedDir.replace(/\\/g, '/');
const normalizedOutputDir = path.dirname(outputIso).replace(/\\/g, '/');
const normalizedInputDir = path.dirname(inputIso).replace(/\\/g, '/');
const inputIsoBaseName = path.basename(inputIso);
const outputIsoBaseName = path.basename(outputIso);

fs.mkdirSync(path.join(buildRoot, 'workspace'), { recursive: true });

run(
  'docker',
  [
    'run',
    '--rm',
    '-e',
    `INPUT_ISO_BASENAME=${inputIsoBaseName}`,
    '-e',
    `OUTPUT_ISO_BASENAME=${outputIsoBaseName}`,
    '-v',
    `${normalizedSeedDir}:/seed:ro`,
    '-v',
    `${normalizedRepoRoot}/.tmp/selfhost-iso-build/workspace:/workspace`,
    '-v',
    `${normalizedInputDir}:/input:ro`,
    '-v',
    `${normalizedOutputDir}:/output`,
    builderTag,
  ],
  {
    stdio: 'inherit',
  },
);

console.log(`Created single-USB installer ISO: ${outputIso}`);
console.log(`Source Ubuntu ISO: ${inputIso}`);
console.log(`Next step: flash that ISO to a USB stick with a tool such as Rufus or balenaEtcher.`);
