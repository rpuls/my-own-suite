const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { KnownDrives } = require('./known-drives.cjs');

const scratch = () => fsp.mkdtemp(path.join(os.tmpdir(), 'mos-known-drives-'));
const drive = (overrides = {}) => ({ fsUuid: 'aaaa-bbbb', id: '/media/backup', kind: 'disk', label: 'Backup drive', ...overrides });

// The whole reason this exists: a drive that is not plugged in is the only copy
// an attacker on this machine cannot reach, and everything else in the agent
// can only talk about what is mounted right now.
test('a drive that has been backed up to is still described once it is unplugged', async () => {
  const drives = new KnownDrives({ agentStateDir: await scratch() });

  const whileHere = drives.reconcile({
    attached: [drive()],
    lastBackupAt: () => '2026-09-18T09:00:00.000Z',
    now: new Date('2026-09-18T10:00:00.000Z'),
  });
  assert.deepEqual(whileHere, [], 'nothing is away while it is here');

  const afterUnplug = drives.reconcile({ attached: [], now: new Date('2026-09-20T10:00:00.000Z') });
  assert.equal(afterUnplug.length, 1);
  assert.deepEqual(afterUnplug[0], {
    fsUuid: 'aaaa-bbbb',
    id: '/media/backup',
    label: 'Backup drive',
    lastBackupAt: '2026-09-18T09:00:00.000Z',
    lastSeenAt: '2026-09-18T10:00:00.000Z',
  });
});

// Every drive an owner ever plugs in would otherwise end up on this list, and a
// list with the camera card somebody borrowed on it is a list nobody reads.
test('a drive with no backup on it is not remembered', async () => {
  const drives = new KnownDrives({ agentStateDir: await scratch() });
  drives.reconcile({ attached: [drive({ fsUuid: 'cccc-dddd', label: 'Camera card' })], lastBackupAt: () => null });
  assert.deepEqual(drives.list(), []);
  assert.deepEqual(drives.reconcile({ attached: [] }), []);
});

// Where a drive is mounted is a fact about this boot. The filesystem on it is
// not, which is the whole point of identifying it that way.
test('a drive that comes back at a different mount path is the same drive', async () => {
  const drives = new KnownDrives({ agentStateDir: await scratch() });
  drives.reconcile({ attached: [drive()], lastBackupAt: () => '2026-09-18T09:00:00.000Z' });
  drives.reconcile({ attached: [drive({ id: '/media/backup1', label: 'Backup drive' })], lastBackupAt: () => '2026-09-25T09:00:00.000Z' });

  assert.equal(drives.list().length, 1);
  assert.equal(drives.list()[0].id, '/media/backup1');
  assert.equal(drives.list()[0].lastBackupAt, '2026-09-25T09:00:00.000Z');
});

// A drive MOS cannot identify would come back as a different drive every time,
// and a list that grows by one every reboot says nothing at all.
test('a drive with no filesystem id is not remembered', async () => {
  const drives = new KnownDrives({ agentStateDir: await scratch() });
  drives.reconcile({ attached: [drive({ fsUuid: null })], lastBackupAt: () => '2026-09-18T09:00:00.000Z' });
  assert.deepEqual(drives.list(), []);
});

// A drive that is here but will not answer has not lost the backup it held
// yesterday, and saying it has would be the screen inventing a loss.
test('a drive that is attached but unreadable keeps the backup time it had', async () => {
  const drives = new KnownDrives({ agentStateDir: await scratch() });
  drives.reconcile({ attached: [drive()], lastBackupAt: () => '2026-09-18T09:00:00.000Z' });
  drives.reconcile({ attached: [drive()], lastBackupAt: () => null });
  assert.equal(drives.list()[0].lastBackupAt, '2026-09-18T09:00:00.000Z');
});

test('a drive the owner is done with is forgotten, and the file stays root-only', async () => {
  const drives = new KnownDrives({ agentStateDir: await scratch() });
  drives.reconcile({ attached: [drive()], lastBackupAt: () => '2026-09-18T09:00:00.000Z' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(drives.recordPath).mode & 0o777, 0o600);

  drives.forget('aaaa-bbbb');
  assert.deepEqual(drives.list(), []);
  assert.deepEqual(drives.reconcile({ attached: [] }), []);
});

test('a damaged record reads as a machine that knows of no drives', async () => {
  const drives = new KnownDrives({ agentStateDir: await scratch() });
  drives.reconcile({ attached: [drive()], lastBackupAt: () => '2026-09-18T09:00:00.000Z' });
  fs.writeFileSync(drives.recordPath, 'not json at all', 'utf8');
  assert.deepEqual(drives.list(), []);
});
