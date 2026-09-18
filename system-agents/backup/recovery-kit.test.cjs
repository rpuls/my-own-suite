// What a machine remembers about its recovery key, and the sheet an owner is
// asked to keep. The record is small and its three fields each decide something
// irreversible, so each is asserted rather than assumed; the kit is checked for
// the two failures that would matter on paper — a missing destination an owner
// can no longer look up, and a storage secret printed where it does not belong.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generate } = require('./recovery-key.cjs');
const { RecoveryKeyRecord, recoveryKitFilename, recoveryKitText } = require('./recovery-kit.cjs');

async function scratch() { return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-recovery-')); }

const SECRET = 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY';
const KEY = generate().key;

test('the record is root-only and starts out saying nothing has happened', async () => {
  const record = new RecoveryKeyRecord({ agentStateDir: path.join(await scratch(), 'agent-state') });
  assert.deepEqual(record.read(), { acknowledgedAt: null, adoptedAt: null, fingerprint: null, firstUsedAt: null, rotatedAt: null });
  assert.equal(record.acknowledged(), false);
  record.acknowledge('abc123');
  if (process.platform !== 'win32') assert.equal(fs.statSync(record.recordPath).mode & 0o777, 0o600);
});

// The gate is one-time. An owner who has saved their key must never be asked
// again, including after the record is rewritten for another reason.
test('acknowledging keeps the moment it first happened', async () => {
  const record = new RecoveryKeyRecord({ agentStateDir: await scratch() });
  const first = record.acknowledge('abc123', new Date('2026-09-01T10:00:00.000Z'));
  assert.equal(first.acknowledgedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(record.acknowledged(), true);
  assert.equal(record.acknowledge('abc123', new Date('2026-09-05T10:00:00.000Z')).acknowledgedAt, '2026-09-01T10:00:00.000Z');
  record.noteFirstUse(new Date('2026-09-02T10:00:00.000Z'));
  assert.equal(record.read().acknowledgedAt, '2026-09-01T10:00:00.000Z');
});

// Whether this machine's own key has ever created or opened a repository is
// what decides, later, between adopting an entered key and adding this one
// beside it. It is written once and never moved.
test('first use is recorded once and never moves', async () => {
  const record = new RecoveryKeyRecord({ agentStateDir: await scratch() });
  assert.equal(record.read().firstUsedAt, null);
  record.noteFirstUse(new Date('2026-09-02T10:00:00.000Z'));
  record.noteFirstUse(new Date('2026-09-09T10:00:00.000Z'));
  assert.equal(record.read().firstUsedAt, '2026-09-02T10:00:00.000Z');
});

// The cold-standby path: a machine that has never used its own key takes on the
// one the owner just read off their kit, and that reading counts as the
// acknowledgement it would otherwise be asked for.
test('adopting an entered key marks the machine used and acknowledged at once', async () => {
  const record = new RecoveryKeyRecord({ agentStateDir: await scratch() });
  const adopted = record.adopt('feed1234', new Date('2026-09-07T12:00:00.000Z'));
  assert.deepEqual(adopted, { acknowledgedAt: '2026-09-07T12:00:00.000Z', adoptedAt: '2026-09-07T12:00:00.000Z', fingerprint: 'feed1234', firstUsedAt: '2026-09-07T12:00:00.000Z', rotatedAt: null });
  assert.equal(new RecoveryKeyRecord({ recordPath: record.recordPath }).acknowledged(), true);
});

// A key made here and a key taken off another server's kit are the same secret
// but not the same sentence, and the screen says which one this is. Only
// adoption records the moment.
test('a key made on this machine is never marked as adopted', async () => {
  const record = new RecoveryKeyRecord({ agentStateDir: await scratch() });
  record.acknowledge('abc123', new Date('2026-09-01T10:00:00.000Z'));
  record.noteFirstUse(new Date('2026-09-01T10:00:00.000Z'));
  assert.equal(record.read().adoptedAt, null);
});

test('a damaged record reads as a machine that has done nothing, not as a crash', async () => {
  const record = new RecoveryKeyRecord({ agentStateDir: await scratch() });
  record.acknowledge('abc123');
  fs.writeFileSync(record.recordPath, 'not json at all', 'utf8');
  assert.deepEqual(record.read(), { acknowledgedAt: null, adoptedAt: null, fingerprint: null, firstUsedAt: null, rotatedAt: null });
});

// The kit is what is left when the server is not. It has to name the bucket
// well enough to point a new machine at it, and it must never be the place an
// owner's storage secret ends up.
test('the kit names every destination and carries no storage credential', () => {
  const kit = recoveryKitText({
    destinations: [
      { kind: 'drive', label: 'Backup USB' },
      { bucket: 'mos-backups', endpoint: 'https://s3.example.com', folder: 'home', kind: 'bucket', label: 'Backblaze B2', region: 'eu-central-003' },
    ],
    homeAddress: 'https://home.example.com/',
    hostname: 'mos-home',
    key: KEY,
    now: new Date('2026-09-07T12:00:00.000Z'),
  });

  assert.match(kit, /My Own Suite/u);
  assert.match(kit, /2026-09-07/u);
  assert.match(kit, /mos-home/u);
  assert.match(kit, /https:\/\/home\.example\.com\//u);
  assert.ok(kit.includes(KEY));
  assert.ok(kit.includes('Backup USB'));
  assert.ok(kit.includes('https://s3.example.com'));
  assert.ok(kit.includes('mos-backups'));
  assert.ok(kit.includes('home'));
  assert.ok(kit.includes('eu-central-003'));
  assert.equal(kit.includes(SECRET), false);
  assert.equal(kit.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.match(kit, /Install MOS on the replacement machine/u);
  assert.match(kit, /Enter recovery key/u);
  assert.match(kit, /Your storage provider's console holds your access key; a new key for the same bucket works too\./u);
});

test('a kit made before anything is connected still says so rather than lying', () => {
  const kit = recoveryKitText({ hostname: 'mos-home', key: KEY, now: new Date('2026-09-07T12:00:00.000Z') });
  assert.match(kit, /\(none connected yet\)/u);
  assert.ok(kit.includes(KEY));
});

test('the kit file is named for the server and the day it was made', () => {
  assert.equal(recoveryKitFilename({ hostname: 'MOS Home.local', now: new Date('2026-09-07T12:00:00.000Z') }), 'mos-recovery-kit-mos-home-local-2026-09-07.txt');
  assert.equal(recoveryKitFilename({ hostname: '', now: new Date('2026-09-07T12:00:00.000Z') }), 'mos-recovery-kit-server-2026-09-07.txt');
});

// The kit is what an owner is holding when the server will not come back, so on
// a machine whose disk this key also opens it has to say so — and on one where
// it does not, it must not claim a disk that is not encrypted.
test('a kit from a machine with an encrypted disk explains that half of the key too', () => {
  const kit = recoveryKitText({ encryptedDisk: true, hostname: 'mos-home', key: KEY, now: new Date('2026-09-17T12:00:00.000Z') });
  assert.match(kit, /also opens the encrypted disk/u);
  assert.match(kit, /security chip/u);
  assert.ok(kit.includes(KEY), 'the key itself is still on the sheet');
});

test('a kit from a machine with no vault claims no disk', () => {
  const kit = recoveryKitText({ hostname: 'mos-cloud', key: KEY, now: new Date('2026-09-17T12:00:00.000Z') });
  assert.doesNotMatch(kit, /encrypted disk/u);
});

// A rotation is the one thing that takes an acknowledgement back. The kit in
// the owner's drawer is wrong from that moment, and the gate that stood before
// their first backup belongs in front of them again until they have the new one.
test('rotating the key puts it back to unsaved, and remembers when', async () => {
  const record = new RecoveryKeyRecord({ agentStateDir: await scratch() });
  record.acknowledge('abc123', new Date('2026-09-01T10:00:00.000Z'));
  record.noteFirstUse(new Date('2026-09-01T10:00:00.000Z'));

  const rotated = record.rotate('feed1234', new Date('2026-09-18T10:00:00.000Z'));
  assert.equal(rotated.acknowledgedAt, null);
  assert.equal(rotated.fingerprint, 'feed1234');
  assert.equal(rotated.rotatedAt, '2026-09-18T10:00:00.000Z');
  assert.equal(rotated.firstUsedAt, '2026-09-01T10:00:00.000Z', 'this machine has still used its own key');
  assert.equal(record.acknowledged(), false);

  record.acknowledge('feed1234', new Date('2026-09-18T10:05:00.000Z'));
  assert.equal(record.acknowledged(), true);
});

// The sheet has to be right about how the server it came from starts, because
// an owner reading it is usually reading it at the worst moment.
test('a kit from a machine that asks for a password at startup says so', () => {
  const kit = recoveryKitText({ asksForPassword: true, encryptedDisk: true, hostname: 'mos-home', key: KEY, now: new Date('2026-09-18T12:00:00.000Z') });
  assert.match(kit, /ask for your Suite Manager password after every restart/u);
  assert.match(kit, /takes the key above instead/u);
  assert.doesNotMatch(kit, /never asks you for anything/u);
});
