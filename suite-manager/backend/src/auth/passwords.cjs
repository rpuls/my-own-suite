const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

// OWASP's password storage guidance lists several scrypt configurations of
// equivalent strength that trade memory against CPU. MOS takes the 64 MiB one
// rather than the headline N=2^17/r=8/p=1 because the two measure as the same
// work — 272ms against 293ms on the reference machine — while this one asks half
// the peak memory. The documented minimum server is 2 vCPU and 4 GB, so the
// memory is the scarce half, and spending 128 MiB per hash there buys nothing.
const CURRENT_PARAMETERS = Object.freeze({ N: 65536, p: 2, r: 8 });

// Hashes written before 2026-09 used Node's scrypt defaults with only N recorded.
// Nothing else ever produced a hash here, so an encoding that names no r or p is
// exactly that vintage and is read back with the defaults it was written under.
const LEGACY_PARAMETERS = Object.freeze({ p: 1, r: 8 });

// scrypt fills a 128*r*N buffer and OpenSSL asks for a little more on top for the
// p blocks and its own scratch. Deriving the ceiling from the parameters keeps it
// correct the next time they move, instead of pinning a constant that silently
// becomes too small.
function maxmemFor({ N, p, r }) {
  return (128 * r * (N + p + 2)) + 1024;
}

// A hash is now ~270ms of CPU and 64 MiB of memory, which is the point of raising
// the cost and also the reason it cannot be run without a bound: sign-in is
// unauthenticated, so anyone who can reach the port can ask for that work. The
// gate runs two at a time, queues a few behind them, and refuses beyond that
// rather than letting an attacker grow an unbounded backlog and pin every
// threadpool slot the rest of the process needs for disk I/O.
const MAX_CONCURRENT_HASHES = 2;
const MAX_QUEUED_HASHES = 8;

class PasswordHashingBusyError extends Error {
  constructor() {
    super('The server is busy verifying sign-ins. Try again in a moment.');
    this.code = 'PASSWORD_HASHING_BUSY';
    this.name = 'PasswordHashingBusyError';
    // Carried on the error so the request layer answers with a plain 503 and a
    // wait, rather than reporting a refusal it chose as an internal fault.
    this.retryAfterSeconds = 2;
    this.statusCode = 503;
  }
}

class HashGate {
  constructor({ maxConcurrent = MAX_CONCURRENT_HASHES, maxQueued = MAX_QUEUED_HASHES } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.active = 0;
    this.queue = [];
  }

  run(task) {
    if (this.active >= this.maxConcurrent && this.queue.length >= this.maxQueued) {
      return Promise.reject(new PasswordHashingBusyError());
    }
    if (this.active < this.maxConcurrent) {
      return this.#start(task);
    }
    return new Promise((resolve, reject) => {
      this.queue.push(() => this.#start(task).then(resolve, reject));
    });
  }

  #start(task) {
    this.active += 1;
    return Promise.resolve().then(task).finally(() => {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    });
  }
}

const defaultGate = new HashGate();

function encodeParameters({ N, p, r }) {
  return `N=${N},r=${r},p=${p}`;
}

function decodeParameters(field) {
  if (!field.startsWith('N=')) return null;
  const parsed = { ...LEGACY_PARAMETERS };
  for (const pair of field.split(',')) {
    const [key, rawValue] = pair.split('=');
    const value = Number(rawValue);
    if (!['N', 'p', 'r'].includes(key) || !Number.isInteger(value) || value <= 0) return null;
    parsed[key] = value;
  }
  return Number.isInteger(parsed.N) ? parsed : null;
}

function parseEncodedHash(encodedHash) {
  if (typeof encodedHash !== 'string') return null;
  const parts = encodedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return null;
  const parameters = decodeParameters(parts[1]);
  if (!parameters || !parts[2] || !parts[3]) return null;
  return { expectedHash: parts[3], parameters, salt: parts[2] };
}

async function derive(password, salt, parameters) {
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    ...parameters,
    maxmem: maxmemFor(parameters),
  });
  return derived.toString('base64url');
}

async function hashPassword(password, { gate = defaultGate } = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string.');
  }

  const salt = crypto.randomBytes(SALT_BYTES).toString('base64url');
  const hash = await gate.run(() => derive(password, salt, CURRENT_PARAMETERS));
  return `scrypt$${encodeParameters(CURRENT_PARAMETERS)}$${salt}$${hash}`;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyPassword(password, encodedHash, { gate = defaultGate } = {}) {
  if (typeof password !== 'string') return false;

  const parsed = parseEncodedHash(encodedHash);
  if (!parsed) return false;

  const actualHash = await gate.run(() => derive(password, parsed.salt, parsed.parameters));
  return timingSafeEqualString(actualHash, parsed.expectedHash);
}

// True when a hash was written under weaker parameters than the ones in force.
// A successful sign-in is the only moment MOS holds the plaintext for an account
// it did not just create, so it is the only chance to move an old hash forward.
function needsRehash(encodedHash) {
  const parsed = parseEncodedHash(encodedHash);
  if (!parsed) return false;
  return parsed.parameters.N < CURRENT_PARAMETERS.N
    || parsed.parameters.r < CURRENT_PARAMETERS.r
    || parsed.parameters.p < CURRENT_PARAMETERS.p;
}

module.exports = {
  CURRENT_PARAMETERS,
  HashGate,
  MAX_CONCURRENT_HASHES,
  MAX_QUEUED_HASHES,
  PasswordHashingBusyError,
  hashPassword,
  needsRehash,
  verifyPassword,
};
