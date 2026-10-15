const assert = require('node:assert/strict');
const test = require('node:test');

const { AppInstallJobs } = require('../src/apps/app-install-jobs.cjs');

const OPEN = { publicUrl: 'https://immich.example.org/', seconds: 6, status: 'ready' };
const NO_CERTIFICATE = { awaiting: 'certificate', lastProbe: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', publicUrl: 'https://immich.example.org/', seconds: 300, status: 'waiting' };

function fakeApp({ addresses = [OPEN], now, start } = {}) {
  const calls = [];
  const state = { homepageApplied: false, installed: false, runtimeApplied: false };
  const jobs = new AppInstallJobs({
    addToHomepage: async () => { calls.push('homepage'); state.homepageApplied = true; },
    now,
    prepare: async (_id, config) => { calls.push(['prepare', config]); state.installed = true; },
    progressOf: () => ({ ...state }),
    start: start || (async () => { calls.push('start'); state.runtimeApplied = true; }),
    waitForAddress: async () => { calls.push('address'); return addresses.length > 1 ? addresses.shift() : addresses[0]; },
  });
  return { calls, jobs, state };
}

const statuses = (job) => Object.fromEntries(job.steps.map((step) => [step.id, step.status]));

test('an install runs to its Homepage shortcut with nobody waiting on the request', async () => {
  const { calls, jobs } = fakeApp();
  const begun = jobs.begin('immich', { config: { region: 'eu' }, showOnHomepage: true });
  assert.equal(begun.status, 'running');

  await jobs.lastRun;
  const job = jobs.get('immich');
  assert.equal(job.status, 'succeeded');
  assert.equal(job.notice, null);
  assert.deepEqual(statuses(job), { address: 'complete', homepage: 'complete', prepare: 'complete', ready: 'complete', runtime: 'complete' });
  assert.deepEqual(calls, [['prepare', { region: 'eu' }], 'start', 'address', 'homepage']);
});

test('a second install of the same app while one runs is refused', async () => {
  let release;
  const { jobs } = fakeApp({ start: () => new Promise((resolve) => { release = resolve; }) });
  jobs.begin('immich');
  assert.throws(() => jobs.begin('immich'), (error) => error.code === 'APP_OPERATION_IN_PROGRESS' && error.statusCode === 409);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await jobs.lastRun;
  assert.equal(jobs.begin('immich').status, 'running', 'a finished job does not block the next one');
});

test('a retry skips what already happened and finishes what did not', async () => {
  const { calls, jobs, state } = fakeApp();
  Object.assign(state, { installed: true, runtimeApplied: true });
  jobs.begin('immich', { showOnHomepage: true });
  await jobs.lastRun;
  assert.deepEqual(statuses(jobs.get('immich')), { address: 'complete', homepage: 'complete', prepare: 'skipped', ready: 'complete', runtime: 'skipped' });
  assert.deepEqual(calls, [['prepare', {}], 'address', 'homepage']);
});

test('a failed step is named and keeps its reason for the page to show', async () => {
  const { jobs } = fakeApp({ start: async () => { throw Object.assign(new Error('The app container could not be started.'), { code: 'APP_RUN_FAILED' }); } });
  jobs.begin('immich', { showOnHomepage: true });
  await jobs.lastRun;
  const job = jobs.get('immich');
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.error, { code: 'APP_RUN_FAILED', message: 'The app container could not be started.' });
  assert.deepEqual(statuses(job), { address: 'pending', homepage: 'pending', prepare: 'complete', ready: 'pending', runtime: 'failed' });
});

test('an address still waiting for its certificate finishes the install with a notice, cleared once it opens', async () => {
  const { calls, jobs } = fakeApp({ addresses: [NO_CERTIFICATE, NO_CERTIFICATE, OPEN] });
  jobs.begin('immich', { showOnHomepage: true });
  await jobs.lastRun;

  const job = jobs.get('immich');
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(statuses(job), { address: 'complete', homepage: 'complete', prepare: 'complete', ready: 'complete', runtime: 'complete' });
  assert.match(job.notice.message, /^immich\.example\.org does not open yet because its certificate has not arrived\./u);
  assert.equal(job.notice.detail, 'Last attempt on immich.example.org: ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR');

  await jobs.lastFollowUp;
  assert.equal(jobs.get('immich').notice, null);
  assert.deepEqual(calls.filter((call) => call === 'address'), ['address', 'address', 'address']);
});

test('a running step says how long it has run by the server clock', async () => {
  let clock = Date.parse('2026-10-06T20:00:00Z');
  let release;
  const { jobs } = fakeApp({ now: () => clock, start: () => new Promise((resolve) => { release = resolve; }) });
  jobs.begin('paperless-ngx');
  await new Promise((resolve) => setImmediate(resolve));
  clock += 99_000;

  const runtime = jobs.get('paperless-ngx').steps.find((step) => step.id === 'runtime');
  assert.deepEqual([runtime.status, runtime.seconds], ['running', 99]);
  assert.equal(jobs.get('paperless-ngx').steps.find((step) => step.id === 'prepare').seconds, undefined);
  release();
  await jobs.lastRun;
});
