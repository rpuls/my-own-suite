const assert = require('node:assert/strict');
const test = require('node:test');

const { UpdateService, normalizeStatus } = require('../src/updates/update-service.cjs');

const CAPABILITIES = { updates: ['apply', 'configure-track'] };
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
