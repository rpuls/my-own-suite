// The recovery key's files, as both agents see them. The record is small and
// each field decides something irreversible, so each is asserted rather than
// assumed; the escrow is the one copy of the key that lives outside the vault,
// so its lifetime is asserted to the byte.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generate, isRecoveryKey } = require('../backup/recovery-key.cjs');
const { RecoveryKeyStore } = require('./recovery-key-store.cjs');

async function scratch() { return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-recovery-')); }

async function store() {
  const root = await scratch();
  return new RecoveryKeyStore({ escrowPath: path.join(root, 'etc', 'vault-recovery-key'), stateDir: path.join(root, 'agent-state') });
}

const EMPTY = { acknowledgedAt: null, adoptedAt: null, fingerprint: null, firstUsedAt: null, rotatedAt: null };

// The key is what makes every backup readable at all, so it is generated once
// and reused; regenerating it would strand every earlier backup on the drive.
test('the key is a recovery key, generated once, kept root-only, and reused', async () => {
  const keys = await store();
  assert.equal(keys.readKey(), null);
  const key = keys.ensureKey();
  assert.equal(isRecoveryKey(key), true);
  assert.equal(keys.ensureKey(), key);
  assert.equal(keys.readKey(), key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keys.keyPath).mode & 0o777, 0o600);
});

test('the record is root-only and starts out saying nothing has happened', async () => {
  const keys = await store();
  assert.deepEqual(keys.readRecord(), EMPTY);
  assert.equal(keys.acknowledged(), false);
  keys.acknowledge('abc123');
  if (process.platform !== 'win32') assert.equal(fs.statSync(keys.recordPath).mode & 0o777, 0o600);
});

// The gate is one-time. An owner who has saved their key must never be asked
// again, including after the record is rewritten for another reason.
test('acknowledging keeps the moment it first happened', async () => {
  const keys = await store();
  const first = keys.acknowledge('abc123', new Date('2026-09-01T10:00:00.000Z'));
  assert.equal(first.acknowledgedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(keys.acknowledged(), true);
  assert.equal(keys.acknowledge('abc123', new Date('2026-09-05T10:00:00.000Z')).acknowledgedAt, '2026-09-01T10:00:00.000Z');
  keys.noteFirstUse(new Date('2026-09-02T10:00:00.000Z'));
  assert.equal(keys.readRecord().acknowledgedAt, '2026-09-01T10:00:00.000Z');
});

// Whether this machine's own key has ever created or opened a repository is
// what decides, later, between adopting an entered key and adding this one
// beside it. It is written once and never moved.
test('first use is recorded once and never moves', async () => {
  const keys = await store();
  assert.equal(keys.readRecord().firstUsedAt, null);
  keys.noteFirstUse(new Date('2026-09-02T10:00:00.000Z'));
  keys.noteFirstUse(new Date('2026-09-09T10:00:00.000Z'));
  assert.equal(keys.readRecord().firstUsedAt, '2026-09-02T10:00:00.000Z');
});

// The cold-standby path: a machine that has never used its own key takes on the
// one the owner just read off their kit, and that reading counts as the
// acknowledgement it would otherwise be asked for.
test('adopting an entered key marks the machine used and acknowledged at once', async () => {
  const keys = await store();
  const adopted = keys.adopt('feed1234', new Date('2026-09-07T12:00:00.000Z'));
  assert.deepEqual(adopted, { acknowledgedAt: '2026-09-07T12:00:00.000Z', adoptedAt: '2026-09-07T12:00:00.000Z', fingerprint: 'feed1234', firstUsedAt: '2026-09-07T12:00:00.000Z', rotatedAt: null });
  assert.equal(new RecoveryKeyStore({ stateDir: path.dirname(keys.recordPath) }).acknowledged(), true);
});

test('a key made on this machine is never marked as adopted', async () => {
  const keys = await store();
  keys.acknowledge('abc123', new Date('2026-09-01T10:00:00.000Z'));
  keys.noteFirstUse(new Date('2026-09-01T10:00:00.000Z'));
  assert.equal(keys.readRecord().adoptedAt, null);
});

test('a damaged record reads as a machine that has done nothing, not as a crash', async () => {
  const keys = await store();
  keys.acknowledge('abc123');
  fs.writeFileSync(keys.recordPath, 'not json at all', 'utf8');
  assert.deepEqual(keys.readRecord(), EMPTY);
});

// A rotation is the one thing that takes an acknowledgement back. The kit in
// the owner's drawer is wrong from that moment, and the gate that stood before
// their first backup belongs in front of them again until they have the new one.
test('rotating the key puts it back to unsaved, and remembers when', async () => {
  const keys = await store();
  keys.acknowledge('abc123', new Date('2026-09-01T10:00:00.000Z'));
  keys.noteFirstUse(new Date('2026-09-01T10:00:00.000Z'));

  const rotated = keys.rotate('feed1234', new Date('2026-09-18T10:00:00.000Z'));
  assert.equal(rotated.acknowledgedAt, null);
  assert.equal(rotated.fingerprint, 'feed1234');
  assert.equal(rotated.rotatedAt, '2026-09-18T10:00:00.000Z');
  assert.equal(rotated.firstUsedAt, '2026-09-01T10:00:00.000Z', 'this machine has still used its own key');
  assert.equal(keys.acknowledged(), false);
});

// The escrow exists from the vault's creation until the owner confirms they
// hold the key, and its presence is the whole of the handover state the vault
// agent reports: while it is there the encryption protects nothing.
test('the escrow is root-only and is destroyed rather than deleted', async () => {
  const keys = await store();
  const key = generate().key;
  assert.equal(keys.hasEscrow(), false, 'no escrow was ever written');

  keys.escrow(key);
  assert.equal(keys.hasEscrow(), true);
  assert.equal(keys.readEscrow(), key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keys.escrowPath).mode & 0o777, 0o600);

  keys.discardEscrow();
  assert.equal(keys.hasEscrow(), false);
  assert.equal(keys.readEscrow(), null);
  assert.doesNotThrow(() => keys.discardEscrow(), 'discarding twice is not an error');
});
