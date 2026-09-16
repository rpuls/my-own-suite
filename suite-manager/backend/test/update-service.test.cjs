const assert = require('node:assert/strict');
const test = require('node:test');

const { UpdateService, normalizeStatus } = require('../src/updates/update-service.cjs');

const CAPABILITIES = { updates: { capabilities: ['apply', 'cancel', 'checkpoint', 'configure-track', 'skip-backup'] } };
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

function hostPayload(overrides = {}) {
  return {
    allowedOrigins: ['Ubuntu:noble-security'],
    automaticReboot: false,
    available: true,
    health: { at: '2026-09-16T06:20:00.000Z', failures: [], ok: true },
    lastInstallAt: '2026-09-15T06:12:55',
    lastInstalledPackages: ['libssl3t64'],
    lastListedAt: '2026-09-16T06:00:00.000Z',
    lastRunAt: '2026-09-16T06:10:01',
    managedBy: 'mos',
    other: ['vim-common'],
    rebootPackages: [],
    rebootRequired: false,
    security: [],
    simulation: 'Inst libssl3t64 (Ubuntu:24.04/noble-security)',
    unattendedLog: 'All upgrades installed',
    ...overrides,
  };
}

test('a diagnostics agent that does not answer leaves the MOS half of the screen working', async () => {
  const service = new UpdateService({
    agent: { status: async () => ({ capabilities: CAPABILITIES, currentJob: null, updaterStatus: { updateAvailable: false } }) },
    diagnosticsAgent: { hostPatches: async () => { throw new Error('The diagnostics system agent is unavailable.'); } },
  });
  const status = await service.status();
  assert.equal(status.updateAvailable, false);
  assert.equal(status.host.available, false);
  assert.equal(status.host.rebootRequired, false);
  assert.match(status.host.summary, /could not be read/u);
});

test('a restart Ubuntu asked for is reported with the packages that asked', () => {
  const status = normalizeStatus({ capabilities: CAPABILITIES }, true, null, hostPayload({ rebootPackages: ['linux-base'], rebootRequired: true }));
  assert.equal(status.host.rebootRequired, true);
  assert.deepEqual(status.host.rebootPackages, ['linux-base']);
});

// Whether the restart is needed, and whether an update or backup is running,
// is the privileged agent's check; a refusal from it reaches the browser as is.
test('a restart goes to the update agent and its refusal comes back unchanged', async () => {
  const refusal = Object.assign(new Error('This server does not need a restart.'), { code: 'RESTART_NOT_NEEDED', statusCode: 409 });
  const refusing = new UpdateService({ agent: { restartHost: async () => { throw refusal; } } });
  await assert.rejects(() => refusing.restartHost(), (error) => error.statusCode === 409 && error.code === 'RESTART_NOT_NEEDED');

  const accepting = new UpdateService({ agent: { restartHost: async () => ({ restartingAt: '2026-09-16T09:00:05.000Z' }) } });
  assert.deepEqual(await accepting.restartHost(), { restartingAt: '2026-09-16T09:00:05.000Z' });
});

test('the pending security count is what the screen says, and the evidence rides with it', () => {
  const status = normalizeStatus({ capabilities: CAPABILITIES }, true, null, hostPayload({ security: ['libssl3t64', 'linux-image-generic'] }));
  assert.equal(status.host.securityCount, 2);
  assert.deepEqual(status.host.security, ['libssl3t64', 'linux-image-generic']);
  assert.equal(status.host.otherCount, 1);
  assert.match(status.host.summary, /^2 Ubuntu security updates are waiting/u);
  assert.match(status.host.diagnostics, /Inst libssl3t64/u);
  assert.match(status.host.diagnostics, /Allowed-Origins: Ubuntu:noble-security/u);
});

test('the sentence the screen leads with distinguishes nothing waiting from nothing known', () => {
  const summary = (overrides) => normalizeStatus({ capabilities: CAPABILITIES }, true, null, hostPayload(overrides)).host.summary;
  assert.equal(summary({}), 'No Ubuntu security updates are waiting.');
  assert.equal(summary({ security: ['libssl3t64'] }), 'One Ubuntu security update is waiting and installs on its own.');
  assert.match(summary({ managedBy: 'none' }), /not being applied automatically/u);
  assert.match(summary({ available: false }), /could not be read/u);
});

test('an owner-managed server reports what was found and is never called broken', () => {
  const status = normalizeStatus({ capabilities: CAPABILITIES }, true, null, hostPayload({
    automaticReboot: true,
    managedBy: 'owner',
    managedReason: '/etc/apt/apt.conf.d/50unattended-upgrades has been edited on this server, so MOS left the policy alone.',
  }));
  assert.equal(status.host.managedBy, 'owner');
  assert.equal(status.host.automaticReboot, true);
  assert.match(status.host.summary, /^You manage/u);
});

test('a post-patch check that could not run is not a suite that came back', () => {
  const status = normalizeStatus({ capabilities: CAPABILITIES }, true, null, hostPayload({
    health: { at: '2026-09-16T06:20:00.000Z', ok: null, reason: 'systemctl could not be run.' },
  }));
  assert.equal(status.host.health.ok, null);
  assert.deepEqual(status.host.health.failures, []);
  assert.equal(status.host.health.reason, 'systemctl could not be run.');
});
