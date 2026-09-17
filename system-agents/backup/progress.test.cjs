const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  JOB_PLANS,
  PROGRESS_FILENAME,
  PUBLIC_PROGRESS_KEYS,
  ProgressPublisher,
  STAGE_WORDS,
  advanceTimeline,
  closeTimeline,
  minutesWords,
  progressFor,
  publicProgress,
  stageSentence,
} = require('./progress.cjs');

// Every stage in every plan has owner words, and the sentence for a stage the
// engine names but the plan does not is still its own, not the raw stage id
// of something else.
test('every planned stage has a sentence in the owner\'s words', () => {
  for (const stages of Object.values(JOB_PLANS)) {
    for (const stage of stages) {
      assert.ok(STAGE_WORDS[stage], `${stage} has no owner words`);
      assert.notEqual(stageSentence(stage), stage);
    }
  }
  assert.equal(stageSentence(null), 'Getting ready');
  assert.equal(stageSentence('queued'), 'Getting ready');
  assert.equal(stageSentence('starting'), 'Getting ready');
  assert.equal(stageSentence('Reclaiming space from an interrupted backup'), 'Tidying up after a backup that stopped');
});

test('step N of M comes from the agent\'s own plan, and a stage outside the plan keeps its place', () => {
  const now = '2026-09-17T01:00:00.000Z';
  const job = { kind: 'restore', stage: 'Checking the backup' };
  let progress = progressFor(job, { now });
  assert.equal(progress.headline, 'Restoring your backup');
  assert.equal(progress.sentence, 'Reading the backup');
  assert.deepEqual([progress.step, progress.steps], [1, 9]);
  assert.equal(progress.startedAt, now);
  assert.deepEqual(progress.plan.map((entry) => entry.state), ['now', 'next', 'next', 'next', 'next', 'next', 'next', 'next', 'next']);

  job.progress = progress;
  job.stage = 'Restoring app volumes';
  progress = progressFor(job, { now: '2026-09-17T01:05:00.000Z' });
  assert.deepEqual([progress.step, progress.steps], [6, 9]);
  assert.equal(progress.startedAt, now, 'the start time is the first stage\'s, not the latest');
  assert.deepEqual(progress.plan.map((entry) => entry.state).slice(4, 8), ['done', 'now', 'next', 'next']);

  // A backup that first reclaims space left by an interrupted one reports that
  // sentence without inventing a tenth step.
  const backup = { kind: 'backup', stage: 'Preparing backup' };
  backup.progress = progressFor(backup, { now });
  backup.stage = 'Reclaiming space from an interrupted backup';
  const reclaiming = progressFor(backup, { now });
  assert.equal(reclaiming.sentence, 'Tidying up after a backup that stopped');
  assert.deepEqual([reclaiming.step, reclaiming.steps], [1, 8]);
});

test('a count inside a stage names the app and says which of how many', () => {
  const job = { kind: 'restore', stage: 'Rebuilding app runtime' };
  const withCurrent = progressFor(job, { count: { current: 'ONLYOFFICE', done: 2, expectSeconds: 361, total: 6, unit: 'apps' } });
  assert.equal(withCurrent.count.sentence, 'ONLYOFFICE — 3 of 6 apps');
  assert.equal(withCurrent.count.note, 'ONLYOFFICE usually takes 6 minutes on this machine.');
  assert.deepEqual([withCurrent.count.done, withCurrent.count.total], [2, 6]);

  const volumes = progressFor(job, { count: { current: 'Seafile', done: 15, total: 16, unit: 'volumes' } });
  assert.equal(volumes.count.sentence, 'Seafile — 16 of 16 data stores');
  assert.equal(volumes.count.note, null);

  const finished = progressFor(job, { count: { done: 6, total: 6, unit: 'apps' } });
  assert.equal(finished.count.sentence, '6 of 6 apps done');
  assert.equal(progressFor(job, { count: { done: 0, total: 0, unit: 'apps' } }).count, null);
  assert.equal(progressFor(job).count, null);
});

test('the expectation on the job reaches the progress record as one sentence', () => {
  const job = { expect: { basis: 'guess', low: 600, sentence: 'MOS has not timed a restore on this machine yet.', high: 1800 }, kind: 'restore', stage: 'Checking the backup' };
  assert.deepEqual(progressFor(job).expect, { sentence: 'MOS has not timed a restore on this machine yet.' });
  assert.equal(progressFor({ kind: 'restore', stage: 'Checking the backup' }).expect, null);
});

