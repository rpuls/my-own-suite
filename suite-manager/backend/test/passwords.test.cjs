const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  CURRENT_PARAMETERS,
  HashGate,
  PasswordHashingBusyError,
  hashPassword,
  needsRehash,
  verifyPassword,
} = require('../src/auth/passwords.cjs');

// A hash written by the code that shipped before 2026-09: Node's scrypt defaults
// with only N recorded, at the cost this project used to use.
function legacyHash(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384 }).toString('base64url');
  return `scrypt$N=16384$${salt}$${hash}`;
}

test('hashing parameters meet current guidance and are recorded in the encoding', async () => {
  // OWASP lists N=2^16/r=8/p=2 and N=2^17/r=8/p=1 as equivalent work. Asserting
  // the memory-cheaper pair by value is the point: a later edit that quietly
  // lowers the cost has to change this line and say so.
  assert.deepEqual(CURRENT_PARAMETERS, { N: 65536, p: 2, r: 8 });

  const encoded = await hashPassword('correct horse battery staple');
  assert.match(encoded, /^scrypt\$N=65536,r=8,p=2\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u);
});

test('a password verifies against its own hash and nothing else', async () => {
  const encoded = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('correct horse battery stapl', encoded), false);
  assert.equal(await verifyPassword('', encoded), false);
});

test('two hashes of the same password differ, so the salt is real', async () => {
  const first = await hashPassword('correct horse battery staple');
  const second = await hashPassword('correct horse battery staple');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('correct horse battery staple', second), true);
});

test('hashes written under the old parameters still verify and are flagged for rehash', async () => {
  const encoded = legacyHash('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', encoded), true);
  assert.equal(await verifyPassword('wrong', encoded), false);
  assert.equal(needsRehash(encoded), true);
  assert.equal(needsRehash(await hashPassword('correct horse battery')), false);
});

test('malformed encodings are refused rather than throwing or rehashed', async () => {
  const malformed = [
    '',
    'not-a-hash',
    'scrypt$N=16384$only-three-parts',
    'bcrypt$N=16384$salt$hash',
    'scrypt$cost=16384$salt$hash',
    'scrypt$N=abc$salt$hash',
    'scrypt$N=0$salt$hash',
    'scrypt$N=16384$$hash',
    'scrypt$N=16384$salt$',
  ];
  for (const encoded of malformed) {
    assert.equal(await verifyPassword('anything', encoded), false, encoded);
    assert.equal(needsRehash(encoded), false, encoded);
  }
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(needsRehash(undefined), false);
});

test('an empty password is refused at hashing rather than stored', async () => {
  await assert.rejects(() => hashPassword(''), /non-empty string/u);
  await assert.rejects(() => hashPassword(null), /non-empty string/u);
});

test('the gate bounds concurrent hashing and refuses an unbounded backlog', async () => {
  const gate = new HashGate({ maxConcurrent: 2, maxQueued: 3 });
  let active = 0;
  let peak = 0;
  const work = () => gate.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return true;
  });

  const settled = await Promise.allSettled(Array.from({ length: 7 }, work));
  assert.equal(peak, 2);
  assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 5);

  const refused = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(refused.length, 2);
  for (const entry of refused) {
    assert.ok(entry.reason instanceof PasswordHashingBusyError);
    // A refusal MOS chose has to reach the caller as a wait, not as the
    // "Internal server error." the request layer gives an unrecognised throw.
    assert.equal(entry.reason.statusCode, 503);
    assert.equal(entry.reason.retryAfterSeconds, 2);
  }
});

test('the gate drains and stays usable after a refusal and after a failed task', async () => {
  const gate = new HashGate({ maxConcurrent: 1, maxQueued: 1 });
  await Promise.allSettled([
    gate.run(async () => true),
    gate.run(async () => true),
    gate.run(async () => true),
  ]);
  assert.equal(gate.active, 0);
  assert.equal(gate.queue.length, 0);

  await assert.rejects(() => gate.run(async () => { throw new Error('boom'); }), /boom/u);
  assert.equal(gate.active, 0);
  assert.equal(await gate.run(async () => 'recovered'), 'recovered');
});
