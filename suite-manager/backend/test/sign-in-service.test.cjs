const assert = require('node:assert/strict');
const test = require('node:test');

const { SignInService } = require('../src/auth/sign-in-service.cjs');
const { SetupError } = require('../src/setup/setup-service.cjs');

const OWNER = { email: 'owner@example.com', name: 'Suite Owner' };
const PASSWORD = 'correct horse battery';

function signInFixture({ alertFails = false, knownBrowser = false, recordFails = false, retryAfterMs = 0 } = {}) {
  const calls = [];
  const service = new SignInService({
    alerts: { notify: async () => { calls.push(['alert']); if (alertFails) throw new Error('relay refused'); } },
    recordSecurityEvent: (event) => { calls.push(['record', event]); if (recordFails) throw new Error('database is locked'); },
    securityLogger: (event) => calls.push(['log', event]),
    setup: {
      isKnownBrowser: (token) => knownBrowser && token === 'known-browser',
      async login(credentials) {
        calls.push(['login', credentials]);
        if (credentials.password !== PASSWORD) throw new SetupError('INVALID_LOGIN', 'Email or password is incorrect.');
        return { owner: OWNER, sessionToken: 'session-token', status: 'signed-in' };
      },
      rememberBrowser: () => 'new-browser',
    },
    throttle: {
      fingerprint: (ip) => `fingerprint-of-${ip}`,
      recordFailure: (attempt) => calls.push(['failure', attempt]),
      recordSuccess: (attempt) => calls.push(['success', attempt]),
      retryAfterMs: () => retryAfterMs,
    },
    vault: { repairOnSignIn: async (password) => calls.push(['repair', password]) },
  });
  return { calls, service };
}

test('a sign-in answers the session, remembers a new browser, and gives the chip its chance to repair', async () => {
  const { calls, service } = signInFixture();

  const result = await service.signIn({ credentials: { email: OWNER.email, password: PASSWORD }, ip: '192.168.1.20', knownBrowserToken: undefined });

  assert.deepEqual(result, { knownBrowserToken: 'new-browser', owner: OWNER, sessionToken: 'session-token', status: 'signed-in' });
  assert.deepEqual(calls.map(([name]) => name), ['login', 'success', 'repair']);
  assert.deepEqual(calls[1][1], { email: OWNER.email, ip: '192.168.1.20', knownBrowser: false });
  assert.deepEqual(calls[2], ['repair', PASSWORD]);
});

test('a browser that has signed in before is not remembered again', async () => {
  const { service } = signInFixture({ knownBrowser: true });

  const result = await service.signIn({ credentials: { email: OWNER.email, password: PASSWORD }, ip: '192.168.1.20', knownBrowserToken: 'known-browser' });

  assert.equal(result.knownBrowserToken, null);
});

test('a wrong password counts against the backoff and is thrown as it came', async () => {
  const { calls, service } = signInFixture();

  await assert.rejects(
    service.signIn({ credentials: { email: OWNER.email, password: 'wrong' }, ip: '192.168.1.20' }),
    (error) => error instanceof SetupError && error.code === 'INVALID_LOGIN' && error.statusCode === 401,
  );
  assert.deepEqual(calls.map(([name]) => name), ['login', 'failure']);
});

test('a throttled sign-in is refused with a wait, recorded, logged and alerted without touching the password', async () => {
  const { calls, service } = signInFixture({ retryAfterMs: 1_500 });

  await assert.rejects(
    service.signIn({ credentials: { email: OWNER.email, password: PASSWORD }, ip: '192.168.1.20' }),
    (error) => error.code === 'LOGIN_THROTTLED' && error.statusCode === 429 && error.retryAfterSeconds === 2,
  );
  assert.deepEqual(calls.map(([name]) => name), ['record', 'log', 'alert']);
  assert.equal(calls[0][1].eventType, 'login-throttled');
  assert.equal(calls[0][1].subject, 'fingerprint-of-192.168.1.20');
  assert.deepEqual(calls[1][1], { clientFingerprint: 'fingerprint-of-192.168.1.20', event: 'login-throttled', retryAfterSeconds: 2 });
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(`${PASSWORD}|${OWNER.email}`, 'u'));
});

test('a throttled sign-in is still refused when the event cannot be stored or the alert cannot be sent', async () => {
  const { calls, service } = signInFixture({ alertFails: true, recordFails: true, retryAfterMs: 1 });

  await assert.rejects(service.signIn({ credentials: { email: OWNER.email, password: PASSWORD }, ip: '192.168.1.20' }), { code: 'LOGIN_THROTTLED' });
  await new Promise((resolve) => setImmediate(resolve));

  const logged = calls.filter(([name]) => name === 'log').map(([, event]) => event.event);
  assert.deepEqual(logged, ['security-event-persistence-failed', 'login-throttled', 'sign-in-alert-failed']);
});
