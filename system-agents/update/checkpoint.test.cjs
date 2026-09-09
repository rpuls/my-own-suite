// Coverage for the backup an update takes before it applies anything. The
// scenarios are the ones a lab drill reaches slowly or not at all: a drive left
// in a drawer for an hour, a backup queue that is busy for one poll, a
// checkpoint that fails, and a cancel or a skip that lands mid-wait. The socket
// calls are one injected object, so none of this opens one.

const assert = require('node:assert/strict');
const test = require('node:test');

const { CANCELLABLE_STAGES, checkpointTarget, CheckpointFailure, SKIPPABLE_STAGES, takeCheckpoint, WAITING_REASONS } = require('./checkpoint.cjs');

const PRIMARY = { destinationId: '/media/backup', label: 'Backup drive' };

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

// A backup agent that answers from a script: `startBackup` either throws what
// it was told to or hands back a job, and `job` walks that job through the
// states it was given, one per poll. `otherJob` is what an owner's own backup
// looks like from the update's side: the current job is no longer the one it
// asked for, but the one it asked for is still there by id.
function fakeBackupAgent({ primaryDestination = PRIMARY, startFailures = [], jobStates = [], otherJob = null } = {}) {
  const calls = { starts: [], polls: 0 };
  let job = null;
  let stateIndex = 0;
  return {
    calls,
    async startBackup(input) {
      calls.starts.push(input);
      const failure = startFailures.shift();
      if (failure) throw failure;
      job = { id: 'backup-job-1', kind: 'backup', logs: [], status: 'queued' };
      return { job };
    },
    async summary() {
      return { currentJob: otherJob || job, primaryDestination };
    },
    async job(id) {
      calls.polls += 1;
      if (!job || id !== job.id) throw refusal('NOT_FOUND', 'Job was not found.');
      if (stateIndex < jobStates.length) job = { ...job, ...jobStates[stateIndex++] };
      return { job };
    },
  };
}

function harness(options) {
  const backup = fakeBackupAgent(options);
  const states = [];
  const slept = [];
  return {
    backup,
    slept,
    states,
    run(overrides = {}) {
      return takeCheckpoint({
        backup,
        now: () => new Date('2026-09-09T10:00:00.000Z'),
        onState: (state) => states.push(state),
        pollIntervalMs: 5,
        sleep: async (ms) => { slept.push(ms); },
        target: '0.20.0',
        ...overrides,
      });
    },
  };
}

test('the checkpoint is a backup taken through the ordinary pipeline, to the primary destination', async () => {
  const world = harness({ jobStates: [{ status: 'running' }, { status: 'succeeded' }] });
  const result = await world.run();

  assert.equal(result.status, 'succeeded');
  assert.equal(result.backupId, 'backup-job-1');
  // Named rather than picked: only the backup agent knows which mounted
  // destination is the primary right now.
  assert.deepEqual(world.backup.calls.starts, [{ destinationId: 'primary', initiator: 'update', updateTarget: '0.20.0' }]);
  assert.deepEqual(world.states, [{ jobId: 'backup-job-1', status: 'running', waiting: null }]);
});

test('the checkpoint is followed by its own id, not by whatever job is current', async () => {
  const world = harness({
    jobStates: [{ status: 'running' }, { status: 'succeeded' }],
    otherJob: { id: 'owner-backup-2', kind: 'backup', status: 'queued' },
  });
  const result = await world.run();
  assert.equal(result.status, 'succeeded', 'an owner clicking Back up the moment the checkpoint ends must not fail the update');
});

test('a destination that is not there makes the update wait, and it starts by itself when the drive is back', async () => {
  const world = harness({
    jobStates: [{ status: 'succeeded' }],
    startFailures: [refusal('DESTINATION_ABSENT', 'The destination automatic backups are written to is not available right now.')],
  });
  const result = await world.run();

  assert.equal(result.status, 'succeeded', 'a drive in a drawer is not a failed update');
  const waiting = world.states.find((state) => state.status === 'waiting');
  assert.equal(waiting.waiting.reason, WAITING_REASONS.DESTINATION_ABSENT);
  assert.equal(waiting.waiting.since, '2026-09-09T10:00:00.000Z');
  assert.equal(world.backup.calls.starts.length, 2, 'it asks again rather than needing another click');
});

