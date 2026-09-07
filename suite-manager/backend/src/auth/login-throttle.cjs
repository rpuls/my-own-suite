const crypto = require('node:crypto');
const net = require('node:net');

const DEFAULT_POLICY = Object.freeze({
  account: { baseDelayMs: 1_000, freeFailures: 10, maxDelayMs: 30_000 },
  entryTtlMs: 60 * 60 * 1_000,
  ip: { baseDelayMs: 1_000, freeFailures: 5, maxDelayMs: 30_000 },
  maxEntries: 10_000,
});

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

// Both keys are digests rather than the values themselves. The account one
// always was; the client address became one when these entries started being
// written to disk, so that surviving a restart does not also mean MOS keeps a
// durable record of who tried to sign in.
function digestKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('base64url');
}

function accountKey(email) {
  return digestKey(String(email || '').trim().toLowerCase());
}

function ipKey(address) {
  return digestKey(normalizeIp(address));
}

class LoginThrottle {
  constructor({ now = () => Date.now(), policy = {}, store = null } = {}) {
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

  retryAfterMs({ email, ip }) {
    const now = this.now();
    this.#prune(now);
    return Math.max(
      this.#retryAfter(this.accounts.get(accountKey(email)), now),
      this.#retryAfter(this.ips.get(ipKey(ip)), now),
    );
  }

  recordFailure({ email, ip }) {
    const now = this.now();
    this.#prune(now);
    this.#record(this.accounts, 'account', accountKey(email), this.policy.account, now);
    this.#record(this.ips, 'ip', ipKey(ip), this.policy.ip, now);
  }

  recordSuccess({ email, ip }) {
    this.#forget(this.accounts, 'account', accountKey(email));
    this.#forget(this.ips, 'ip', ipKey(ip));
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
  LoginThrottle,
  resolveClientAddress,
};
