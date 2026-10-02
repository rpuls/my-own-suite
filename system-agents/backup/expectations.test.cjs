const assert = require('node:assert/strict');
const test = require('node:test');

const { checkExpectation, listNames, rangeWords, restoreExpectation, runningExpectation } = require('./expectations.cjs');

const GB = 1024 ** 3;

// One finished job as the agent records it: a timeline of stages with times,
// and the subject it worked on.
function job(kind, stages, { sizeBytes = null, status = 'succeeded' } = {}) {
  let clock = Date.parse('2026-09-08T10:00:00.000Z');
  const timeline = stages.map(([stage, seconds]) => {
    const startedAt = new Date(clock).toISOString();
    clock += seconds * 1000;
    return { endedAt: new Date(clock).toISOString(), stage, startedAt };
  });
  return { kind, status, subject: sizeBytes ? { sizeBytes } : null, timeline };
}

// The 2026-09-08 lab restore of a six-app suite from a bucket.
const LAB_RESTORE = job('restore', [
  ['Checking the backup', 275],
  ['Checking required space', 3],
  ['Stopping current runtime', 8],
  ['Saving pre-restore rescue copy', 40],
  ['Restoring suite state', 5],
  ['Restoring app volumes', 87],
  ['Rebuilding app runtime', 677],
  ['Verifying restored state', 2],
  ['Starting restored control plane', 4],
], { sizeBytes: 14 * GB });

const SIX_APPS = [
  { displayName: 'Immich', packageId: 'immich' },
  { displayName: 'Paperless-ngx', packageId: 'paperless-ngx' },
  { displayName: 'ONLYOFFICE', packageId: 'onlyoffice' },
  { displayName: 'Stirling PDF', packageId: 'stirling-pdf' },
  { displayName: 'Radicale', packageId: 'radicale' },
  { displayName: 'Vaultwarden', packageId: 'vaultwarden' },
];

const SIX_TIMINGS = {
  immich: { displayName: 'Immich', samples: [{ seconds: 40 }] },
  onlyoffice: { displayName: 'ONLYOFFICE', samples: [{ seconds: 361 }, { seconds: 350 }] },
  'paperless-ngx': { displayName: 'Paperless-ngx', samples: [{ seconds: 150 }] },
  radicale: { displayName: 'Radicale', samples: [{ seconds: 10 }] },
  'stirling-pdf': { displayName: 'Stirling PDF', samples: [{ seconds: 120 }] },
  vaultwarden: { displayName: 'Vaultwarden', samples: [{ seconds: 15 }] },
};

test('with no history at all, a restore is a stated range that names the apps and says it is not a measurement', () => {
  const expectation = restoreExpectation({ apps: SIX_APPS, sizeBytes: 14 * GB });
  assert.equal(expectation.basis, 'guess');
  assert.equal(expectation.seconds, null);
  assert.equal(expectation.dominant, null);
  assert.match(expectation.sentence, /^Restoring Immich, Paperless-ngx, ONLYOFFICE and 3 more\. MOS has not timed a restore on this machine yet; a suite this size usually takes \d+ to \d+ minutes on a small server, nearly all of it rebuilding the apps\.$/u);
  assert.match(expectation.note, /not on how much data/u);
  // The range grows with the number of apps, not with the gigabytes.
  const oneApp = restoreExpectation({ apps: SIX_APPS.slice(0, 1), sizeBytes: 14 * GB });
  const sameAppsMoreData = restoreExpectation({ apps: SIX_APPS, sizeBytes: 28 * GB });
  assert.ok(oneApp.high < expectation.high);
  assert.ok(sameAppsMoreData.high - expectation.high < expectation.high - oneApp.high);
});

test('with this machine\'s own restore and every app timed, the estimate is a measurement and names what dominates', () => {
  const expectation = restoreExpectation({ apps: SIX_APPS, buildTimings: SIX_TIMINGS, history: [LAB_RESTORE], sizeBytes: 14 * GB });
  assert.equal(expectation.basis, 'measured');
  // check 275 + apps (40+356+150+120+10+15 = 691) + remainder 149 = 1115 s.
  assert.equal(expectation.seconds, 1115);
  assert.deepEqual(expectation.dominant, { displayName: 'ONLYOFFICE', packageId: 'onlyoffice', seconds: 356 });
  assert.equal(expectation.sentence, 'Restoring Immich, Paperless-ngx, ONLYOFFICE and 3 more. On this machine expect about 19 minutes. Rebuilding the apps is most of it, and ONLYOFFICE alone usually takes 6 minutes.');
});

