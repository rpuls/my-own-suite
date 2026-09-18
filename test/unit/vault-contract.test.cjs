const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  VAULT_STATES,
  machineHasVault,
  readVaultDescriptor,
  vaultAsksForPassword,
  vaultChipNeedsRepair,
  vaultIsPresent,
} = require('../../shared/vault-contract.cjs');

// One predicate, because it was being re-derived in four places at once — the
// reconciler, the backup agent and two screens — and four copies of one rule is
// how a property of a machine turns into a product variant nobody meant to ship.
test('a vault is present when it is open or closed, and not otherwise', () => {
  assert.equal(vaultIsPresent(VAULT_STATES.UNLOCKED), true);
  assert.equal(vaultIsPresent(VAULT_STATES.LOCKED), true, 'a locked vault is still a vault');
  assert.equal(vaultIsPresent(VAULT_STATES.ABSENT), false);
  assert.equal(vaultIsPresent(VAULT_STATES.UNSUPPORTED), false);
  assert.equal(vaultIsPresent(VAULT_STATES.UNKNOWN), false);
});

test('it reads a status object, a descriptor, or a bare state', () => {
  assert.equal(vaultIsPresent({ state: 'unlocked', unlocksItself: true }), true);
  assert.equal(vaultIsPresent({ reason: 'disk-already-full', state: 'unsupported' }), false);
  assert.equal(vaultIsPresent(null), false);
  assert.equal(vaultIsPresent(undefined), false);
  assert.equal(vaultIsPresent({}), false);
});

test('a machine with no descriptor, or an unreadable one, has no vault', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-vault-contract-'));
  context.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const descriptor = path.join(dir, 'vault.json');

  assert.equal(machineHasVault(descriptor), false);
  assert.equal(readVaultDescriptor(descriptor), null);

  fs.writeFileSync(descriptor, 'not json at all');
  assert.equal(machineHasVault(descriptor), false, 'a corrupt descriptor is never read as a vault');

  fs.writeFileSync(descriptor, JSON.stringify({ reason: 'disk-already-full', state: 'unsupported', version: 1 }));
  assert.equal(machineHasVault(descriptor), false);

  fs.writeFileSync(descriptor, JSON.stringify({ device: '/dev/sda3', state: 'unlocked', version: 1 }));
  assert.equal(machineHasVault(descriptor), true);
});


// The same rule, for the same reason: three screens and two backend hooks ask
// whether this machine waits for the owner's password after a restart, and a
// screen that answered it for itself would eventually promise protection an
// owner does not have.
test('a machine asks for a password only when its chip is enrolled to', () => {
  assert.equal(vaultAsksForPassword({ state: 'locked', tpm: { mode: 'password', slot: 'enrolled' } }), true);
  assert.equal(vaultAsksForPassword({ state: 'unlocked', tpm: { mode: 'automatic', slot: 'enrolled' } }), false);
  assert.equal(vaultAsksForPassword({ state: 'unlocked', tpm: null }), false, 'a machine with no chip asks for the key, not a password');
  assert.equal(vaultAsksForPassword({ state: 'unknown' }), false, 'an agent that could not be read never claims protection');
  assert.equal(vaultAsksForPassword(null), false);
});

test('a chip needs repair only on a machine that has one', () => {
  assert.equal(vaultChipNeedsRepair({ tpm: { mode: 'password', slot: 'needs-repair' } }), true);
  assert.equal(vaultChipNeedsRepair({ tpm: { mode: 'automatic', slot: 'needs-repair' } }), true);
  assert.equal(vaultChipNeedsRepair({ tpm: { mode: 'password', slot: 'enrolled' } }), false);
  assert.equal(vaultChipNeedsRepair({ tpm: null }), false);
  assert.equal(vaultChipNeedsRepair({ state: 'unknown' }), false);
});
