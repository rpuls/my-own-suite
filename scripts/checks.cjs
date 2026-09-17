#!/usr/bin/env node
'use strict';

/**
 * The one definition of the checks that gate a change.
 *
 * `npm test`, the CI workflow, the release gate and the pre-push hook all run
 * this file, so a check cannot be enforced in one place and quietly missing
 * from another. That drift is what let a release tag fail on a site build CI
 * had never run that way, and what let a manifest check live in `npm test`
 * while CI never ran it at all.
 *
 * Usage:
 *   node scripts/checks.cjs                  every lane
 *   node scripts/checks.cjs --lane workspace one lane
 *   node scripts/checks.cjs --heavy          include the browser-driven checks
 *   node scripts/checks.cjs --keep-going     run everything, report at the end
 *   node scripts/checks.cjs --list           print the checks and exit
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const onActions = Boolean(process.env.GITHUB_ACTIONS);
const SITE_PORT = 4321;

// Ordered as CI runs them: the cheap checks that fail loudest come first, and
// nothing below depends on anything above it beyond the site build.
const CHECKS = [
  {
    lane: 'workspace',
    id: 'unit',
    title: 'Unit tests',
    command: 'npm run test:unit',
  },
  {
    lane: 'workspace',
    id: 'manifest',
    title: 'Check app manifests',
    command: 'npm run apps:manifest:check',
  },
  {
    lane: 'workspace',
    id: 'catalog',
    title: 'Check app catalog and advisory feed',
    command: 'npm run apps:catalog:check',
  },
  {
    lane: 'workspace',
    id: 'versions',
    title: 'Check app package versions against the published catalog',
    // The guard compares against the catalog installed boxes actually read, so
    // it needs origin/main. A shallow CI checkout does not have it; offline the
    // fetch just fails and whatever ref is already here is used instead.
    prep: 'git fetch --depth=1 origin main',
    command: 'npm run apps:version:check -- --require-baseline',
  },
  {
    lane: 'workspace',
    id: 'privacy',
    title: 'Validate app privacy reviews',
    command: 'npm run apps:privacy:check',
  },
  {
    lane: 'workspace',
    id: 'privacy-monitor',
    title: 'Monitor stale reviews and advisories',
    command: 'npm run apps:privacy:monitor',
  },
  {
    lane: 'workspace',
    id: 'docs-claims',
    title: 'Check documentation claims against the repository',
    command: 'npm run docs:claims',
  },
  {
    lane: 'workspace',
    id: 'typecheck',
    title: 'Typecheck Suite Manager',
    command: 'npm run typecheck',
  },
  {
    lane: 'workspace',
    id: 'client',
    title: 'Build Suite Manager client',
    command: 'npm run build:client',
  },
  {
    lane: 'workspace',
    id: 'installer',
    title: 'Render installer contract',
    command: 'npm run installer:check',
  },
  {
    lane: 'workspace',
    id: 'release-metadata',
    title: 'Check release metadata',
    command: 'npm run release:check',
  },
  {
    lane: 'site',
    id: 'site-deps',
    title: 'Install site dependencies',
    command: 'npm ci --no-audit --progress=false',
    cwd: 'site',
  },
  {
    lane: 'site',
    // The site build installs the planner's dependencies and builds it into
    // site/dist/plan, so the planner is exercised here whichever entry point
    // asked for the site.
    id: 'site-build',
    title: 'Build MOS site',
    command: 'npm run build',
    cwd: 'site',
  },
  {
    lane: 'site',
    id: 'planner',
    title: 'Test the planner',
    command: 'npm test',
    cwd: 'site/planner',
  },
  {
    lane: 'site',
    id: 'accessibility',
    title: 'Check accessibility',
    command: 'npx --yes pa11y-ci@4.1.1 --config site/.pa11yci.json',
    // pa11y drives its own Chromium download, which is not something a push
    // should trigger on a laptop. CI always runs it; locally ask for --heavy.
    heavy: true,
    servesSite: true,
  },
];

const LANES = [...new Set(CHECKS.map((check) => check.lane))];

function parseArgs(argv) {
  const options = { heavy: false, keepGoing: false, lanes: [], list: false, only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lane') {
      index += 1;
      options.lanes.push(...String(argv[index] || '').split(',').filter(Boolean));
    } else if (arg.startsWith('--lane=')) {
      options.lanes.push(...arg.slice('--lane='.length).split(',').filter(Boolean));
    } else if (arg === '--only') {
      index += 1;
      options.only.push(...String(argv[index] || '').split(',').filter(Boolean));
    } else if (arg.startsWith('--only=')) {
      options.only.push(...arg.slice('--only='.length).split(',').filter(Boolean));
    } else if (arg === '--heavy') {
      options.heavy = true;
    } else if (arg === '--keep-going') {
      options.keepGoing = true;
    } else if (arg === '--list') {
      options.list = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!options.lanes.length) options.lanes = [...LANES];
  const unknown = options.lanes.filter((lane) => !LANES.includes(lane));
  if (unknown.length) fail(`Unknown lane(s): ${unknown.join(', ')}. Known lanes: ${LANES.join(', ')}`);
  const ids = CHECKS.map((check) => check.id);
  const unknownIds = options.only.filter((id) => !ids.includes(id));
  if (unknownIds.length) fail(`Unknown check(s): ${unknownIds.join(', ')}. Run --list to see them.`);
  return options;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function group(title) {
  process.stdout.write(onActions ? `::group::${title}\n` : `\n=== ${title} ===\n`);
}

function endGroup() {
  if (onActions) process.stdout.write('::endgroup::\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (answered) => {
      socket.destroy();
      resolve(answered);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(1000, () => settle(false));
  });
}

// Reuses a server that is already answering — CI serves the built site for the
// link report — and otherwise owns one for the length of a single check.
async function startSite() {
  if (await portAnswers(SITE_PORT)) return null;
  const child = spawn(
    `npx --yes http-server@14.1.1 site/dist -p ${SITE_PORT} --silent`,
    { cwd: repoRoot, shell: true, stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await portAnswers(SITE_PORT)) return child;
    await sleep(500);
  }
  stopTree(child);
  throw new Error(`The built site did not answer on http://127.0.0.1:${SITE_PORT}/`);
}

// A shell-spawned npx leaves grandchildren, so the process tree goes, not just
// the shell that happens to be its parent.
function stopTree(child) {
  if (!child || child.killed || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync(`taskkill /pid ${child.pid} /T /F`, { shell: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function runCheck(check) {
  const started = Date.now();
  let server = null;
  group(check.title);
  try {
    if (check.prep) {
      spawnSync(check.prep, { cwd: repoRoot, shell: true, stdio: 'inherit' });
    }
    if (check.servesSite) server = await startSite();
    const result = spawnSync(check.command, {
      cwd: path.join(repoRoot, check.cwd || '.'),
      shell: true,
      stdio: 'inherit',
    });
    return { ms: Date.now() - started, ok: result.status === 0 };
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return { ms: Date.now() - started, ok: false };
  } finally {
    if (server) stopTree(server);
    endGroup();
  }
}

function report(results, skipped) {
  const width = Math.max(...results.map((row) => row.check.title.length), 0);
  process.stdout.write('\n');
  process.stdout.write(onActions ? '::group::Check summary\n' : '=== Check summary ===\n');
  for (const row of results) {
    const mark = row.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`  ${mark}  ${row.check.title.padEnd(width)}  ${seconds(row.ms)}\n`);
  }
  for (const check of skipped) {
    process.stdout.write(`  SKIP  ${check.title.padEnd(width)}  (--heavy to run it here; CI always does)\n`);
  }
  endGroup();

  const failed = results.filter((row) => !row.ok);
  for (const row of failed) {
    process.stdout.write(onActions ? `::error::${row.check.title} failed\n` : `\nFAILED: ${row.check.title}\n`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['| | Check | Time |', '| --- | --- | --- |'];
    for (const row of results) lines.push(`| ${row.ok ? 'pass' : 'fail'} | ${row.check.title} | ${seconds(row.ms)} |`);
    for (const check of skipped) lines.push(`| skipped | ${check.title} | |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  return failed.length === 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = CHECKS.filter((check) => options.lanes.includes(check.lane))
    .filter((check) => !options.only.length || options.only.includes(check.id));
  // Naming a check is asking for it, whatever it costs to run.
  const heavy = options.heavy || Boolean(options.only.length) || process.env.MOS_CHECKS_HEAVY === '1' || onActions;
  const wanted = selected.filter((check) => heavy || !check.heavy);
  const skipped = selected.filter((check) => !wanted.includes(check));

  if (options.list) {
    for (const check of selected) {
      process.stdout.write(`${check.lane.padEnd(10)} ${check.id.padEnd(18)} ${check.command}\n`);
    }
    return;
  }

  process.stdout.write(`Running ${wanted.length} check(s): ${options.lanes.join(', ')}\n`);
  const results = [];
  for (const check of wanted) {
    const outcome = await runCheck(check);
    results.push({ check, ...outcome });
    if (!outcome.ok && !options.keepGoing) break;
  }

  process.exitCode = report(results, skipped) ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