test('a busy backup queue and an agent mid-restart are both waits, not failures', async () => {
  for (const code of ['BACKUP_AGENT_UNAVAILABLE', 'JOB_ACTIVE', 'DESTINATION_UNREACHABLE']) {
    const world = harness({ jobStates: [{ status: 'succeeded' }], startFailures: [refusal(code, 'refused')] });
    const result = await world.run();
    assert.equal(result.status, 'succeeded', `${code} must hold the update open`);
    assert.equal(world.states.find((state) => state.status === 'waiting').waiting.reason, WAITING_REASONS[code]);
  }
});

test('a refusal only the owner can clear fails the update before anything is touched', async () => {
  const world = harness({ startFailures: [refusal('RECOVERY_KEY_UNACKNOWLEDGED', 'Save your recovery key before backing up.')] });
  await assert.rejects(() => world.run(), (error) => {
    assert.ok(error instanceof CheckpointFailure);
    assert.equal(error.message, 'Save your recovery key before backing up.');
    return true;
  });
  assert.equal(world.backup.calls.starts.length, 1, 'it is not retried against something only the owner can fix');
});

test('a checkpoint backup that fails fails the update, carrying the backup\'s own words', async () => {
  const world = harness({
    jobStates: [{ error: 'The backup drive was disconnected while MOS was writing to it.', logs: [{ at: '2026-09-09T10:00:05.000Z', message: 'Storing app volumes' }], status: 'failed' }],
  });
  await assert.rejects(() => world.run(), (error) => {
    assert.ok(error instanceof CheckpointFailure);
    assert.match(error.message, /disconnected while MOS was writing/u);
    assert.match(error.output, /Storing app volumes/u);
    return true;
  });
});

test('a checkpoint whose record vanished fails the update rather than applying on a guess', async () => {
  const world = harness({ jobStates: [{ status: 'running' }] });
  world.backup.job = async () => { throw refusal('NOT_FOUND', 'Job was not found.'); };
  await assert.rejects(() => world.run(), /disappeared before it finished/u);
});

test('no destination for a checkpoint skips it rather than waiting for one that will never appear', async () => {
  const world = harness({ primaryDestination: null });
  const result = await world.run();
  assert.equal(result.status, 'skipped');
  assert.equal(world.backup.calls.starts.length, 0);
});

test('cancelling while it waits stops the update instead of applying it', async () => {
  const world = harness({ startFailures: [refusal('DESTINATION_ABSENT', 'absent'), refusal('DESTINATION_ABSENT', 'absent')] });
  let ticks = 0;
  const result = await world.run({ decision: async () => { ticks += 1; return ticks > 2 ? 'cancel' : null; } });
  assert.equal(result.status, 'cancelled');
});

test('going on without a backup while it waits applies the update with none', async () => {
  const world = harness({ startFailures: [refusal('DESTINATION_ABSENT', 'absent'), refusal('DESTINATION_ABSENT', 'absent')] });
  let ticks = 0;
  const result = await world.run({ decision: async () => { ticks += 1; return ticks > 2 ? 'skip' : null; } });
  assert.equal(result.status, 'skipped');
  assert.equal(world.backup.calls.starts.length, 2, 'the choice was offered only after the wait was real');
});

test('cancel is refused once the apply is under way, and skip once a backup is running', () => {
  assert.deepEqual([...CANCELLABLE_STAGES], ['queued', 'taking-checkpoint', 'waiting-for-backup-destination']);
  assert.deepEqual([...SKIPPABLE_STAGES], ['waiting-for-backup-destination']);
  for (const stage of ['updating-checkout', 'installing-dependencies', 'building-frontend', 'reconciling-system']) {
    assert.equal(CANCELLABLE_STAGES.includes(stage), false, `${stage} is past the point where stopping is free`);
  }
});

test('the checkpoint is named after what the update was heading for', () => {
  assert.equal(checkpointTarget({ latestRelease: { version: '0.20.0' }, track: { type: 'stable' } }), '0.20.0');
  assert.equal(checkpointTarget({ latestRevision: 'abcdef0123456789', track: { type: 'branch' } }), 'abcdef012345');
  // A check that never completed leaves it unnamed rather than guessing.
  assert.equal(checkpointTarget(null), '');
});
