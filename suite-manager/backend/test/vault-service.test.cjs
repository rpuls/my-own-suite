const assert = require('node:assert/strict');
const test = require('node:test');

const { VaultService } = require('../src/settings/vault-service.cjs');

const OWNER_PASSWORD = 'correct horse battery';

function vaultService(agent) {
  const logged = [];
  const log = (level) => (event, fields) => logged.push({ event, level, ...fields });
  const service = new VaultService({
    agent,
    logger: { info: log('info'), warn: log('warn') },
    verifyOwnerPassword: async (password) => password === OWNER_PASSWORD,
  });
  return { logged, service };
}

test('a changed password is taught to a chip that asks for it, and nothing is said where there is nothing to teach', async () => {
  const taught = vaultService({ enrollChip: async () => ({ mode: 'password', ok: true }) }).service;
  const opensItself = vaultService({ enrollChip: async () => ({ mode: 'automatic', ok: true, unchanged: true }) }).service;
  const noVault = vaultService({ enrollChip: async () => ({ ok: true, vault: false }) }).service;

  assert.deepEqual(await taught.teachOwnerPassword('new passphrase'), { mode: 'password', ok: true });
  assert.equal(await opensItself.teachOwnerPassword('new passphrase'), null);
  assert.equal(await noVault.teachOwnerPassword('new passphrase'), null);
});

test('a chip that will not learn the password is reported, and an absent agent is too', async () => {
  const refused = vaultService({ enrollChip: async () => ({ mode: 'password', ok: false, reason: 'tpm-refused' }) }).service;
  const absent = vaultService({ enrollChip: async () => { throw new Error('The vault system agent is unavailable.'); } });

  assert.deepEqual(await refused.teachOwnerPassword('new passphrase'), { mode: 'password', ok: false, reason: 'tpm-refused' });
  assert.deepEqual(await absent.service.teachOwnerPassword('new passphrase'), { mode: null, ok: false, reason: 'vault-agent-unavailable' });
  assert.deepEqual(absent.logged.map(({ event, level }) => [level, event]), [['warn', 'vault-chip-enroll-failed']]);
});

test('a sign-in repairs a chip slot that is waiting, in either mode, and leaves a healthy one alone', async () => {
  const enrollments = [];
  const enrollChip = async (input) => { enrollments.push(input); return { mode: 'automatic', ok: true }; };
  const waiting = vaultService({ enrollChip, status: async () => ({ state: 'unlocked', tpm: { mode: 'automatic', slot: 'needs-repair' } }) });
  const healthy = vaultService({ enrollChip, status: async () => ({ state: 'unlocked', tpm: { mode: 'password', slot: 'enrolled' } }) });

  await waiting.service.repairOnSignIn(OWNER_PASSWORD);
  await healthy.service.repairOnSignIn(OWNER_PASSWORD);

  assert.deepEqual(enrollments, [{ mode: 'current', pin: OWNER_PASSWORD }]);
  assert.deepEqual(waiting.logged, [{ event: 'vault-chip-repair', level: 'info', ok: true, reason: null }]);
});

test('a repair that cannot reach the agent is logged and never thrown at the sign-in', async () => {
  const { logged, service } = vaultService({ status: async () => { throw new Error('The vault system agent is unavailable.'); } });

  await service.repairOnSignIn(OWNER_PASSWORD);

  assert.deepEqual(logged.map(({ event, level }) => [level, event]), [['warn', 'vault-chip-repair-failed']]);
});

test('startup protection is confirmed with the owner password, which is also what gets enrolled', async () => {
  const enrollments = [];
  const { service } = vaultService({
    enrollChip: async (input) => { enrollments.push(input); return { mode: input.mode, ok: true }; },
    status: async () => ({ state: 'unlocked', tpm: { mode: 'password', slot: 'enrolled' } }),
  });

  assert.deepEqual(await service.setStartupPassword({ password: 'not the owner password', wanted: true }), { refused: 'INVALID_PASSWORD' });
  assert.equal(enrollments.length, 0, 'a password MOS does not accept never reaches the chip');

  const on = await service.setStartupPassword({ password: OWNER_PASSWORD, wanted: true });
  assert.equal(on.asksForPassword, true);
  assert.deepEqual(on.vault, { state: 'unlocked', tpm: { mode: 'password', slot: 'enrolled' } });

  const off = await service.setStartupPassword({ password: OWNER_PASSWORD, wanted: false });
  assert.equal(off.asksForPassword, false);
  assert.deepEqual(enrollments, [{ mode: 'password', pin: OWNER_PASSWORD }, { mode: 'automatic', pin: null }]);
});

test('startup protection waits for the recovery key, but turning it off never does', async () => {
  const { service } = vaultService({
    enrollChip: async (input) => ({ mode: input.mode, ok: true }),
    status: async () => ({ handover: 'pending', state: 'unlocked' }),
  });

  assert.deepEqual(await service.setStartupPassword({ password: OWNER_PASSWORD, wanted: true }), { refused: 'VAULT_KEY_UNSAVED' });
  assert.equal((await service.setStartupPassword({ password: OWNER_PASSWORD, wanted: false })).asksForPassword, false);
});

test('a chip that refuses the switch, or an agent that is not there, is a refusal with its reason', async () => {
  const refusing = vaultService({
    enrollChip: async () => ({ mode: 'password', ok: false, reason: 'no-tpm' }),
    status: async () => ({ state: 'unlocked' }),
  }).service;
  const absent = vaultService({ status: async () => { throw new Error('The vault system agent is unavailable.'); } });

  assert.deepEqual(await refusing.setStartupPassword({ password: OWNER_PASSWORD, wanted: true }), { reason: 'no-tpm', refused: 'VAULT_TPM_REFUSED' });
  assert.deepEqual(await absent.service.setStartupPassword({ password: OWNER_PASSWORD, wanted: true }), { refused: 'VAULT_AGENT_UNAVAILABLE' });
  assert.deepEqual(absent.logged.map(({ event, level }) => [level, event]), [['warn', 'vault-agent-unavailable']]);
});
