#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const v2Root = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(v2Root, '..');
const labRoot = path.join(v2Root, '.mos-smoke', 'hyperv-usb');
const outputIso = path.join(labRoot, 'my-own-suite-installer.iso');
const buildRoot = path.join(labRoot, 'iso-build');
const seedDir = path.join(labRoot, 'v2-seed');
const smokeRepoRef = 'feat/app-platform-v2-lab';

function fail(message) {
  throw new Error(`[mos-v2-smoke:hyperv-usb] ${message}`);
}

function verifyIso(isoPath) {
  const stat = fs.statSync(isoPath);
  if (!stat.isFile() || stat.size < 100 * 1024 * 1024) {
    fail(`Generated installer ISO is unexpectedly small: ${isoPath}`);
  }

  const handle = fs.openSync(isoPath, 'r');
  try {
    const signature = Buffer.alloc(5);
    fs.readSync(handle, signature, 0, signature.length, (16 * 2048) + 1);
    if (signature.toString('ascii') !== 'CD001') {
      fail(`Generated file does not contain an ISO-9660 volume descriptor: ${isoPath}`);
    }
  } finally {
    fs.closeSync(handle);
  }

  return stat.size;
}

function main(extraArgs = process.argv.slice(2)) {
  fs.mkdirSync(labRoot, { recursive: true });
  const seedRenderer = path.join(v2Root, 'scripts', 'installers', 'render-hyperv-usb-seed.cjs');
  const seedResult = spawnSync(process.execPath, [seedRenderer], {
    cwd: v2Root,
    env: process.env,
    stdio: 'inherit',
  });
  if (seedResult.error) fail(`Unable to start the V2 USB seed renderer: ${seedResult.error.message}`);
  if (seedResult.status !== 0) process.exit(seedResult.status || 1);

  const builder = path.join(repoRoot, 'scripts', 'selfhost-build-installer-iso.cjs');
  const result = spawnSync(
    process.execPath,
    [
      builder,
      '--output-iso', outputIso,
      '--build-dir', buildRoot,
      '--auto-boot', 'true',
      '--seed-dir', seedDir,
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    fail(`Unable to start the canonical USB installer builder: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  const size = verifyIso(outputIso);
  console.log('');
  console.log('[mos-v2-smoke:hyperv-usb] Installer ISO generated and verified.');
  console.log(`  ISO:  ${outputIso}`);
  console.log(`  Size: ${(size / (1024 ** 3)).toFixed(2)} GB`);
  console.log(`  Ref:  ${smokeRepoRef}`);
  console.log('  VM:   unchanged and powered off');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
  }
}

module.exports = { main, verifyIso };
