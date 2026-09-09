// Coverage for automatic backups: the schedule arithmetic against a clock the
// test supplies, and the scheduler's run loop against a fake job pipeline. The
// scenarios are the ones a lab drill cannot reach in reasonable time — a
// machine asleep through its window, a drive left in a drawer for a day, a
// daylight-saving change, and retention that must never touch a backup the
// owner took by hand.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { dueOccurrence, nextOccurrenceAfter, normalizeSchedule, retentionVictims, timingChanged } = require('./schedule.cjs');
const { PrimaryDestination } = require('./primary.cjs');
const { BackupScheduler } = require('./scheduler.cjs');

function schedule(overrides = {}) {
  return { configuredAt: '2026-09-01T00:00:00.000Z', enabled: true, frequency: 'daily', hour: 3, keepLast: 7, lastRunAt: null, minute: 0, timeZone: 'Europe/Amsterdam', weekday: 0, ...overrides };
}

test('a daily schedule is due once for a window the machine slept through', () => {
  // 03:00 Amsterdam is 01:00 UTC in summer. The machine wakes at 09:00 local.
  const now = new Date('2026-09-07T07:00:00.000Z');
  const due = dueOccurrence(schedule({ lastRunAt: '2026-09-06T01:00:00.000Z' }), now);
  assert.equal(due.toISOString(), '2026-09-07T01:00:00.000Z');

  // Having run it, the same tick a minute later owes nothing more: a missed
  // window produces one backup, not one per hour until the next occurrence.
  const after = dueOccurrence(schedule({ lastRunAt: '2026-09-07T07:00:00.000Z' }), new Date('2026-09-07T07:01:00.000Z'));
  assert.equal(after, null);
});

test('turning a schedule on does not immediately run the window that already passed today', () => {
  // Configured at noon, with a 03:00 window that passed nine hours earlier.
  const configured = schedule({ configuredAt: '2026-09-07T10:00:00.000Z', lastRunAt: null });
  assert.equal(dueOccurrence(configured, new Date('2026-09-07T10:00:30.000Z')), null);
  assert.equal(nextOccurrenceAfter(configured, new Date('2026-09-07T10:00:30.000Z')).toISOString(), '2026-09-08T01:00:00.000Z');
});

test('a wall-clock time holds across a daylight-saving change', () => {
  // Amsterdam leaves summer time on 2026-10-25. The owner asked for 3am, which
  // is 01:00 UTC while summer time is on and 02:00 UTC once it is off — the
  // absolute moment moves so that the clock on the wall does not.
  const before = nextOccurrenceAfter(schedule(), new Date('2026-10-20T12:00:00.000Z'));
  const after = nextOccurrenceAfter(schedule(), new Date('2026-10-26T12:00:00.000Z'));
  assert.equal(before.toISOString(), '2026-10-21T01:00:00.000Z');
  assert.equal(after.toISOString(), '2026-10-27T02:00:00.000Z');
});

test('a weekly schedule fires on its chosen day only', () => {
  const weekly = schedule({ frequency: 'weekly', weekday: 1 });
  const next = nextOccurrenceAfter(weekly, new Date('2026-09-09T12:00:00.000Z'));
  assert.equal(next.toISOString(), '2026-09-14T01:00:00.000Z');
  assert.equal(new Date(next).getUTCDay(), 1);
});

test('the server zone is irrelevant to when a schedule fires', () => {
  const newYork = nextOccurrenceAfter(schedule({ timeZone: 'America/New_York' }), new Date('2026-09-07T12:00:00.000Z'));
  assert.equal(newYork.toISOString(), '2026-09-08T07:00:00.000Z');
});

test('retention removes the oldest automatic backups and never a manual one', () => {
  const points = [
    { automatic: true, createdAt: '2026-09-01T03:00:00.000Z', path: '/d/1.json' },
    { automatic: false, createdAt: '2026-09-02T12:00:00.000Z', path: '/d/manual.json' },
    { automatic: true, createdAt: '2026-09-03T03:00:00.000Z', path: '/d/3.json' },
    { automatic: true, createdAt: '2026-09-04T03:00:00.000Z', path: '/d/4.json' },
  ];
  assert.deepEqual(retentionVictims(points, 2).map((point) => point.path), ['/d/1.json']);
  assert.deepEqual(retentionVictims(points, 0), []);
  // A point whose manifest predates automatic backups counts as the owner's.
  assert.deepEqual(retentionVictims([{ createdAt: '2020-01-01T00:00:00.000Z', path: '/d/old.json' }], 1), []);
});

