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
