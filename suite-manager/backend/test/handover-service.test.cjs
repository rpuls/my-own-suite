// The page in front of Suite Manager is decided from this, so what each answer
// means is pinned here, one agent answer per line, without a server in the way.

const assert = require('node:assert/strict');
const test = require('node:test');

const { HandoverService } = require('../src/setup/handover-service.cjs');

const quiet = { warn() {} };
const login = (status) => ({ status: () => status });
const NO_LOGIN = login({ pending: false, unreadable: false });
const vaultIn = (state, handover) => ({ async status() { return handover === undefined ? { state } : { handover, state }; } });
const service = (options) => new HandoverService({ consoleLogin: NO_LOGIN, logger: quiet, ...options });

test('a machine without a vault owes nothing but the login', async () => {
  assert.deepEqual(await service({ vaultAgent: vaultIn('absent') }).state(), { login: 'done', recoveryKey: 'done' });
  assert.deepEqual(await service({ vaultAgent: vaultIn('unsupported') }).state(), { login: 'done', recoveryKey: 'done' });
});

test('the key is owed exactly while the vault still holds its escrowed copy', async () => {
  assert.equal((await service({ vaultAgent: vaultIn('unlocked', 'pending') }).state()).recoveryKey, 'pending');
  assert.equal((await service({ vaultAgent: vaultIn('locked', 'pending') }).state()).recoveryKey, 'pending');
  assert.equal((await service({ vaultAgent: vaultIn('unlocked', 'done') }).state()).recoveryKey, 'done');
});

// A machine whose vault agent is silent has an owner who was never shown their
// key, so nothing that could not be read is ever `done`.
test('what could not be read holds the page', async () => {
  assert.equal((await service({ vaultAgent: vaultIn('unknown') }).state()).recoveryKey, 'unknown');
  assert.equal((await service({ vaultAgent: { async status() { throw new Error('socket gone'); } } }).state()).recoveryKey, 'unknown');
  assert.equal((await service({ vaultAgent: vaultIn('unlocked') }).state()).recoveryKey, 'unknown', 'a present vault that does not say is not done');
});

test('the login follows the console handover file', async () => {
  const vaultAgent = vaultIn('absent');
  assert.equal((await service({ consoleLogin: login({ pending: true, unreadable: false }), vaultAgent }).state()).login, 'pending');
  assert.equal((await service({ consoleLogin: login({ pending: false, unreadable: true }), vaultAgent }).state()).login, 'unreadable');
  assert.equal((await service({ consoleLogin: NO_LOGIN, vaultAgent }).state()).login, 'done');
});
