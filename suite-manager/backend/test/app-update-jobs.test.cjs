const assert = require('node:assert/strict');
const test = require('node:test');

const { AppUpdateJobs } = require('../src/apps/app-update-jobs.cjs');

const statuses = (job) => job.steps.map((step) => `${step.id}:${step.status}`);

test('each step completes as the update saga reaches the next one', async () => {
  const seen = [];
  const jobs = new AppUpdateJobs({
    stage: async (_packageId, input, onStage) => {
      seen.push(input);
      for (const stage of ['build', 'switch', 'finish']) {
        onStage(stage);
        seen.push(statuses(jobs.get('immich')).join(' '));
      }
    },
  });
  jobs.begin('immich', { confirmationToken: 'a'.repeat(64) });
  await jobs.lastRun;

  assert.deepEqual(seen, [
    { confirmationToken: 'a'.repeat(64) },
    'check:complete build:running switch:pending finish:pending',
    'check:complete build:complete switch:running finish:pending',
    'check:complete build:complete switch:complete finish:running',
  ]);
  assert.equal(jobs.get('immich').status, 'succeeded');
  assert.deepEqual(statuses(jobs.get('immich')), ['check:complete', 'build:complete', 'switch:complete', 'finish:complete']);
});

test('a failed update names the step it stopped at and keeps the reason', async () => {
  const warnings = [];
  const jobs = new AppUpdateJobs({
    logger: { warn: (event, fields) => warnings.push([event, fields]) },
    stage: async (_packageId, _input, onStage) => {
      onStage('build');
      throw Object.assign(new Error('The new version could not be built.'), { code: 'APP_BUILD_FAILED' });
    },
  });
  jobs.begin('immich', {});
  await jobs.lastRun;

  const job = jobs.get('immich');
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.error, { code: 'APP_BUILD_FAILED', message: 'The new version could not be built.' });
  assert.deepEqual(statuses(job), ['check:complete', 'build:failed', 'switch:pending', 'finish:pending']);
  assert.deepEqual(warnings, [['app-update-failed', { code: 'APP_BUILD_FAILED', packageId: 'immich', step: 'build' }]]);
});

test('a second update of the same app while one runs is refused', async () => {
  let release;
  const jobs = new AppUpdateJobs({ stage: () => new Promise((resolve) => { release = resolve; }) });
  jobs.begin('immich', {});
  assert.throws(() => jobs.begin('immich', {}), (error) => error.code === 'APP_OPERATION_IN_PROGRESS' && error.statusCode === 409);
  release();
  await jobs.lastRun;
});
