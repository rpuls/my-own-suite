const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_POLICY = Object.freeze({
  account: { baseDelayMs: 1_000, freeFailures: 10, maxDelayMs: 30_000 },
  entryTtlMs: 60 * 60 * 1_000,
  ip: { baseDelayMs: 1_000, freeFailures: 5, maxDelayMs: 30_000 },
  maxEntries: 10_000,
});

const KEY_FILENAME = 'login-throttle.key';

function normalizeIp(address) {
  const value = String(address || '').trim();
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function isLoopback(address) {
  const normalized = normalizeIp(address);
  return normalized === '127.0.0.1' || normalized === '::1';
}

function resolveClientAddress(request) {
  const peerAddress = normalizeIp(request.socket?.remoteAddress) || 'unknown';
  if (!isLoopback(peerAddress)) {
    return peerAddress;
  }

  // Production Suite Manager listens on loopback behind repo-owned Caddy. Only
  // that trusted local hop may supply the original client address.
  const forwarded = String(request.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return net.isIP(forwarded) ? normalizeIp(forwarded) : peerAddress;
}

// The secret that keys every digest this limiter writes. Kept as a file beside
// the database rather than in it, so the rows alone do not reverse: without the
// key, an entry's subject is an HMAC nobody can enumerate; with an unkeyed hash,
// an IPv4 address was a 2^32 guess away. Losing or deleting the file is safe —
// a new one is made, and the entries keyed by the old one age out within the
// hour like any other.
function loadThrottleKey(stateDir) {
  const target = path.join(stateDir, KEY_FILENAME);
  try {
    const existing = fs.readFileSync(target);
    if (existing.length >= 32) return existing;
  } catch {}
  const key = crypto.randomBytes(32);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(target, key, { mode: 0o600 });
  return key;
}

class LoginThrottle {
  constructor({ key = null, now = () => Date.now(), policy = {}, store = null } = {}) {
    this.key = key;
    this.now = now;
    this.policy = {
      account: { ...DEFAULT_POLICY.account, ...policy.account },
      entryTtlMs: policy.entryTtlMs ?? DEFAULT_POLICY.entryTtlMs,
      ip: { ...DEFAULT_POLICY.ip, ...policy.ip },
      maxEntries: policy.maxEntries ?? DEFAULT_POLICY.maxEntries,
    };
    this.accounts = new Map();
    this.ips = new Map();
    this.store = store;
    this.#hydrate();
  }

  // Both keys are digests rather than the values themselves, keyed by the
  // per-install secret when one is given; without a key this is a plain SHA-256,
  // which keeps addresses out of logs but not out of reach of enumeration.
  digest(value, encoding = 'base64url') {
    const hasher = this.key ? crypto.createHmac('sha256', this.key) : crypto.createHash('sha256');
    return hasher.update(String(value)).digest(encoding);
  }

  // A short opaque handle for a client address in the security-event history:
  // enough to tell "one address, many times" from "many addresses", and nothing
  // that names the address.
  fingerprint(address) {
    return this.digest(normalizeIp(address), 'hex').slice(0, 12);
  }

  // A browser the owner has signed in from before skips the account-wide
  // backoff, which is the one bucket that cannot tell the owner from whoever is
  // guessing their email. The per-address backoff still applies to it, so a
  // stolen cookie buys no more guesses than any other single address gets.
  retryAfterMs({ email, ip, knownBrowser = false }) {
    const now = this.now();
    this.#prune(now);
    return Math.max(
      knownBrowser ? 0 : this.#retryAfter(this.accounts.get(this.#accountKey(email)), now),
      this.#retryAfter(this.ips.get(this.#ipKey(ip)), now),
    );
  }

  recordFailure({ email, ip }) {
    const now = this.now();
    this.#prune(now);
    this.#record(this.accounts, 'account', this.#accountKey(email), this.policy.account, now);
    this.#record(this.ips, 'ip', this.#ipKey(ip), this.policy.ip, now);
  }

  // A known browser never waited on the account bucket, so its success says
  // nothing about who raised it — clearing it would hand whoever is guessing a
  // fresh budget every time the owner signs in.
  recordSuccess({ email, ip, knownBrowser = false }) {
    if (!knownBrowser) this.#forget(this.accounts, 'account', this.#accountKey(email));
    this.#forget(this.ips, 'ip', this.#ipKey(ip));
  }

  #accountKey(email) {
    return this.digest(String(email || '').trim().toLowerCase());
  }

  #ipKey(address) {
    return this.digest(normalizeIp(address));
  }

  // Entries outlive the process but not their own TTL, so anything already
  // expired when it is read back is dropped rather than revived.
  #hydrate() {
    if (!this.store) return;
    const now = this.now();
    for (const entry of this.store.getLoginThrottleEntries()) {
      const map = entry.scope === 'account' ? this.accounts : this.ips;
      const lastSeen = Date.parse(entry.lastSeenAt);
      if (!Number.isFinite(lastSeen) || now - lastSeen >= this.policy.entryTtlMs) continue;
      map.set(entry.subject, {
        blockedUntil: Date.parse(entry.blockedUntilAt),
        failures: entry.failures,
        lastSeen,
      });
    }
    this.#prune(now);
  }

  #persist(scope, key, entry) {
    if (!this.store) return;
    this.store.saveLoginThrottleEntry({
      blockedUntilAt: new Date(entry.blockedUntil).toISOString(),
      failures: entry.failures,
      lastSeenAt: new Date(entry.lastSeen).toISOString(),
      scope,
      subject: key,
    });
  }

  #forget(map, scope, key) {
    map.delete(key);
    if (this.store) this.store.deleteLoginThrottleEntry({ scope, subject: key });
  }

  #record(map, scope, key, policy, now) {
    const previous = map.get(key);
    const failures = (previous?.failures || 0) + 1;
    const exponent = failures - policy.freeFailures - 1;
    const delayMs = exponent < 0
      ? 0
      : Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
    const entry = { blockedUntil: now + delayMs, failures, lastSeen: now };
    map.delete(key);
    map.set(key, entry);
    this.#persist(scope, key, entry);
    this.#bound(map, scope);
  }

  #retryAfter(entry, now) {
    return entry ? Math.max(0, entry.blockedUntil - now) : 0;
  }

  #prune(now) {
    for (const [map, scope] of [[this.accounts, 'account'], [this.ips, 'ip']]) {
      for (const [key, entry] of map) {
        if (now - entry.lastSeen >= this.policy.entryTtlMs) {
          this.#forget(map, scope, key);
        }
      }
    }
    if (this.store) {
      this.store.pruneLoginThrottleEntries({
        lastSeenAtOrBefore: new Date(now - this.policy.entryTtlMs).toISOString(),
      });
    }
  }

  #bound(map, scope) {
    while (map.size > this.policy.maxEntries) {
      this.#forget(map, scope, map.keys().next().value);
    }
  }
}

module.exports = {
  DEFAULT_POLICY,
  KEY_FILENAME,
  LoginThrottle,
  loadThrottleKey,
  resolveClientAddress,
};
