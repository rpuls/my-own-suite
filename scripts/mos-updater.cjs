#!/usr/bin/env node

const fs = require('node:fs');

const { buildPaths, collectStatus, readJson, runApply } = require('./mos-updater-lib.cjs');

const repoRoot = process.cwd();
const paths = buildPaths(repoRoot);

function log(message) {
  console.log(`[mos-updater] ${message}`);
}

function fail(message) {
  console.error(`[mos-updater] ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command = 'check', ...rest] = argv;
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) {
      continue;
    }

    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { command, flags };
}

function readUpdaterState() {
  if (!fs.existsSync(paths.updaterStatePath)) {
    return null;
  }

  return readJson(paths.updaterStatePath);
}

function printStatus(status) {
  console.log(JSON.stringify(status, null, 2));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const context = { fail, log, paths };

  if (command === 'check') {
    printStatus(await collectStatus(context));
    return;
  }

  if (command === 'status') {
    const state = readUpdaterState();
    if (!state) {
      fail('No updater state has been recorded yet. Run `npm run update:check` first.');
    }
    printStatus(state);
    return;
  }

  if (command === 'apply') {
    await runApply(context, flags);
    return;
  }

  fail(`Unsupported command "${command}". Use check, status, or apply.`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
