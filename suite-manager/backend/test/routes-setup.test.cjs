const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CodedError } = require('../../../shared/coded-error.cjs');
const { CONSOLE_LOGIN_HANDOVER_FILE } = require('../../../shared/console-login-contract.cjs');
const { ConsoleLoginService } = require('../src/settings/console-login-service.cjs');
const { HandoverService } = require('../src/setup/handover-service.cjs');
const { SetupError, TERMS_VERSION } = require('../src/setup/setup-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

const OWNER = { email: 'owner@example.com', name: 'Suite Owner' };
const NEEDS_OWNER = { owner: null, status: 'needs-owner', terms: { accepted: false, acceptedAt: null, version: TERMS_VERSION } };

function ownerSetup(calls = []) {
  return {
    createOwner: async (input) => { calls.push(['create', input]); return { owner: OWNER, sessionToken: 'new-session', status: 'signed-in' }; },
    logout: () => ({ owner: OWNER, status: 'signed-out' }),
  };
}

test('empty setup status requires owner creation', async () => {
  await withRoutes({ setup: { status: () => NEEDS_OWNER } }, async (call) => {
    const response = await call('GET', '/setup/status', { signedIn: false });

    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { ...NEEDS_OWNER, ownerClaimRequired: false, secureTransport: false });
  });
});

// What each agent answer means is handover-service.test.cjs; this pins the
// wiring: only a signed-in caller is told, and confirming the login takes it to done.
test('the setup status says what this machine still has to hand its owner', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-handover-'));
  fs.writeFileSync(path.join(stateDir, CONSOLE_LOGIN_HANDOVER_FILE), JSON.stringify({ password: 'generated', username: 'mos', version: 1 }));
  const consoleLogin = new ConsoleLoginService({ stateDir });
  const vaultAgent = { status: async () => ({ handover: 'pending', state: 'unlocked' }) };
  const logger = { error() {}, info() {}, warn() {} };

  await withRoutes({ consoleLogin, handover: new HandoverService({ consoleLogin, logger, vaultAgent }) }, async (call) => {
    assert.equal((await call('GET', '/setup/status', { signedIn: false })).json().handover, undefined);

    const read = async () => (await call('GET', '/setup/status')).json().handover;
    assert.deepEqual(await read(), { login: 'pending', recoveryKey: 'pending' });

    await call('POST', '/settings/console-login/acknowledge');
    assert.deepEqual(await read(), { login: 'done', recoveryKey: 'pending' });
  });
});

test('cloud owner creation requires HTTPS and the one-time claim token', async () => {
  const calls = [];
  const addressService = { allowedHosts: () => new Set(['home.test']), httpsRedirectFor: () => null, recordDoor: (host, input) => calls.push(['door', host, input]) };
  const owner = { email: OWNER.email, name: OWNER.name, password: 'correct horse battery staple' };

  await withRoutes({ addressService, ownerClaimToken: 'claim-secret', setup: ownerSetup(calls) }, async (call) => {
    const insecure = await call('POST', '/setup/owner', { body: { ...owner, claimToken: 'claim-secret' }, signedIn: false });
    assert.equal(insecure.status, 403);
    assert.equal(insecure.json().code, 'HTTPS_REQUIRED_FOR_OWNER_SETUP');

    const https = { 'X-Forwarded-Proto': 'https' };
    const wrongClaim = await call('POST', '/setup/owner', { body: { ...owner, claimToken: 'wrong' }, headers: https, signedIn: false });
    assert.equal(wrongClaim.status, 403);
    assert.equal(wrongClaim.json().code, 'OWNER_CLAIM_REQUIRED');
    assert.deepEqual(calls, [], 'a refused claim neither creates the owner nor moves the address');

    const claimed = await call('POST', '/setup/owner', { body: { ...owner, claimToken: 'claim-secret' }, headers: https, signedIn: false });
    assert.equal(claimed.status, 201);
    assert.match(String(claimed.headers['set-cookie']), /; Secure/u);
    assert.deepEqual(calls.map(([name]) => name), ['create', 'door']);
    assert.deepEqual(calls[1], ['door', 'home.test', { scheme: 'https' }]);
  });
});

