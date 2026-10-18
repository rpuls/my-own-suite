const assert = require('node:assert/strict');
const test = require('node:test');

const { DriveJobs } = require('../src/apps/drive-jobs.cjs');

test('one action at a time per drive, and a refusal reaches the panel in its own words', async () => {
  let finish;
  const jobs = new DriveJobs({ perform: (driveId, action) => (action === 'check' ? new Promise((resolve) => { finish = resolve; }) : Promise.reject(Object.assign(new Error('Something on the server is still using this drive.'), { code: 'APP_STORAGE_UNAVAILABLE' }))) });

  assert.equal(jobs.begin('A1B2-0000', { action: 'check' }).steps[0].status, 'running');
  assert.throws(() => jobs.begin('A1B2-0000', { action: 'eject' }), /already working on this drive/u);
  finish();
  await jobs.lastRun;
  assert.equal(jobs.get('A1B2-0000').status, 'succeeded');

  jobs.begin('A1B2-0000', { action: 'eject' });
  await jobs.lastRun;
  assert.deepEqual(jobs.get('A1B2-0000').error, { code: 'APP_STORAGE_UNAVAILABLE', message: 'Something on the server is still using this drive.' });
});
