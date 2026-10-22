const assert = require('node:assert/strict');
const test = require('node:test');

const { withRoutes } = require('./support/route-harness.cjs');

const OTHER = { id: '1A2B-3C4D/archive-0000beef', keyState: 'locked', newestAt: '2026-10-20T03:00:00.000Z', owner: 'other', placeId: '1A2B-3C4D', placeKind: 'disk', placeLabel: 'Backup drive', reason: 'Another server\'s key opens these.', restorePoints: null, storedBytes: null, writtenBy: { hostname: 'mos-old', installId: 'old' } };
const OWN = { ...OTHER, id: '1A2B-3C4D/archive-0000cafe', keyState: 'own', owner: 'this', reason: null, restorePoints: 3, storedBytes: 12e9, writtenBy: { hostname: 'mos-home', installId: 'home' } };
const DESTINATION = { id: '1A2B-3C4D', kind: 'disk', label: 'Backup drive', reason: null, state: 'ready' };
const KEY = 'mos 7k2f 9xq4';
const inventory = { summary: { appCount: 0 } };

// The agent's own refusals, as its client raises them: one sentence and a status.
function refuse(message) {
  return Object.assign(new Error(message), { code: 'BACKUP_AGENT_REJECTED', statusCode: 409 });
}

function agent(calls) {
  const record = (name, answer) => async (input) => { calls.push([name, input]); return answer; };
  return {
    archiveKeys: record('keys', { result: { keys: [{ current: true, id: 'k1' }], noun: 'drive' } }),
    async eraseArchive(input) {
      calls.push(['erase', input]);
      if (input.confirmation !== 'ERASE') throw refuse('Confirm that these backups are to be erased.');
      const listed = [OTHER, OWN].find((archive) => archive.id === input.archiveId);
      if (!listed) throw refuse('Those backups are not listed any more.');
      if (listed.owner === 'this') throw refuse('These are this server\'s own backups. Delete them one restore point at a time in the list of backups.');
      return { erased: true };
    },
    forgetArchiveKey: record('forget-key', { result: { forgotten: true } }),
    removeArchiveKey: record('keys-remove', { result: { removed: 'k2' } }),
    status: async () => ({ archives: [OWN, OTHER], backups: [], destinations: [DESTINATION], recoveryKey: null }),
    unlockArchive: record('unlock', { result: { message: 'Unlocked.', recoveryKey: { acknowledged: true } } }),
  };
}

test('the status lists every archive and destination as the agent states them, place and state included', async () => {
  await withRoutes({ backupAgent: agent([]), backupInventory: { inventory: () => inventory } }, async (call) => {
    const status = await call('GET', '/backups/status');

    assert.equal(status.status, 200);
    assert.deepEqual(status.json().archives, [OWN, OTHER]);
    assert.deepEqual(status.json().destinations, [DESTINATION]);
  });
});

test('archive actions reach the agent with the archive id and only the fields each takes', async () => {
  const calls = [];

  await withRoutes({ backupAgent: agent(calls) }, async (call) => {
    const unlocked = await call('POST', '/backups/archives/unlock', { body: { archiveId: OTHER.id, initiator: 'smuggled', recoveryKey: KEY } });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.json().result.message, 'Unlocked.');
    assert.equal((await call('POST', '/backups/archives/keys', { body: { archiveId: OTHER.id, recoveryKey: KEY } })).status, 200);
    assert.equal((await call('POST', '/backups/archives/keys/remove', { body: { archiveId: OTHER.id, keyId: 'k2', recoveryKey: KEY } })).status, 200);
    assert.equal((await call('POST', '/backups/archives/forget-key', { body: { archiveId: OTHER.id, recoveryKey: 'smuggled' } })).status, 200);
    const erased = await call('POST', '/backups/archives/erase', { body: { archiveId: OTHER.id, confirmation: 'ERASE', force: true } });
    assert.equal(erased.status, 200);
    assert.deepEqual(erased.json(), { erased: true });
  });

  assert.deepEqual(calls, [
    ['unlock', { archiveId: OTHER.id, recoveryKey: KEY }],
    ['keys', { archiveId: OTHER.id, recoveryKey: KEY }],
    ['keys-remove', { archiveId: OTHER.id, keyId: 'k2', recoveryKey: KEY }],
    ['forget-key', { archiveId: OTHER.id }],
    ['erase', { archiveId: OTHER.id, confirmation: 'ERASE' }],
  ]);
});

test('erasing this server\'s own archive is refused with the agent\'s reason, as is an erase nobody confirmed', async () => {
  const calls = [];

  await withRoutes({ backupAgent: agent(calls) }, async (call) => {
    const own = await call('POST', '/backups/archives/erase', { body: { archiveId: OWN.id, confirmation: 'ERASE' } });
    assert.equal(own.status, 409);
    assert.match(own.json().error, /this server's own backups/u);

    const unconfirmed = await call('POST', '/backups/archives/erase', { body: { archiveId: OTHER.id } });
    assert.equal(unconfirmed.status, 409);
    assert.match(unconfirmed.json().error, /^Confirm/u);
  });

  assert.deepEqual(calls.map(([name]) => name), ['erase', 'erase']);
});

test('archive actions need a signed-in owner and never reach the agent without one', async () => {
  const calls = [];

  await withRoutes({ backupAgent: agent(calls) }, async (call) => {
    for (const route of ['unlock', 'keys', 'keys/remove', 'forget-key', 'erase']) {
      const answer = await call('POST', `/backups/archives/${route}`, { body: { archiveId: OTHER.id, confirmation: 'ERASE', recoveryKey: KEY }, signedIn: false });
      assert.equal(answer.status, 401, route);
    }
  });

  assert.deepEqual(calls, []);
});