test('a backup taken before a MOS update is an automatic backup like any other', () => {
  const points = [
    { automatic: true, createdAt: '2026-09-01T03:00:00.000Z', initiator: 'update', path: '/d/update-1.json' },
    { automatic: true, createdAt: '2026-09-05T03:00:00.000Z', initiator: 'schedule', path: '/d/2.json' },
    { automatic: true, createdAt: '2026-09-06T03:00:00.000Z', initiator: 'schedule', path: '/d/3.json' },
  ];
  // One rule: the oldest automatic copies beyond the number go, whoever asked
  // for them. A second rule for checkpoints would be a second thing to learn.
  assert.deepEqual(retentionVictims(points, 2).map((point) => point.path), ['/d/update-1.json']);
});

test('a schedule keeps settings it is not given', () => {
  const current = schedule({ hour: 22, keepLast: 14 });
  const next = normalizeSchedule({ enabled: true, frequency: 'weekly' }, { current });
  assert.equal(next.hour, 22);
  assert.equal(next.keepLast, 14);
  assert.equal(next.frequency, 'weekly');
  // Where the backups go is not the schedule's to hold any more: it is the
  // primary destination, shared with the backup taken before a MOS update.
  assert.equal('destinationId' in next, false);
  // Retention only accepts the offered choices; anything else keeps the
  // current setting rather than inventing a policy of its own.
  assert.equal(normalizeSchedule({ enabled: true, keepLast: 9999 }, { current }).keepLast, 14);
});

test('only a change to when it fires restarts the schedule', () => {
  const before = schedule();
  assert.equal(timingChanged(before, { ...before, keepLast: 30 }), false);
  assert.equal(timingChanged(before, { ...before, hour: 9 }), true);
  assert.equal(timingChanged(before, { ...before, timeZone: 'UTC' }), true);
});

// --- The run loop --------------------------------------------------------

function harness({ destinations = [{ id: '/media/backup', label: 'Backup drive', writable: true }], points = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-schedule-'));
  const jobs = new Map();
  const created = [];
  const state = { clock: new Date('2026-09-07T00:59:00.000Z'), createError: null, destinations, points, updating: false };
  const primary = new PrimaryDestination({ agentStateDir: dir, now: () => state.clock, repositoryId: () => 'repo-1' });
  primary.save({ destinationId: '/media/backup', label: 'Backup drive' });
  const scheduler = new BackupScheduler({
    agentStateDir: dir,
    createJob: (kind, payload) => {
      if (state.createError) throw new Error(state.createError);
      const job = { id: `job-${jobs.size + 1}`, kind, status: 'running', ...payload };
      jobs.set(job.id, job);
      created.push(job);
      return job;
    },
    destinations: async () => state.destinations,
    now: () => state.clock,
    primary,
    readJob: (id) => jobs.get(id) || null,
    restorePoints: () => state.points,
    updateInProgress: async () => state.updating,
  });
  return { created, dir, jobs, primary, scheduler, state };
}

test('a due schedule starts a backup through the ordinary job pipeline', async () => {
  const { created, scheduler, state } = harness();
  scheduler.save({ enabled: true, hour: 3, keepLast: 0, minute: 0, timeZone: 'Europe/Amsterdam' });

  await scheduler.tick();
  assert.equal(created.length, 0, 'not due a minute before the window');

  state.clock = new Date('2026-09-07T01:00:30.000Z');
  await scheduler.tick();
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, 'backup');
  assert.equal(created[0].initiator, 'schedule', 'the backup must be marked as the schedule\'s, or retention could delete a manual one');

  // Ticking again while the job runs must not queue a second backup.
  await scheduler.tick();
  assert.equal(created.length, 1);
});

test('a disconnected drive holds the run open instead of failing it', async () => {
  const { created, scheduler, state } = harness();
  scheduler.save({ enabled: true, hour: 3, keepLast: 0, minute: 0, timeZone: 'Europe/Amsterdam' });
  state.clock = new Date('2026-09-07T01:00:30.000Z');
  state.destinations = [];

  await scheduler.tick();
  assert.equal(created.length, 0);
  assert.match(scheduler.state().waiting.reason, /not connected/u);
  assert.equal(scheduler.state().lastResult, null, 'a drive in a drawer is not a failed backup');

  // Hours later the drive comes back on a different mount path; the repository
  // on it is what identifies it as the one the schedule was pointed at.
  state.clock = new Date('2026-09-07T18:00:00.000Z');
  state.destinations = [{ id: '/media/backup-2', label: 'Backup drive', writable: true }];
  await scheduler.tick();
  assert.equal(created.length, 1);
  assert.equal(created[0].destinationId, '/media/backup-2');
  assert.equal(scheduler.state().waiting, null);
});

