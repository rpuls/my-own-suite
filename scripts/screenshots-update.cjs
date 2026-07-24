#!/usr/bin/env node
// Harvests the marketing screenshots captured by the last local E2E run
// (test/e2e/screenshots/, written by test/e2e/support/screenshots.mjs) into
// site/src/assets/screenshots/. Filenames are the contract: the site refers
// to stable names, so refreshing screenshots after a UI change is one
// human-run E2E pass plus this command — no site changes needed.
//
//   npm run e2e:full           # human-run, against a running Hyper-V lab
//   npm run screenshots:update
//
// The E2E suites themselves stay human-run per AGENTS.md; this script only
// copies files that already exist locally.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const sourceDir = process.env.MOS_E2E_SCREENSHOTS_DIR || path.join(repoRoot, 'test', 'e2e', 'screenshots');
const targetDir = path.join(repoRoot, 'site', 'src', 'assets', 'screenshots');

function relative(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/gu, '/');
}

function age(mtimeMs) {
  const minutes = Math.round((Date.now() - mtimeMs) / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function main() {
  if (!fs.existsSync(sourceDir)) {
    console.error(`No captures found: ${relative(sourceDir)} does not exist.`);
    console.error('Run the E2E suite first (npm run e2e:full) so it can capture marketing screenshots.');
    process.exitCode = 1;
    return;
  }

  const captures = fs.readdirSync(sourceDir).filter((name) => name.endsWith('.png')).sort();
  if (!captures.length) {
    console.error(`No .png captures in ${relative(sourceDir)}.`);
    console.error('Run the E2E suite first (npm run e2e:full) so it can capture marketing screenshots.');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const existing = new Set(fs.readdirSync(targetDir).filter((name) => name.endsWith('.png')));

  for (const name of captures) {
    const sourcePath = path.join(sourceDir, name);
    const stat = fs.statSync(sourcePath);
    fs.copyFileSync(sourcePath, path.join(targetDir, name));
    const label = existing.has(name) ? 'updated' : 'added  ';
    console.log(`${label} ${relative(path.join(targetDir, name))}  (captured ${age(stat.mtimeMs)})`);
  }

  const stale = [...existing].filter((name) => !captures.includes(name)).sort();
  if (stale.length) {
    console.warn('');
    console.warn('Not refreshed by this run (still the previous capture):');
    for (const name of stale) console.warn(`  ${relative(path.join(targetDir, name))}`);
  }

  console.log('');
  console.log(`${captures.length} screenshot(s) synced into ${relative(targetDir)}.`);
  console.log('Review the images, then commit the changed assets with the site.');
}

main();
