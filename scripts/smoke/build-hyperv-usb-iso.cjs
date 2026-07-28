#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const { resolveSmokeRepoRef } = require('../installers/render-hyperv-usb-seed.cjs');
const labRoot = path.join(repoRoot, '.mos-smoke', 'hyperv-usb');
const outputIso = path.join(labRoot, 'my-own-suite-installer.iso');
const buildRoot = path.join(labRoot, 'iso-build');
const seedDir = path.join(labRoot, 'seed');

function fail(message) {
  throw new Error(`[mos-smoke:hyperv-usb] ${message}`);
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
  const smokeRepoRef = resolveSmokeRepoRef();
  fs.mkdirSync(labRoot, { recursive: true });
  const seedRenderer = path.join(repoRoot, 'scripts', 'installers', 'render-hyperv-usb-seed.cjs');
  const seedResult = spawnSync(process.execPath, [seedRenderer], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // The lab must never share a domain with a real USB install: the hosts
      // entries it writes on this PC would shadow the real server's DNS.
      MOS_STACK_DOMAIN: process.env.MOS_STACK_DOMAIN || 'mos.hyperv',
    },
    stdio: 'inherit',
  });
  if (seedResult.error) fail(`Unable to start the MOS USB seed renderer: ${seedResult.error.message}`);
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
  console.log('[mos-smoke:hyperv-usb] Installer ISO generated and verified.');
  console.log(`  ISO:  ${outputIso}`);
  console.log(`  Size: ${(size / (1024 ** 3)).toFixed(2)} GB`);
  console.log(`  Ref:  ${smokeRepoRef}`);
  try {
    const seedSummary = JSON.parse(fs.readFileSync(path.join(seedDir, 'seed-summary.json'), 'utf8'));
    if (seedSummary.linuxPasswordGenerated) {
      console.log(`  Login: ${seedSummary.linuxUsername} / ${seedSummary.linuxPassword} (generated for this build)`);
    }
  } catch {
    // Login printout is best-effort; the ISO itself is already verified.
  }
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
