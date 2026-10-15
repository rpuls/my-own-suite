const assert = require('node:assert/strict');
const test = require('node:test');

const { UpdateService } = require('../src/updates/update-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

test('Updates API proxies narrow update-agent actions', async () => {
  const calls = [];
  const updateAgent = {
    async configureTrack(input) {
      calls.push(['track', input]);
      return { track: input, updaterStatus: {} };
    },
    async startUpdate(input) {
      calls.push(['start', input]);
      return { job: { id: 'job-one', status: 'queued' } };
    },
    async status() {
      calls.push(['status']);
      return {
        capabilities: { updates: { capabilities: ['apply', 'configure-track'] } },
        currentJob: null,
        updaterStatus: {
          appRuntimeReconciliation: { automatic: false, summary: 'Installed app runtimes are preserved.' },
          changeSummary: { items: ['Managed update support.'], source: 'CHANGELOG.md [Unreleased]', title: 'Upcoming MOS changes' },
          checkedAt: '2026-07-05T12:00:00.000Z',
          latestRevision: 'abc123',
          track: { currentBranch: 'staging', currentCommit: 'def456', label: 'Staging branch', ref: 'staging', type: 'branch' },
          updateAvailable: true,
        },
      };
    },
  };

  await withRoutes({ updates: new UpdateService({ agent: updateAgent }) }, async (call) => {
    const status = await call('GET', '/updates/status');
    assert.equal(status.status, 200);
    assert.equal(status.json().managedApplyAvailable, true);
    assert.equal(status.json().changeSummary.items[0], 'Managed update support.');
    assert.equal(status.json().appRuntimeReconciliation, undefined);

    assert.equal((await call('POST', '/updates/track', { body: { track: 'staging' } })).status, 200);
    assert.equal((await call('POST', '/updates/track', { body: { track: 'main' } })).status, 200);
    const nightly = await call('POST', '/updates/track', { body: { track: 'nightly' } });
    assert.equal(nightly.status, 400);
    assert.equal(nightly.json().code, 'INVALID_UPDATE_TRACK');

    const started = await call('POST', '/updates/start');
    assert.equal(started.status, 202);
    assert.equal(started.json().job.id, 'job-one');
  });

  assert.deepEqual(calls.filter((call) => call[0] !== 'status'), [
    ['track', { ref: 'staging', track: 'branch' }],
    ['track', { ref: 'main', track: 'branch' }],
    ['start', { initiator: 'owner@example.com', target: 'latest' }],
  ]);
});

test('Stable-track apply starts the update agent when a newer release is available', async () => {
  const calls = [];
  const updateAgent = {
    async startUpdate(input) {
      calls.push(['start', input]);
      return { job: { id: 'job-one', status: 'queued' } };
    },
    async status() {
      return {
        capabilities: { updates: { capabilities: ['apply', 'configure-track'] } },
        currentJob: null,
        updaterStatus: {
          checkedAt: '2026-07-21T12:00:00.000Z',
          installedVersion: '0.11.0',
          latestRelease: { channel: 'stable', source: 'github-releases', version: '0.12.0' },
          track: { currentBranch: 'main', currentCommit: 'def456', label: 'Stable releases', ref: 'main', type: 'stable' },
          updateAvailable: true,
        },
      };
    },
  };

  await withRoutes({ updates: new UpdateService({ agent: updateAgent }) }, async (call) => {
    const status = await call('GET', '/updates/status');
    assert.equal(status.status, 200);
    assert.equal(status.json().installedVersion, '0.11.0');
    assert.equal((await call('POST', '/updates/start')).status, 202);
  });

  assert.deepEqual(calls, [['start', { initiator: 'owner@example.com', target: 'latest' }]]);
});

test('an update waiting for its backup can be cancelled or told to skip it, and a restart is handed on', async () => {
  const calls = [];
  const updates = {
    cancel: async (input) => { calls.push(['cancel', input]); return { job: { status: 'cancelled' } }; },
    restartHost: async () => { calls.push(['restart']); return { scheduled: true }; },
    skipBackup: async (input) => { calls.push(['skip-backup', input]); return { job: { status: 'running' } }; },
  };

  await withRoutes({ updates }, async (call) => {
    assert.equal((await call('POST', '/updates/cancel', { body: { id: 'job-one', initiator: 'smuggled' } })).status, 200);
    assert.equal((await call('POST', '/updates/skip-backup', { body: { id: 'job-two' } })).status, 200);
    assert.equal((await call('POST', '/updates/host/restart')).status, 202);
  });

  assert.deepEqual(calls, [['cancel', { id: 'job-one' }], ['skip-backup', { id: 'job-two' }], ['restart']]);
});
