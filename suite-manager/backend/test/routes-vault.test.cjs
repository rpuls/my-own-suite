const assert = require('node:assert/strict');
const test = require('node:test');

const { VaultService } = require('../src/settings/vault-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

const OWNER_PASSWORD = 'correct horse battery';
const logger = { error() {}, info() {}, warn() {} };

function vaultServices(vaultAgent) {
  const vault = new VaultService({ agent: vaultAgent, logger, verifyOwnerPassword: async (password) => password === OWNER_PASSWORD });
  return { vault, vaultAgent };
}

// The encryption panel reads this route, and has to be able to say MOS could not tell.
test('the vault route survives an agent that is not there', async () => {
  await withRoutes({ vaultAgent: { status: async () => { throw new Error('The vault system agent is unavailable.'); } } }, async (call) => {
    const response = await call('GET', '/settings/vault');

    assert.equal(response.status, 200);
    assert.equal(response.json().vault.state, 'unknown');
    // A machine whose agent is down still has whatever disk it had a minute ago.
    assert.equal(response.json().encrypted, false);
  });
});

test('the vault route reports what the agent says', async () => {
  await withRoutes({ vaultAgent: { status: async () => ({ handover: 'done', state: 'unlocked', unlocksItself: true }) } }, async (call) => {
    const response = await call('GET', '/settings/vault');

    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), {
      asksForPassword: false,
      chipNeedsRepair: false,
      encrypted: true,
      vault: { handover: 'done', state: 'unlocked', unlocksItself: true },
    });
  });
});

test('the vault route answers whether this machine waits for a password', async () => {
  const vaultAgent = { status: async () => ({ state: 'unlocked', tpm: { mode: 'password', slot: 'needs-repair' }, unlocksItself: false }) };

  await withRoutes({ vaultAgent }, async (call) => {
    const view = await call('GET', '/settings/vault');

    assert.equal(view.status, 200);
    assert.equal(view.json().asksForPassword, true);
    assert.equal(view.json().chipNeedsRepair, true);
    assert.equal(view.json().encrypted, true);
  });
});

test('startup protection is confirmed with the owner password, which is also what gets enrolled', async () => {
  const enrollments = [];
  const vaultAgent = {
    async enrollChip(input) { enrollments.push(input); return { mode: input.mode, ok: true, slot: 'enrolled' }; },
    async status() { return { state: 'unlocked', tpm: { mode: 'password', slot: 'enrolled' }, unlocksItself: false }; },
  };

  await withRoutes(vaultServices(vaultAgent), async (call) => {
    const denied = await call('POST', '/settings/vault/startup-password', { body: { enabled: true, password: OWNER_PASSWORD }, signedIn: false });
    assert.equal(denied.status, 401);
    assert.equal(enrollments.length, 0);

    const wrong = await call('POST', '/settings/vault/startup-password', { body: { enabled: true, password: 'not the owner password' } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json().code, 'INVALID_PASSWORD');
    assert.equal(enrollments.length, 0, 'a password MOS does not accept never reaches the chip');

    const on = await call('POST', '/settings/vault/startup-password', { body: { enabled: true, password: OWNER_PASSWORD } });
    assert.equal(on.status, 200);
    assert.equal(on.json().asksForPassword, true);
    assert.deepEqual(enrollments, [{ mode: 'password', pin: OWNER_PASSWORD }]);

    const off = await call('POST', '/settings/vault/startup-password', { body: { enabled: false, password: OWNER_PASSWORD } });
    assert.equal(off.status, 200);
    assert.deepEqual(enrollments[1], { mode: 'automatic', pin: null }, 'turning it off enrolls no password at all');
  });
});

// A password the owner may forget must not become the only way in before they
// hold the key that is the other way in.
test('startup protection cannot be turned on before the recovery key has been handed over', async () => {
  const enrollments = [];
  const vaultAgent = {
    async enrollChip(input) { enrollments.push(input); return { mode: input.mode, ok: true, slot: 'enrolled' }; },
    async status() { return { handover: 'pending', state: 'unlocked', tpm: { mode: 'automatic', slot: 'enrolled' }, unlocksItself: true }; },
  };

  await withRoutes(vaultServices(vaultAgent), async (call) => {
    const refused = await call('POST', '/settings/vault/startup-password', { body: { enabled: true, password: OWNER_PASSWORD } });
    assert.equal(refused.status, 409);
    assert.equal(refused.json().code, 'VAULT_KEY_UNSAVED');
    assert.equal(enrollments.length, 0);

    // Turning it off is always allowed: that is the direction that cannot lock anyone out.
    assert.equal((await call('POST', '/settings/vault/startup-password', { body: { enabled: false, password: OWNER_PASSWORD } })).status, 200);
  });
});

// The owner has to know their server will want the recovery key after the next restart.
test('a chip that refuses the switch is reported, not swallowed, and an absent agent changes nothing', async () => {
  const refusing = {
    async enrollChip() { return { mode: 'password', ok: false, reason: 'tpm-refused', slot: 'needs-repair' }; },
    async status() { return { state: 'unlocked', tpm: { mode: 'password', slot: 'needs-repair' } }; },
  };
  const absent = { async status() { throw new Error('The vault system agent is unavailable.'); } };

  await withRoutes(vaultServices(refusing), async (call) => {
    const refused = await call('POST', '/settings/vault/startup-password', { body: { enabled: true, password: OWNER_PASSWORD } });
    assert.equal(refused.status, 409);
    assert.equal(refused.json().code, 'VAULT_TPM_REFUSED');
    assert.equal(refused.json().reason, 'tpm-refused');
    assert.match(refused.json().error, /asks for your recovery key/u);
  });

  await withRoutes(vaultServices(absent), async (call) => {
    const unavailable = await call('POST', '/settings/vault/startup-password', { body: { enabled: true, password: OWNER_PASSWORD } });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.json().code, 'VAULT_AGENT_UNAVAILABLE');
  });
});
