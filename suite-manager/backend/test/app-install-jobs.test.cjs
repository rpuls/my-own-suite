const assert = require('node:assert/strict');
const test = require('node:test');

const { AppInstallJobs } = require('../src/apps/app-install-jobs.cjs');

function fakeApp({ start } = {}) {
  const calls = [];
  const state = { homepageApplied: false, installed: false, runtimeApplied: false };
  const jobs = new AppInstallJobs({
    addToHomepage: async () => { calls.push('homepage'); state.homepageApplied = true; },
    prepare: async (_id, config) => { calls.push(['prepare', config]); state.installed = true; },
    progressOf: () => ({ ...state }),
    start: start || (async () => { calls.push('start'); state.runtimeApplied = true; }),
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
  assert.deepEqual(statuses(job), { homepage: 'complete', prepare: 'complete', ready: 'complete', runtime: 'complete' });
  assert.deepEqual(calls, [['prepare', { region: 'eu' }], 'start', 'homepage']);
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
  assert.deepEqual(statuses(jobs.get('immich')), { homepage: 'complete', prepare: 'skipped', ready: 'complete', runtime: 'skipped' });
  assert.deepEqual(calls, [['prepare', {}], 'homepage']);
});

test('a failed step is named and keeps its reason for the page to show', async () => {
  const { jobs } = fakeApp({ start: async () => { throw Object.assign(new Error('The app container could not be started.'), { code: 'APP_RUN_FAILED' }); } });
  jobs.begin('immich', { showOnHomepage: true });
  await jobs.lastRun;
  const job = jobs.get('immich');
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.error, { code: 'APP_RUN_FAILED', message: 'The app container could not be started.' });
  assert.deepEqual(statuses(job), { homepage: 'pending', prepare: 'complete', ready: 'pending', runtime: 'failed' });
});
