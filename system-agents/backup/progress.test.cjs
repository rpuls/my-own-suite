const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  JOB_GROUPS,
  JOB_PLANS,
  PROGRESS_FILENAME,
  PUBLIC_PROGRESS_KEYS,
  ProgressPublisher,
  STAGE_STEPS,
  STAGE_WORDS,
  advanceTimeline,
  closeTimeline,
  minutesWords,
  progressFor,
  publicProgress,
  stageSentence,
} = require('./progress.cjs');

const sentences = (progress) => progress.plan.map((group) => group.sentence);
const states = (progress) => progress.plan.map((group) => group.state);
const lines = (progress, group) => progress.plan[group].steps.map((step) => [step.state, step.sentence]);

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
  for (const parts of Object.values(STAGE_STEPS)) {
    for (const part of parts) {
      assert.ok(STAGE_WORDS[part], `${part} has no owner words`);
      assert.notEqual(stageSentence(part), part);
    }
  }
  // A group is a heading over the lines shown under it, so a title that
  // repeats one of its own lines is a line said twice.
  for (const [kind, groups] of Object.entries(JOB_GROUPS)) {
    const progress = progressFor({ kind, stage: JOB_PLANS[kind][0] });
    assert.equal(progress.plan.length, groups.length);
    progress.plan.forEach((group, index) => {
      assert.equal(group.sentence, groups[index].title);
      for (const line of group.steps) assert.notEqual(line.sentence, group.sentence, `${group.sentence} repeats a line inside itself`);
    });
  }
  assert.equal(stageSentence(null), 'Getting ready');
  assert.equal(stageSentence('queued'), 'Getting ready');
  assert.equal(stageSentence('starting'), 'Getting ready');
  assert.equal(stageSentence('Reclaiming space from an interrupted backup'), 'Tidying up after a backup that stopped');
});

test('step N of M counts the groups, and a stage outside the plan keeps its place', () => {
  const now = '2026-09-17T01:00:00.000Z';
  const job = { kind: 'restore', stage: 'Checking the backup' };
  let progress = progressFor(job, { now });
  assert.equal(progress.headline, 'Restoring your backup');
  assert.equal(progress.sentence, 'Reading the backup');
  // Four groups, not nine stages: the count is what the screen lists.
  assert.deepEqual([progress.step, progress.steps], [1, 4]);
  assert.deepEqual(sentences(progress), ['Reading the backup', 'Making room for it', 'Putting your suite back', 'Checking it and starting it']);
  assert.equal(progress.startedAt, now);
  assert.deepEqual(states(progress), ['now', 'next', 'next', 'next']);

  job.progress = progress;
  job.stage = 'Restoring app volumes';
  progress = progressFor(job, { now: '2026-09-17T01:05:00.000Z' });
  assert.deepEqual([progress.step, progress.steps], [3, 4]);
  assert.equal(progress.startedAt, now, 'the start time is the first stage\'s, not the latest');
  assert.deepEqual(states(progress), ['done', 'done', 'now', 'next']);
  assert.deepEqual(lines(progress, 2), [
    ['done', 'Putting your settings and accounts back'],
    ['now', 'Putting your app data back'],
    ['next', 'Building your apps again'],
  ]);
  // A group already passed shows all of its lines done, one not reached yet
  // shows none of them.
  assert.deepEqual(lines(progress, 0).map(([state]) => state), ['done', 'done', 'done']);
  assert.deepEqual(lines(progress, 3).map(([state]) => state), ['next', 'next']);

  // A backup that first reclaims space left by an interrupted one reports that
  // sentence without inventing a fourth group, and the lines under it stay
  // where the stage it interrupted left them.
  const backup = { kind: 'backup', stage: 'Preparing backup' };
  backup.progress = progressFor(backup, { now });
  backup.stage = 'Reclaiming space from an interrupted backup';
  const reclaiming = progressFor(backup, { now });
  assert.equal(reclaiming.sentence, 'Tidying up after a backup that stopped');
  assert.deepEqual([reclaiming.step, reclaiming.steps], [1, 3]);
  assert.deepEqual(lines(reclaiming, 0).map(([state]) => state), ['now', 'next', 'next']);
  backup.progress = reclaiming;
  assert.deepEqual(lines(progressFor(backup, { now }), 0).map(([state]) => state), ['now', 'next', 'next']);

  // One stage, one group: a plan of one line does not open into itself.
  const deleting = progressFor({ kind: 'delete', stage: 'Deleting backup and reclaiming space' });
  assert.deepEqual([deleting.step, deleting.steps], [1, 1]);
  assert.deepEqual(sentences(deleting), ['Removing it and freeing the space']);
  assert.deepEqual(deleting.plan[0].steps, []);
});

// The stage that reads a whole backup out of a remote repository is minutes
// of silence on a screen that shows only stages. It reports which of its
// three reads it is on, and that is what the owner sees moving.
test('a stage that reports its own parts moves the line and ticks them off', () => {
  const job = { kind: 'restore', stage: 'Checking the backup', substage: 'Reading the suite state' };
  const progress = progressFor(job);
  assert.equal(progress.sentence, 'Reading your settings and accounts');
  assert.equal(progress.stage, 'Checking the backup', 'the stage is still the stage, so a count survives its parts');
  assert.deepEqual(lines(progress, 0), [
    ['done', 'Checking nothing in it is damaged'],
    ['now', 'Reading your settings and accounts'],
    ['next', 'Checking every app package is there'],
  ]);

  // Before the first part is reported, and for a part that is not one of this
  // stage's, the stage speaks for itself and its first line is the one now.
  for (const substage of [null, undefined, 'Restoring app volumes']) {
    const unreported = progressFor({ kind: 'restore', stage: 'Checking the backup', substage });
    assert.equal(unreported.sentence, 'Reading the backup');
    assert.deepEqual(lines(unreported, 0).map(([state]) => state), ['now', 'next', 'next']);
  }

  // The check job is the same stage with nothing around it.
  const check = progressFor({ kind: 'validate', stage: 'Checking the backup', substage: 'Checking every app package' });
  assert.deepEqual([check.step, check.steps], [1, 1]);
  assert.deepEqual(lines(check, 0).map(([state]) => state), ['done', 'done', 'now']);
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
  for (const entry of record.plan) {
    assert.deepEqual(Object.keys(entry).sort(), ['sentence', 'state', 'steps']);
    for (const line of entry.steps) assert.deepEqual(Object.keys(line).sort(), ['sentence', 'state']);
  }
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /b7d5b6c1|Restoring app volumes|Checking the backup|mos-app-|\/var\/|\/media\/|\/etc\//u);
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
