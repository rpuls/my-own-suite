const assert = require('node:assert/strict');
const test = require('node:test');
const { LoginThrottle, resolveClientAddress } = require('../src/auth/login-throttle.cjs');

function fixture() {
  let now = 10_000;
  const limiter = new LoginThrottle({ now: () => now, policy: {
    account: { baseDelayMs: 1_000, freeFailures: 4, maxDelayMs: 8_000 },
    entryTtlMs: 10_000,
    ip: { baseDelayMs: 1_000, freeFailures: 2, maxDelayMs: 8_000 },
    maxEntries: 3,
  } });
  return { advance: (ms) => { now += ms; }, limiter };
}

test('failures use progressive bounded per-IP backoff', () => {
  const { advance, limiter } = fixture();
  const attempt = { email: 'owner@example.com', ip: '203.0.113.10' };
  limiter.recordFailure(attempt);
  limiter.recordFailure(attempt);
  assert.equal(limiter.retryAfterMs(attempt), 0);
  limiter.recordFailure(attempt);
  assert.equal(limiter.retryAfterMs(attempt), 1_000);
  advance(1_000);
  limiter.recordFailure(attempt);
  assert.equal(limiter.retryAfterMs(attempt), 2_000);
  advance(2_000);
  limiter.recordFailure(attempt);
  advance(4_000);
  limiter.recordFailure(attempt);
  advance(8_000);
  limiter.recordFailure(attempt);
  assert.equal(limiter.retryAfterMs(attempt), 8_000);
});

test('account backoff catches attempts distributed across IPs', () => {
  const { limiter } = fixture();
  for (let index = 0; index < 5; index += 1) limiter.recordFailure({ email: 'owner@example.com', ip: `203.0.113.${index}` });
  assert.equal(limiter.retryAfterMs({ email: 'owner@example.com', ip: '198.51.100.20' }), 1_000);
  assert.equal(limiter.retryAfterMs({ email: 'other@example.com', ip: '198.51.100.20' }), 0);
});

test('success and expiry recover without permanent lockout', () => {
  const { advance, limiter } = fixture();
  const attempt = { email: 'Owner@Example.com', ip: '203.0.113.10' };
  for (let index = 0; index < 3; index += 1) limiter.recordFailure(attempt);
  limiter.recordSuccess({ email: 'owner@example.com', ip: attempt.ip });
  assert.equal(limiter.retryAfterMs(attempt), 0);
  for (let index = 0; index < 3; index += 1) limiter.recordFailure(attempt);
  advance(10_000);
  assert.equal(limiter.retryAfterMs(attempt), 0);
});

test('storage is bounded and forwarded addresses require loopback peer', () => {
  const { limiter } = fixture();
  for (let index = 0; index < 4; index += 1) limiter.recordFailure({ email: `p${index}@example.com`, ip: `203.0.113.${index}` });
  assert.equal(limiter.accounts.size, 3);
  assert.equal(limiter.ips.size, 3);
  assert.equal(resolveClientAddress({ headers: { 'x-forwarded-for': '203.0.113.20' }, socket: { remoteAddress: '127.0.0.1' } }), '203.0.113.20');
  assert.equal(resolveClientAddress({ headers: { 'x-forwarded-for': '203.0.113.20' }, socket: { remoteAddress: '198.51.100.5' } }), '198.51.100.5');
  assert.equal(resolveClientAddress({ headers: { 'x-forwarded-for': 'invalid' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }), '127.0.0.1');
});

const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DATABASE_FILENAME, SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

async function persistentFixture() {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-throttle-'));
  const store = new SuiteManagerStore(stateDir);
  let now = Date.parse('2026-09-07T12:00:00.000Z');
  const policy = {
    account: { baseDelayMs: 1_000, freeFailures: 2, maxDelayMs: 8_000 },
    entryTtlMs: 10_000,
    ip: { baseDelayMs: 1_000, freeFailures: 2, maxDelayMs: 8_000 },
    maxEntries: 3,
  };
  return {
    advance: (ms) => { now += ms; },
    restart: () => new LoginThrottle({ now: () => now, policy, store }),
    stateDir,
    store,
  };
}

test('backoff survives a restart so the budget is not handed back', async () => {
  const { restart, store } = await persistentFixture();
  const attempt = { email: 'owner@example.com', ip: '203.0.113.10' };

  const before = restart();
  for (let index = 0; index < 4; index += 1) before.recordFailure(attempt);
  const carried = before.retryAfterMs(attempt);
  assert.ok(carried > 0);

  // A fresh limiter over the same store is what a restarted Suite Manager gets.
  assert.equal(restart().retryAfterMs(attempt), carried);
  store.close();
});

test('a restart does not revive entries that already aged out', async () => {
  const { advance, restart, store } = await persistentFixture();
  const attempt = { email: 'owner@example.com', ip: '203.0.113.10' };

  const before = restart();
  for (let index = 0; index < 4; index += 1) before.recordFailure(attempt);
  advance(10_000);

  assert.equal(restart().retryAfterMs(attempt), 0);
  assert.deepEqual(store.getLoginThrottleEntries(), []);
  store.close();
});

test('a successful sign-in clears the durable backoff for that account and address', async () => {
  const { restart, store } = await persistentFixture();
  const attempt = { email: 'owner@example.com', ip: '203.0.113.10' };

  const before = restart();
  for (let index = 0; index < 4; index += 1) before.recordFailure(attempt);
  assert.equal(store.getLoginThrottleEntries().length, 2);
  before.recordSuccess(attempt);

  assert.deepEqual(store.getLoginThrottleEntries(), []);
  assert.equal(restart().retryAfterMs(attempt), 0);
  store.close();
});

test('durable entries stay bounded and record no address or account in the clear', async () => {
  const { restart, stateDir, store } = await persistentFixture();
  const limiter = restart();
  for (let index = 0; index < 5; index += 1) {
    limiter.recordFailure({ email: `person${index}@example.com`, ip: `203.0.113.${index}` });
  }

  // maxEntries is per scope, and the durable rows must be evicted with the
  // in-memory ones rather than growing without a ceiling.
  assert.equal(store.getLoginThrottleEntries().length, 6);
  store.close();

  // The whole point of hashing both keys: surviving a restart must not also mean
  // MOS keeps a durable record of which addresses tried to sign in.
  const databaseBytes = fsSync.readFileSync(path.join(stateDir, DATABASE_FILENAME)).toString('latin1');
  for (let index = 0; index < 5; index += 1) {
    assert.equal(databaseBytes.includes(`203.0.113.${index}`), false, `address ${index} leaked`);
    assert.equal(databaseBytes.includes(`person${index}@example.com`), false, `email ${index} leaked`);
  }
});

test('a limiter with no store keeps working, so nothing depends on persistence', () => {
  const limiter = new LoginThrottle({ policy: { ip: { baseDelayMs: 1_000, freeFailures: 0, maxDelayMs: 4_000 } } });
  limiter.recordFailure({ email: 'owner@example.com', ip: '203.0.113.10' });
  assert.ok(limiter.retryAfterMs({ email: 'owner@example.com', ip: '203.0.113.10' }) > 0);
});
