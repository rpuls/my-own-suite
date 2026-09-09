const assert = require('node:assert/strict');
const test = require('node:test');

const { UpdateService, normalizeStatus } = require('../src/updates/update-service.cjs');

const CAPABILITIES = { updates: ['apply', 'cancel', 'checkpoint', 'configure-track', 'skip-backup'] };
const REASON = 'github.com answered a plain request from this server for this repository with HTTP 401 "Repository not found.".';

function agentPayload(updaterStatus) {
  return { capabilities: CAPABILITIES, currentJob: null, updaterStatus };
}

test('a check that did not complete is neither up to date nor an update waiting', () => {
  const status = normalizeStatus(agentPayload({
    checkFailure: {
      at: '2026-09-02T07:00:00.000Z',
      details: ['plain request from this server, no login: HTTP 401 Unauthorized'],
      reason: REASON,
    },
    checkedAt: '2026-09-02T07:00:00.000Z',
    error: REASON,
    latestRevision: null,
    updateAvailable: null,
  }), true);

  assert.equal(status.updateAvailable, null);
  assert.equal(status.latestRevision, null);
  assert.equal(status.checkFailure.errorCode, 'UPDATE_CHECK_FAILED');
  assert.equal(status.checkFailure.reason, REASON);
  assert.ok(status.checkFailure.diagnostics.includes(REASON));
  assert.ok(status.checkFailure.diagnostics.includes('Details:'));
  assert.ok(status.checkFailure.diagnostics.includes('- plain request from this server, no login: HTTP 401 Unauthorized'));
});

test('an agent too old to explain itself still reports the check as failed', () => {
  const status = normalizeStatus(agentPayload({ error: 'fetch failed', updateAvailable: null }), true);
  assert.equal(status.updateAvailable, null);
  assert.equal(status.checkFailure.reason, 'fetch failed');
});

test('a check that completed keeps its answer', () => {
  const available = normalizeStatus(agentPayload({ latestRevision: 'abc123', updateAvailable: true }), true);
  assert.equal(available.checkFailure, null);
  assert.equal(available.updateAvailable, true);
  assert.equal(normalizeStatus(agentPayload({ updateAvailable: false }), true).updateAvailable, false);
});

test('an unreachable agent is reported as a failed check rather than an unknown state', async () => {
  const service = new UpdateService({ agent: { status: async () => { throw new Error('Update system agent is unavailable.'); } } });
  const status = await service.status();
  assert.equal(status.serviceAvailable, false);
  assert.equal(status.updateAvailable, null);
  assert.equal(status.checkFailure.reason, 'Update system agent is unavailable.');
});

function summaryWith({ primaryDestination = { destinationId: '/media/backup', label: 'Backup drive' } } = {}) {
  return { currentJob: null, primaryDestination };
}

test('the Updates screen is told where a checkpoint would go, and when there is nowhere', () => {
  const ready = normalizeStatus(agentPayload({ updateAvailable: true }), true, summaryWith());
  assert.equal(ready.checkpoint.destinationLabel, 'Backup drive');
  assert.equal(ready.checkpoint.ready, true);

  // No primary chosen, and a backup agent that did not answer, are the same
  // fact for this screen: no backup would be taken, so it says so.
  assert.equal(normalizeStatus(agentPayload({ updateAvailable: true }), true, summaryWith({ primaryDestination: null })).checkpoint.ready, false);
  assert.equal(normalizeStatus(agentPayload({ updateAvailable: true }), true, null).checkpoint.ready, false);
});

test('the backup taken before an update travels on the job, waiting reason included', () => {
  const status = normalizeStatus({
    ...agentPayload({ updateAvailable: true }),
    currentJob: {
      checkpoint: { backupId: null, jobId: 'backup-1', status: 'waiting', waiting: { reason: 'The backup drive is not connected.', since: '2026-09-09T10:00:00.000Z' } },
      id: 'update-1',
      stage: 'waiting-for-backup-destination',
      status: 'running',
    },
  }, true, null);

  assert.equal(status.currentJob.stage, 'waiting-for-backup-destination');
  assert.equal(status.currentJob.checkpoint.waiting.reason, 'The backup drive is not connected.');
  assert.equal(status.currentJob.checkpoint.jobId, 'backup-1');
});

test('the agent\'s refusal to update on top of backup work reaches the owner in its own words', async () => {
  const service = new UpdateService({
    agent: {
      startUpdate: async () => { throw Object.assign(new Error('A restore is running. Start the update when it finishes.'), { code: 'BACKUP_RUNNING', statusCode: 409 }); },
      status: async () => agentPayload({ updateAvailable: true }),
    },
    backupAgent: { summary: async () => summaryWith() },
  });
  await assert.rejects(() => service.start(), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, 'A restore is running. Start the update when it finishes.');
    return true;
  });
});

test('a backup agent that does not answer does not block an update', async () => {
  let started = false;
  const service = new UpdateService({
    agent: {
      startUpdate: async () => { started = true; return {}; },
      status: async () => agentPayload({ updateAvailable: true }),
    },
    backupAgent: { summary: async () => { throw new Error('Backup system agent is unavailable.'); } },
  });
  await service.start();
  assert.equal(started, true);
});

test('cancel and update-without-a-backup each name the job and hand back fresh status', async () => {
  const calls = [];
  const service = new UpdateService({
    agent: {
      cancelUpdate: async (id) => { calls.push(['cancel', id]); return {}; },
      skipBackup: async (id) => { calls.push(['skip', id]); return {}; },
      status: async () => agentPayload({ updateAvailable: true }),
    },
  });
  await service.cancel({ id: 'update-1' });
  await service.skipBackup({ id: 'update-1' });
  assert.deepEqual(calls, [['cancel', 'update-1'], ['skip', 'update-1']]);
  await assert.rejects(() => service.skipBackup({}), (error) => error.statusCode === 400);
});

test('starting an update after a failed check refuses with the reason, not with "already up to date"', async () => {
  let started = false;
  const service = new UpdateService({
    agent: {
      startUpdate: async () => { started = true; return {}; },
      status: async () => agentPayload({ checkFailure: { details: [], reason: REASON }, updateAvailable: null }),
    },
  });

  await assert.rejects(() => service.start(), (error) => {
    assert.equal(error.statusCode, 409);
    assert.ok(error.message.startsWith('Could not check for updates: '));
    assert.ok(error.message.includes(REASON));
    return true;
  });
  assert.equal(started, false);
});