test('an owner created on a door that cannot be recorded is still created, and the failure is logged', async () => {
  const errors = [];
  const addressService = { allowedHosts: () => new Set(['home.test']), httpsRedirectFor: () => null, recordDoor: () => { throw new Error('address file is read-only'); } };
  const logger = { error: (event, fields) => errors.push([event, fields.host]), info() {}, warn() {} };

  await withRoutes({ addressService, logger, setup: ownerSetup() }, async (call) => {
    assert.equal((await call('POST', '/setup/owner', { body: { email: OWNER.email }, signedIn: false })).status, 201);
  });

  assert.deepEqual(errors, [['suite-address-record-failed', 'home.test']]);
});

test('duplicate owner creation returns conflict', async () => {
  const setup = { createOwner: async () => { throw new SetupError('OWNER_ALREADY_EXISTS', 'The MOS owner account already exists.'); } };

  await withRoutes({ setup }, async (call) => {
    const duplicate = await call('POST', '/setup/owner', { body: { email: OWNER.email }, signedIn: false });

    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json().code, 'OWNER_ALREADY_EXISTS');
  });
});

test('session cookies become Secure only for HTTPS forwarded requests', async () => {
  const signIn = { signIn: async () => ({ knownBrowserToken: null, owner: OWNER, sessionToken: 'session', status: 'signed-in' }) };
  const addressService = { allowedHosts: () => new Set(['home.test']), httpsRedirectFor: () => null, recordDoor() {} };

  await withRoutes({ addressService, setup: ownerSetup(), signIn }, async (call) => {
    const overHttp = await call('POST', '/setup/owner', { body: { email: OWNER.email }, signedIn: false });
    assert.doesNotMatch(overHttp.headers['set-cookie'][0], /; Secure/u);

    const overHttps = await call('POST', '/auth/login', { body: { email: OWNER.email }, headers: { 'X-Forwarded-Proto': 'https' }, signedIn: false });
    assert.match(overHttps.headers['set-cookie'][0], /; Secure/u);
  });
});

test('a sign-in sets the session, remembers a new browser, and passes on the client address and known browser', async () => {
  const asked = [];
  const signIn = {
    signIn: async (input) => {
      asked.push(input);
      return { knownBrowserToken: input.knownBrowserToken ? null : 'new-browser', owner: OWNER, sessionToken: 'session', status: 'signed-in' };
    },
  };

  await withRoutes({ signIn }, async (call) => {
    const fresh = await call('POST', '/auth/login', { body: { email: OWNER.email, password: 'pw' }, headers: { 'X-Forwarded-For': '203.0.113.9' }, signedIn: false });
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.json(), { owner: OWNER, status: 'signed-in' });
    assert.deepEqual(fresh.headers['set-cookie'].map((cookie) => cookie.split('=')[0]), ['mos_session', 'mos_known_browser']);

    const known = await call('POST', '/auth/login', { body: { email: OWNER.email, password: 'pw' }, headers: { Cookie: 'mos_known_browser=known' }, signedIn: false });
    assert.deepEqual(known.headers['set-cookie'].map((cookie) => cookie.split('=')[0]), ['mos_session']);
  });

  assert.deepEqual(asked.map(({ credentials, knownBrowserToken }) => [credentials.email, knownBrowserToken]), [[OWNER.email, undefined], [OWNER.email, 'known']]);
  assert.equal(asked[0].ip, '203.0.113.9');
});

test('a throttled sign-in answers 429 with its wait', async () => {
  const signIn = { signIn: async () => { throw new CodedError('LOGIN_THROTTLED', 'Too many sign-in attempts. Wait a moment and try again.', { retryAfterSeconds: 5, statusCode: 429 }); } };

  await withRoutes({ signIn }, async (call) => {
    const throttled = await call('POST', '/auth/login', { body: { email: OWNER.email }, signedIn: false });

    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers['retry-after'], '5');
    assert.deepEqual(throttled.json(), { code: 'LOGIN_THROTTLED', error: 'Too many sign-in attempts. Wait a moment and try again.' });
  });
});

test('logging out clears the session cookie', async () => {
  await withRoutes({ setup: ownerSetup() }, async (call) => {
    const logout = await call('POST', '/auth/logout');

    assert.equal(logout.status, 200);
    assert.equal(logout.json().status, 'signed-out');
    assert.match(logout.headers['set-cookie'][0], /^mos_session=; .*Max-Age=0/u);
  });
});
