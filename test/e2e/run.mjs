#!/usr/bin/env node
// npm run e2e -- <path>   Compose MOS end-to-end runs from steps and named paths.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { catalogApps } from './support/catalog.mjs';
import { e2eRoot, repoRoot } from './support/env.mjs';
import { NAMED_PATHS, STEPS, resolvePath } from './steps.mjs';

const USAGE = `Usage: npm run e2e -- <steps and @paths> [options]

  npm run e2e -- @full                      the whole platform with every app
  npm run e2e -- @app-cycle <app>           one app: backup, install, use, restore
  npm run e2e -- @app-cycle --each-app      that path for every catalog app, one run each
  npm run e2e -- reset owner install:<app> app:<app>
  npm run e2e -- @smoke dns01 install:<app> verify:<app>
  npm run e2e -- --list                     every step, named path and app

Options:
  --list            the steps and named paths
  --dry-run         print the resolved steps and stop
  --each-app        run a one-app path once per catalog app and print a matrix
  --apps a,b        with --each-app: only these apps
  --headed          show the browser
  --continue <run>  carry an earlier run's app data and screenshots into this one`;

function parseArgs(argv) {
  const options = { apps: null, continueRun: null, dryRun: false, eachApp: false, headed: false, items: [], list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') options.list = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--each-app') options.eachApp = true;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--apps') options.apps = String(argv[++index] || '').split(',').filter(Boolean);
    else if (arg === '--continue') options.continueRun = argv[++index] || null;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.\n\n${USAGE}`);
    else options.items.push(arg);
  }
  return options;
}

function printList(catalog) {
  console.log('Steps (name or name:arg):');
  for (const [name, step] of Object.entries(STEPS)) {
    const shape = { app: `${name}:<app>`, apps: `${name}:<a,b>`, destination: `${name}[:bucket]`, none: name, wait: `${name}[:wait]` }[step.arg];
    console.log(`  ${shape.padEnd(22)} ${step.describe} (≤${step.budgetMinutes} min)`);
  }
  console.log('\nNamed paths:');
  for (const [name, named] of Object.entries(NAMED_PATHS)) {
    const shape = named.app ? `@${name} <app>` : named.apps ? `@${name} [a,b]` : `@${name}`;
    console.log(`  ${shape.padEnd(22)} ${named.describe}`);
  }
  console.log(`\nApps: ${catalog.map((item) => `${item.id}${item.needsHttps ? ' (https)' : ''}${item.hasModule ? '' : ' (no e2e module)'}`).join(', ')}`);
}

function describePlan(plan) {
  return plan.steps.map((step, index) => `  ${String(index + 1).padStart(2)}. ${step.token}${step.auto ? '   (added: the app needs HTTPS)' : ''}`).join('\n');
}

function runId(label) {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15);
  const slug = label.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '').slice(0, 40) || 'path';
  return `${stamp}-${slug}`;
}

function runPlaywright(plan, { continueRun, headed, label }) {
  const id = runId(label);
  const resultsDir = path.join(e2eRoot, 'results', id);
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'plan.json'), `${JSON.stringify({ ...plan, continueRun, label }, null, 2)}\n`);
  console.log(`\n${label}  →  test/e2e/results/${id}/`);
  const cli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'test', '--config', path.join(e2eRoot, 'playwright.lab.config.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, MOS_E2E_HEADED: headed ? '1' : process.env.MOS_E2E_HEADED || '0', MOS_E2E_RUN_ID: id },
    stdio: 'inherit',
  });
  const summaryPath = path.join(resultsDir, 'summary.json');
  const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : { status: 'crashed', steps: [] };
  return { id, status: result.status === 0 ? 'passed' : summary.status === 'passed' ? 'failed' : summary.status, summary };
}

function printMatrix(rows) {
  console.log('\nMatrix:');
  for (const row of rows) {
    const failed = row.summary.steps?.find((step) => step.status !== 'passed');
    const minutes = Math.round((row.summary.durationMs || 0) / 60000);
    console.log(`  ${row.status === 'passed' ? '✓' : '✗'} ${row.app.padEnd(16)} ${String(minutes).padStart(3)} min  ${failed ? `failed at ${failed.title}` : ''}  results/${row.id}/`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = catalogApps();
  if (options.help || (!options.items.length && !options.list)) {
    console.log(USAGE);
    return 0;
  }
  if (options.list) {
    printList(catalog);
    return 0;
  }

  if (!options.eachApp) {
    const plan = resolvePath(options.items, catalog);
    if (plan.errors.length) throw new Error(plan.errors.join('\n'));
    if (options.dryRun) {
      console.log(`${options.items.join(' ')}  (${plan.steps.length} steps, budget ${plan.budgetMinutes} min)\n${describePlan(plan)}`);
      return 0;
    }
    return runPlaywright(plan, { continueRun: options.continueRun, headed: options.headed, label: options.items.join(' ') }).status === 'passed' ? 0 : 1;
  }

  const apps = (options.apps || catalog.filter((item) => item.hasModule).map((item) => item.id));
  const plans = apps.map((app) => ({ app, plan: resolvePath(options.items, catalog, { eachApp: app }) }));
  const errors = plans.flatMap(({ plan }) => plan.errors);
  if (errors.length) throw new Error([...new Set(errors)].join('\n'));
  if (options.dryRun) {
    for (const { app, plan } of plans) console.log(`\n${options.items.join(' ')} ${app}  (budget ${plan.budgetMinutes} min)\n${describePlan(plan)}`);
    return 0;
  }
  const rows = plans.map(({ app, plan }) => ({ app, ...runPlaywright(plan, { headed: options.headed, label: `${options.items.join(' ')} ${app}` }) }));
  printMatrix(rows);
  return rows.every((row) => row.status === 'passed') ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