// The busy page is shown to whoever can reach the server's address, with no
// session. The file it reads carries sentences, counts, app names and
// timestamps and nothing else: no stage ids, no job id, no paths.
test('the public file carries only what the busy page shows', () => {
  const job = { expect: { sentence: 'About 17 minutes.' }, id: 'b7d5b6c1-0000-4000-8000-000000000000', kind: 'restore', stage: 'Restoring app volumes' };
  const record = publicProgress(progressFor(job, { count: { current: 'Seafile', done: 3, total: 16, unit: 'volumes' }, now: '2026-09-17T01:00:00.000Z' }));
  assert.deepEqual(Object.keys(record).sort(), [...PUBLIC_PROGRESS_KEYS].sort());
  assert.deepEqual(Object.keys(record.count).sort(), ['current', 'done', 'note', 'sentence', 'total']);
  assert.deepEqual(Object.keys(record.expect), ['sentence']);
  for (const entry of record.plan) assert.deepEqual(Object.keys(entry).sort(), ['sentence', 'state']);
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /b7d5b6c1|Restoring app volumes|mos-app-|\/var\/|\/media\/|\/etc\//u);
  assert.match(text, /Putting your app data back/u);
  assert.match(text, /Seafile — 4 of 16 data stores/u);
  assert.equal(publicProgress(null), null);
});

test('the publisher writes the file whole, and clearing leaves nothing behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-status-'));
  const publisher = new ProgressPublisher({ dir: path.join(dir, 'mos-status') });
  const progress = progressFor({ kind: 'validate', stage: 'Checking the backup' });
  assert.equal(publisher.publish(progress), true);
  assert.equal(publisher.present(), true);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'mos-status', PROGRESS_FILENAME), 'utf8'));
  assert.equal(written.headline, 'Checking a backup');
  assert.deepEqual([written.step, written.steps], [1, 1]);
  assert.equal(fs.existsSync(path.join(dir, 'mos-status', `${PROGRESS_FILENAME}.next`)), false, 'the temp file is renamed away');

  assert.equal(publisher.clear(), true);
  assert.equal(publisher.present(), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mos-status')), []);
  // Publishing nothing is the same as clearing: a job that is over has no page.
  publisher.publish(progress);
  publisher.publish(null);
  assert.equal(publisher.present(), false);
});

test('a directory that cannot be written costs the job nothing', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-status-')), 'not-a-dir');
  fs.writeFileSync(file, 'occupied');
  const publisher = new ProgressPublisher({ dir: path.join(file, 'mos-status') });
  assert.equal(publisher.publish(progressFor({ kind: 'backup', stage: 'Preparing backup' })), false);
  assert.equal(publisher.clear(), true);
});

test('the timeline records when each stage started and ended', () => {
  const job = {};
  advanceTimeline(job, 'Checking the backup', '2026-09-17T01:00:00.000Z');
  advanceTimeline(job, 'Checking required space', '2026-09-17T01:04:35.000Z');
  closeTimeline(job, '2026-09-17T01:04:40.000Z');
  assert.deepEqual(job.timeline, [
    { endedAt: '2026-09-17T01:04:35.000Z', stage: 'Checking the backup', startedAt: '2026-09-17T01:00:00.000Z' },
    { endedAt: '2026-09-17T01:04:40.000Z', stage: 'Checking required space', startedAt: '2026-09-17T01:04:35.000Z' },
  ]);
  // Closing twice, or with nothing open, changes nothing.
  closeTimeline(job, '2026-09-17T02:00:00.000Z');
  assert.equal(job.timeline[1].endedAt, '2026-09-17T01:04:40.000Z');
  closeTimeline({});
});

test('minutes are said the way an owner would say them', () => {
  assert.equal(minutesWords(20), 'under a minute');
  assert.equal(minutesWords(50), 'a minute');
  assert.equal(minutesWords(361), '6 minutes');
  assert.equal(minutesWords(17.5 * 60), '18 minutes');
  assert.equal(minutesWords(23 * 60), '25 minutes');
  assert.equal(minutesWords(null), null);
  assert.equal(minutesWords(-1), null);
});
