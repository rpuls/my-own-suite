import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MODULES } from '../e2e/modules/index.mjs';
import { NAMED_PATHS, STEPS, parseToken, resolvePath } from '../e2e/steps.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const catalog = [
  { hasModule: true, id: 'plain-a', needsHttps: false },
  { hasModule: true, id: 'plain-b', needsHttps: false },
  { hasModule: true, id: 'secure-c', needsHttps: true },
  { hasModule: false, id: 'unfinished', needsHttps: false },
];

const tokens = (plan) => plan.steps.map((step) => step.token);

test('every step token has a module that runs it, and every module a token', () => {
  assert.deepEqual(Object.keys(MODULES).sort(), Object.keys(STEPS).sort());
});

test('a token splits into its step and argument', () => {
  assert.deepEqual(parseToken('install:plain-a'), { arg: 'plain-a', name: 'install' });
  assert.deepEqual(parseToken('installed:'), { arg: '', name: 'installed' });
  assert.deepEqual(parseToken('reset'), { arg: null, name: 'reset' });
});

test('a named path expands for the app given after it', () => {
  const plan = resolvePath(['@app-cycle', 'plain-a'], catalog);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(tokens(plan), NAMED_PATHS['app-cycle'].build('plain-a'));
  assert.ok(plan.budgetMinutes > 0);
});

test('dns01 goes in front of the first step that needs HTTPS, once per reset', () => {
  const plan = resolvePath(['reset', 'owner', 'install:secure-c', 'app:secure-c', 'reset', 'owner', 'verify:secure-c'], catalog);
  assert.deepEqual(tokens(plan), ['reset', 'owner', 'dns01', 'install:secure-c', 'app:secure-c', 'reset', 'owner', 'dns01', 'verify:secure-c']);
  assert.deepEqual(plan.steps.filter((step) => step.auto).length, 2);
});

test('a lab that starts on HTTPS gets no dns01, before or after a reset', () => {
  const plan = resolvePath(['owner', 'install:secure-c', 'reset', 'owner', 'verify:secure-c'], catalog, { startsSecure: true });
  assert.deepEqual(tokens(plan), ['owner', 'install:secure-c', 'reset', 'owner', 'verify:secure-c']);
});

test('a lab with no backup disk sends plain backups and restores to the bucket', () => {
  const steps = tokens(resolvePath(['@full'], catalog, { backupTo: 'bucket' }));
  assert.ok(steps.includes('backup:bucket') && steps.includes('restore:bucket'));
  assert.ok(!steps.includes('backup') && !steps.includes('restore'));
});

test('an app that works over http gets no dns01', () => {
  assert.ok(!tokens(resolvePath(['@app-cycle', 'plain-a'], catalog)).includes('dns01'));
});

test('@full installs plain apps before the domain and secure ones after it', () => {
  const steps = tokens(resolvePath(['@full'], catalog));
  const dns = steps.indexOf('dns01');
  assert.ok(steps.indexOf('install:plain-a') < steps.indexOf('backup'), 'the first app is in the backup that is restored');
  assert.ok(steps.indexOf('install:plain-b') < dns);
  assert.ok(steps.indexOf('install:secure-c') > dns);
  assert.ok(!steps.some((token) => token.endsWith(':unfinished')), 'an app without an e2e module is left out');
  assert.equal(steps.filter((token) => token === 'dns01').length, 1);
});

test('@full takes an explicit app list', () => {
  const steps = tokens(resolvePath(['@full', 'plain-b'], catalog));
  assert.ok(steps.includes('install:plain-b'));
  assert.ok(!steps.includes('install:plain-a'));
});

test('--each-app fills the app of a one-app path', () => {
  assert.ok(tokens(resolvePath(['@app-dr'], catalog, { eachApp: 'plain-b' })).includes('verify:plain-b'));
});

test('the drill paths bring the apps an app works with, providers first, and update only that app', () => {
  const paired = [
    ...catalog,
    { accepts: ['document-editor'], hasModule: true, id: 'files', needsHttps: false, provides: ['document-platform'] },
    { accepts: [], hasModule: true, id: 'office', needsHttps: false, provides: ['document-editor'] },
  ];
  const together = ['install:office', 'install:files', 'connect', 'app:office', 'app:files'];
  for (const app of ['files', 'office']) {
    const update = tokens(resolvePath(['@update', app], paired));
    assert.deepEqual(update.slice(2, 7), together, `@update ${app}`);
    assert.deepEqual(update.filter((token) => token.startsWith('update:')), [`update:${app}`]);
    assert.deepEqual(update.filter((token) => token.startsWith('verify:')), ['verify:office', 'verify:files']);
    const recovery = tokens(resolvePath(['@app-dr', app], paired));
    assert.deepEqual(recovery.slice(2, 7), together, `@app-dr ${app}`);
    assert.deepEqual(recovery.slice(recovery.indexOf('restore:bucket') + 1, -3), ['verify:office', 'verify:files']);
  }
});

test('an app that works with no other app is drilled alone', () => {
  assert.deepEqual(tokens(resolvePath(['@update', 'plain-a'], catalog)),
    ['reset', 'owner', 'install:plain-a', 'app:plain-a', 'platform-update:wait', 'update:plain-a', 'verify:plain-a', 'routes', 'compare', 'network']);
  assert.ok(!tokens(resolvePath(['@app-dr', 'plain-a'], catalog)).includes('connect'));
});

test('mistakes are reported, not run', () => {
  assert.match(resolvePath(['nonsense'], catalog).errors[0], /Unknown step "nonsense"/u);
  assert.match(resolvePath(['install'], catalog).errors[0], /needs an app/u);
  assert.match(resolvePath(['install:nowhere'], catalog).errors[0], /names no catalog app/u);
  assert.match(resolvePath(['backup:cloud'], catalog).errors[0], /not a destination/u);
  assert.match(resolvePath(['@app-cycle'], catalog).errors[0], /needs an app/u);
  assert.match(resolvePath(['@nope'], catalog).errors[0], /Unknown path/u);
});

test('the real catalog resolves every named path', () => {
  const real = fs.readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, 'apps', entry.name, 'manifest.json')))
    .map((entry) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', entry.name, 'manifest.json'), 'utf8'));
      return { hasModule: true, id: manifest.id, needsHttps: manifest.requirements?.https === true };
    });
  for (const name of Object.keys(NAMED_PATHS)) {
    const items = NAMED_PATHS[name].app ? [`@${name}`, real[0].id] : [`@${name}`];
    assert.deepEqual(resolvePath(items, real).errors, [], `@${name} should resolve against the real catalog`);
  }
});

test('compare pairs the first and last time a screen was taken, across steps and runs', async () => {
  const { pairShots } = await import('../e2e/modules/compare.mjs');
  const shot = (app, name, runId, stepIndex) => ({ app, file: `${runId}/${stepIndex}/${name}.png`, name, runId, step: `step-${stepIndex}`, stepIndex });
  const pairs = pairShots([
    shot('app-a', 'home', 'run-1', 3),
    shot('app-a', 'home', 'run-2', 1),
    shot('app-a', 'home', 'run-2', 5),
    shot('app-a', 'once', 'run-1', 3),
    shot('app-b', 'list', 'run-1', 2),
    shot('app-b', 'list', 'run-1', 2),
  ]);
  assert.deepEqual(pairs.map((pair) => `${pair.app}/${pair.name}: ${pair.before.file} -> ${pair.after.file}`), ['app-a/home: run-1/3/home.png -> run-2/5/home.png']);
});