test('a failed automatic backup is reported and waits for the next window', async () => {
  const { created, jobs, scheduler, state } = harness();
  scheduler.save({ enabled: true, hour: 3, keepLast: 0, minute: 0, timeZone: 'Europe/Amsterdam' });
  state.clock = new Date('2026-09-07T01:00:30.000Z');
  await scheduler.tick();

  jobs.get(created[0].id).error = 'The backup drive was disconnected while MOS was writing to it.';
  jobs.get(created[0].id).status = 'failed';
  state.clock = new Date('2026-09-07T01:30:00.000Z');
  await scheduler.tick();

  const settled = scheduler.state();
  assert.equal(settled.lastResult.status, 'failed');
  assert.match(settled.lastResult.message, /disconnected/u);
  assert.equal(settled.running, false);

  // It must not immediately try again: whatever failed is still true.
  state.clock = new Date('2026-09-07T02:00:00.000Z');
  await scheduler.tick();
  assert.equal(created.length, 1);
  assert.equal(settled.nextRunAt, '2026-09-08T01:00:00.000Z');
});

test('retention runs only after the new backup succeeded, one delete at a time', async () => {
  const { created, jobs, scheduler, state } = harness({
    points: [
      { automatic: true, createdAt: '2026-09-03T01:00:00.000Z', path: '/media/backup/a.json' },
      { automatic: true, createdAt: '2026-09-04T01:00:00.000Z', path: '/media/backup/b.json' },
      { automatic: true, createdAt: '2026-09-05T01:00:00.000Z', path: '/media/backup/c.json' },
      { automatic: false, createdAt: '2026-09-05T12:00:00.000Z', path: '/media/backup/manual.json' },
      { automatic: true, createdAt: '2026-09-06T01:00:00.000Z', path: '/media/backup/d.json' },
      { automatic: true, createdAt: '2026-09-07T01:00:00.000Z', path: '/media/backup/e.json' },
    ],
  });
  scheduler.save({ enabled: true, hour: 3, keepLast: 3, minute: 0, timeZone: 'Europe/Amsterdam' });
  state.clock = new Date('2026-09-07T01:00:30.000Z');
  await scheduler.tick();

  jobs.get(created[0].id).status = 'succeeded';
  await scheduler.tick();
  assert.equal(created.length, 2);
  assert.equal(created[1].kind, 'delete');
  assert.equal(created[1].backupPath, '/media/backup/a.json', 'the oldest automatic point goes first');

  jobs.get(created[1].id).status = 'succeeded';
  state.points = state.points.filter((point) => point.path !== '/media/backup/a.json');
  await scheduler.tick();
  assert.equal(created[2].backupPath, '/media/backup/b.json');

  jobs.get(created[2].id).status = 'succeeded';
  state.points = state.points.filter((point) => point.path !== '/media/backup/b.json');
  await scheduler.tick();
  assert.equal(created.length, 3, 'the manual backup is never a candidate');
  assert.equal(scheduler.state().lastResult.status, 'succeeded');
  assert.equal(scheduler.state().running, false);
});

test('a busy suite delays the run rather than losing it', async () => {
  const { created, scheduler, state } = harness();
  scheduler.save({ enabled: true, hour: 3, keepLast: 0, minute: 0, timeZone: 'Europe/Amsterdam' });
  state.clock = new Date('2026-09-07T01:00:30.000Z');
  state.createError = 'A backup or restore job is already running.';

  await scheduler.tick();
  assert.equal(created.length, 0);
  assert.match(scheduler.state().waiting.reason, /already running/u);

  state.createError = null;
  state.clock = new Date('2026-09-07T01:05:00.000Z');
  await scheduler.tick();
  assert.equal(created.length, 1, 'the owed run starts as soon as the pipeline is free');
});

test('an update in progress holds the run open instead of being cut off by it', async () => {
  const { created, scheduler, state } = harness();
  scheduler.save({ enabled: true, hour: 3, keepLast: 0, minute: 0, timeZone: 'Europe/Amsterdam' });
  state.clock = new Date('2026-09-07T01:00:30.000Z');
  state.updating = true;

  // The update restarts this agent partway through, so a backup started under
  // one would be cut off mid-write.
  await scheduler.tick();
  assert.equal(created.length, 0);
  assert.match(scheduler.state().waiting.reason, /update is in progress/u);
  assert.equal(scheduler.state().lastResult, null, 'an update running is not a failed backup');

  state.updating = false;
  state.clock = new Date('2026-09-07T01:20:00.000Z');
  await scheduler.tick();
  assert.equal(created.length, 1, 'the owed run starts as soon as the update finishes');
  assert.equal(scheduler.state().waiting, null);
});

test('turning the schedule off stops it deciding anything', async () => {
  const { created, scheduler, state } = harness();
  scheduler.save({ enabled: true, hour: 3, keepLast: 0, minute: 0, timeZone: 'Europe/Amsterdam' });
  scheduler.save({ enabled: false });
  state.clock = new Date('2026-09-07T01:00:30.000Z');

  await scheduler.tick();
  assert.equal(created.length, 0);
  assert.equal(scheduler.state().nextRunAt, null);
});
