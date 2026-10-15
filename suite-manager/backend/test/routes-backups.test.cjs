const assert = require('node:assert/strict');
const test = require('node:test');

const { restoreGuaranteeFor } = require('../src/backups/restore-guarantee.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

const OWNER_PASSWORD = 'correct horse battery';
const ownerSetup = { verifyOwnerPassword: async (password) => password === OWNER_PASSWORD };
const inventory = { summary: { appCount: 0 } };

test('backup status merges the agent, the inventory and the restore guarantee', async () => {
  const backupAgent = { status: async () => ({ backups: [], destinations: [{ label: 'Backup Drive' }], recoveryKey: null }) };

  await withRoutes({ backupAgent, backupInventory: { inventory: () => inventory } }, async (call) => {
    const status = await call('GET', '/backups/status');

    assert.equal(status.status, 200);
    assert.equal(status.json().serviceAvailable, true);
    assert.equal(status.json().destinations[0].label, 'Backup Drive');
    assert.deepEqual(status.json().inventory, inventory);
    assert.deepEqual(status.json().restoreGuarantee, restoreGuaranteeFor({ backups: [] }).restoreGuarantee);
  });
});

test('backup status says the agent is unavailable rather than failing the screen', async () => {
  const warnings = [];
  const backupAgent = { status: async () => { throw new Error('Backup system agent is unavailable.'); } };
  const logger = { error() {}, info() {}, warn: (event) => warnings.push(event) };

  await withRoutes({ backupAgent, backupInventory: { inventory: () => inventory }, logger }, async (call) => {
    const status = await call('GET', '/backups/status');

    assert.equal(status.status, 200);
    assert.equal(status.json().serviceAvailable, false);
    assert.equal(status.json().error, 'Backup system agent is unavailable.');
    assert.deepEqual(status.json().inventory, inventory);
    assert.deepEqual(status.json().restoreGuarantee, restoreGuaranteeFor(null).restoreGuarantee);
    assert.deepEqual(warnings, ['backup-agent-unavailable']);
  });
});

test('backup actions reach the agent field by field', async () => {
  const calls = [];
  const record = (name, answer) => async (input) => { calls.push([name, input]); return answer; };
  const backupAgent = {
    connectObjectDestination: record('connect-object', { destination: { id: 'object:abc123' } }),
    disconnectObjectDestination: record('disconnect-object', { destination: { id: 'object:abc123' } }),
    setPrimaryDestination: record('primary', { primaryDestination: { destinationId: '/media/backup' } }),
    setSchedule: record('schedule', { schedule: { enabled: true } }),
    startBackup: record('backup', { job: { id: 'job-backup', status: 'queued' } }),
    startRestore: record('restore', { job: { id: 'job-restore', status: 'queued' } }),
    testObjectDestination: record('test-object', { result: { message: 'Connected.', ok: true } }),
  };
  const backupPath = '/media/backup/mos/backup-one';

  await withRoutes({ backupAgent }, async (call) => {
    assert.equal((await call('POST', '/backups/start', { body: { destinationId: '/media/backup' } })).status, 202);
    assert.equal((await call('POST', '/backups/restore', { body: { backupPath, confirmation: 'RESTORE' } })).status, 202);
    assert.equal((await call('POST', '/backups/schedule', {
      body: { enabled: true, frequency: 'daily', hour: 3, initiator: 'smuggled', keepLast: 7, minute: 0, timeZone: 'Europe/Amsterdam', weekday: 0 },
    })).status, 200);
    assert.equal((await call('POST', '/backups/primary', { body: { destinationId: '/media/backup', initiator: 'smuggled' } })).status, 200);
    assert.equal((await call('POST', '/backups/destinations/object', {
      body: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', bucket: 'mos-backups', endpoint: 'https://s3.test', folder: 'home', initiator: 'smuggled', label: 'Offsite', region: 'eu-central-1', secretAccessKey: 'super-secret-value' },
    })).status, 200);
    const tested = await call('POST', '/backups/destinations/object/test', {
      body: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', bucket: 'mos-backups', endpoint: 'https://s3.test', secretAccessKey: 'super-secret-value' },
    });
    assert.equal(tested.status, 200);
    assert.equal(tested.json().result.ok, true);
    assert.equal((await call('POST', '/backups/destinations/object/remove', { body: { destinationId: 'object:abc123' } })).status, 200);

    // Downloading and uploading a backup went with the tar formats.
    assert.equal((await call('GET', `/backups/download?path=${encodeURIComponent(backupPath)}`)).status, 404);
  });

  assert.deepEqual(calls, [
    ['backup', { destinationId: '/media/backup', note: '' }],
    ['restore', { backupPath, confirmation: 'RESTORE' }],
    ['schedule', { enabled: true, frequency: 'daily', hour: 3, keepLast: 7, minute: 0, timeZone: 'Europe/Amsterdam', weekday: 0 }],
    ['primary', { destinationId: '/media/backup' }],
    ['connect-object', { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', bucket: 'mos-backups', endpoint: 'https://s3.test', folder: 'home', label: 'Offsite', region: 'eu-central-1', secretAccessKey: 'super-secret-value' }],
    ['test-object', { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', bucket: 'mos-backups', endpoint: 'https://s3.test', folder: '', label: '', region: '', secretAccessKey: 'super-secret-value' }],
    ['disconnect-object', { destinationId: 'object:abc123' }],
  ]);
});

// Once saved, the key is shown only for the password, so a session left open on
// a borrowed screen is not enough to read it off.
test('the recovery key is shown freely until it is saved, and behind the owner password after', async () => {
  const calls = [];
  let acknowledged = false;
  const backupAgent = {
    async recoveryKeyStatus() { return { recoveryKey: { acknowledged, fingerprint: 'aabbccdd1122' } }; },
    async acknowledgeRecoveryKey() {
      acknowledged = true;
      calls.push(['acknowledge']);
      return { recoveryKey: { acknowledged: true, fingerprint: 'aabbccdd1122' } };
    },
    async revealRecoveryKey() {
      calls.push(['reveal']);
      return { key: 'MOS-7K2F-9XQ4-0000-0000-0000-0000-0000-0000', kit: 'My Own Suite — recovery kit', kitFilename: 'mos-recovery-kit-lab-2026-09-07.txt' };
    },
    async unlockDestination(input) {
      calls.push(['unlock', input]);
      return { result: { adopted: true, message: 'Unlocked.' } };
    },
  };

  await withRoutes({ backupAgent, setup: ownerSetup }, async (call) => {
    const first = await call('POST', '/backups/recovery-key/reveal', { body: {} });
    assert.equal(first.status, 200);
    assert.match(first.json().key, /^MOS-/u);
    assert.match(first.json().kit, /recovery kit/u);

    const saved = await call('POST', '/backups/recovery-key/acknowledge', { body: {} });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().recoveryKey.acknowledged, true);

    const wrong = await call('POST', '/backups/recovery-key/reveal', { body: { password: 'not the owner password' } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json().code, 'INVALID_PASSWORD');
    assert.equal(wrong.body.includes('MOS-7K2F'), false, 'the key travelled with a rejected password');

    assert.equal((await call('POST', '/backups/recovery-key/reveal', { body: {} })).status, 400);

    const again = await call('POST', '/backups/recovery-key/reveal', { body: { password: OWNER_PASSWORD } });
    assert.equal(again.status, 200);
    assert.match(again.json().key, /^MOS-/u);

    const unlocked = await call('POST', '/backups/destinations/unlock', {
      body: { destinationId: 'object:abc123', initiator: 'smuggled', recoveryKey: 'mos 7k2f 9xq4' },
    });
    assert.equal(unlocked.status, 200);
  });

  assert.deepEqual(calls, [
    ['reveal'],
    ['acknowledge'],
    ['reveal'],
    ['unlock', { destinationId: 'object:abc123', recoveryKey: 'mos 7k2f 9xq4' }],
  ]);
});
