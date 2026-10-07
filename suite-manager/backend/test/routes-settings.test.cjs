const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CONSOLE_LOGIN_HANDOVER_FILE } = require('../../../shared/console-login-contract.cjs');
const { ConsoleLoginService } = require('../src/settings/console-login-service.cjs');
const { SetupError } = require('../src/setup/setup-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

test('the owner preference route stores through setup and answers its refusals as 400', async () => {
  const preferences = { technicalControls: false };
  const setup = {
    setPreference({ key, value }) {
      if (key !== 'technicalControls') throw new SetupError('UNKNOWN_PREFERENCE', 'That is not a Suite Manager preference.');
      if (typeof value !== 'boolean') throw new SetupError('INVALID_PREFERENCE_VALUE', 'That preference takes true or false.');
      preferences[key] = value;
      return { ...preferences };
    },
  };

  await withRoutes({ setup }, async (call) => {
    const saved = await call('POST', '/settings/preferences', { body: { key: 'technicalControls', value: true } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json().preferences, { technicalControls: true });

    const wrongType = await call('POST', '/settings/preferences', { body: { key: 'technicalControls', value: 'yes' } });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.json().code, 'INVALID_PREFERENCE_VALUE');

    const unknownKey = await call('POST', '/settings/preferences', { body: { key: 'showEverything', value: true } });
    assert.equal(unknownKey.status, 400);
    assert.equal(unknownKey.json().code, 'UNKNOWN_PREFERENCE');

    const oversized = await call('POST', '/settings/preferences', { body: { key: 'technicalControls', value: 'x'.repeat(5 * 1024) } });
    assert.equal(oversized.status, 413);
  });

  assert.deepEqual(preferences, { technicalControls: true });
});

test('security activity is the store summary for the last thirty days', async () => {
  const asked = [];
  const store = {
    getSecurityEventSummary({ since }) {
      asked.push(since);
      return { byType: [{ eventCount: 2, eventType: 'login-throttled', lastSeenAt: null, subjectCount: 1 }], eventCount: 2, lastSeenAt: null };
    },
  };

  await withRoutes({ setup: { store } }, async (call) => {
    const summary = (await call('GET', '/settings/security-events')).json();

    assert.equal(summary.eventCount, 2);
    assert.equal(summary.byType.length, 1);
    assert.equal(summary.since, asked[0]);
    const days = (Date.now() - Date.parse(summary.since)) / (24 * 60 * 60 * 1_000);
    assert.ok(days > 29.9 && days < 30.1, `since is ${days} days ago`);
  });
});

test('the server login is shown uncached while it is waiting, and not found once it is saved', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-console-login-'));
  fs.writeFileSync(path.join(stateDir, CONSOLE_LOGIN_HANDOVER_FILE), JSON.stringify({ password: 'generated', username: 'mos', version: 1 }));

  await withRoutes({ consoleLogin: new ConsoleLoginService({ stateDir }) }, async (call) => {
    const revealed = await call('POST', '/settings/console-login/reveal');
    assert.equal(revealed.status, 200);
    assert.deepEqual(revealed.json(), { password: 'generated', username: 'mos' });
    assert.equal(revealed.headers['cache-control'], 'no-store');

    assert.equal((await call('POST', '/settings/console-login/acknowledge')).status, 200);

    const gone = await call('POST', '/settings/console-login/reveal');
    assert.equal(gone.status, 404);
    assert.deepEqual(gone.json(), { code: 'CONSOLE_LOGIN_NOT_PENDING', error: 'This install has no server login waiting to be saved.' });
  });
});