test('with some apps timed and some not, the estimate is a range that says which it has not timed', () => {
  const timings = { onlyoffice: SIX_TIMINGS.onlyoffice, 'paperless-ngx': SIX_TIMINGS['paperless-ngx'] };
  const expectation = restoreExpectation({ apps: SIX_APPS, buildTimings: timings, history: [LAB_RESTORE], sizeBytes: 14 * GB });
  assert.equal(expectation.basis, 'partly');
  assert.equal(expectation.seconds, null);
  assert.match(expectation.sentence, /Expect roughly \d+ to \d+ minutes on this machine, most of it rebuilding the apps\. ONLYOFFICE alone usually takes 6 minutes here\. MOS has not yet timed Immich, Stirling PDF, Radicale and 1 more on this machine\.$/u);
  assert.ok(expectation.low < expectation.high);
  // Timed apps count at their measured time in both ends of the range.
  assert.ok(expectation.low >= 275 + 356 + 150 + 149);
});

test('a check is scaled by size from this machine\'s history, and is a range without it', () => {
  const guess = checkExpectation({ sizeBytes: 14 * GB });
  assert.equal(guess.basis, 'guess');
  assert.equal(guess.seconds, null);
  assert.match(guess.sentence, /^MOS has not timed a check on this machine yet; a backup this size usually takes \d+ to \d+ minutes\. It reads every piece of the backup/u);
  assert.match(checkExpectation({}).sentence, /one usually takes 5 to 15 minutes/u);

  const measured = checkExpectation({ history: [LAB_RESTORE], sizeBytes: 14 * GB });
  assert.equal(measured.basis, 'measured');
  assert.equal(measured.seconds, 275);
  assert.equal(measured.sentence, 'On this machine a check of this backup takes about 5 minutes.');

  // Twice the data at the measured rate is twice the time, not last time's.
  const bigger = checkExpectation({ history: [LAB_RESTORE], sizeBytes: 28 * GB });
  assert.equal(bigger.seconds, 550);

  // A stand-alone check counts as history for the next one, and a failed job
  // does not.
  const check = job('validate', [['Checking the backup', 120]], { sizeBytes: 7 * GB });
  assert.equal(checkExpectation({ history: [check], sizeBytes: 14 * GB }).seconds, 240);
  const failed = job('validate', [['Checking the backup', 1]], { sizeBytes: 7 * GB, status: 'failed' });
  assert.equal(checkExpectation({ history: [failed], sizeBytes: 14 * GB }).basis, 'guess');
});

test('a history that recorded no sizes still gives a median rather than nothing', () => {
  const unsized = [job('validate', [['Checking the backup', 100]]), job('validate', [['Checking the backup', 300]]), job('validate', [['Checking the backup', 200]])];
  assert.equal(checkExpectation({ history: unsized, sizeBytes: 14 * GB }).seconds, 200);
});

test('the sentence a running job carries says the timing and the basis, and nothing for a delete', () => {
  const measured = runningExpectation('restore', { apps: SIX_APPS, buildTimings: SIX_TIMINGS, history: [LAB_RESTORE], sizeBytes: 14 * GB });
  assert.equal(measured.sentence, 'On this machine this usually takes about 19 minutes. Rebuilding the apps is the slow part; ONLYOFFICE alone usually takes 6 minutes.');
  const guess = runningExpectation('restore', { apps: SIX_APPS, sizeBytes: 14 * GB });
  assert.match(guess.sentence, /^MOS has not timed a restore on this machine yet; a suite this size usually takes \d+ to \d+ minutes\. Rebuilding the apps is the slow part\.$/u);
  const check = runningExpectation('validate', { history: [LAB_RESTORE], sizeBytes: 14 * GB });
  assert.equal(check.sentence, 'On this machine this usually takes about 5 minutes.');
  assert.equal(runningExpectation('delete', {}), null);
  assert.equal(runningExpectation('backup', {}), null);
});

test('names and ranges read as prose', () => {
  assert.equal(listNames([]), '');
  assert.equal(listNames(['Immich']), 'Immich');
  assert.equal(listNames(['Immich', 'Radicale']), 'Immich and Radicale');
  assert.equal(listNames(['Immich', 'Radicale', 'Seafile']), 'Immich, Radicale and Seafile');
  assert.equal(listNames(['Immich', 'Radicale', 'Seafile', 'Vaultwarden']), 'Immich, Radicale, Seafile and 1 more');
  assert.equal(rangeWords(6 * 60, 14 * 60), '6 to 15 minutes');
  assert.equal(rangeWords(6 * 60, 9 * 60), '6 to 9 minutes');
  assert.equal(rangeWords(13 * 60, 34 * 60), '10 to 35 minutes');
  assert.equal(rangeWords(0, 10), '1 to 2 minutes');
});
