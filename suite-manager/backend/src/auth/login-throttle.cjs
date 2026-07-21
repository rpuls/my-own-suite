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

function accountKey(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('base64url');
}

class LoginThrottle {
  constructor({ now = () => Date.now(), policy = {} } = {}) {
    this.now = now;
    this.policy = {
      account: { ...DEFAULT_POLICY.account, ...policy.account },
      entryTtlMs: policy.entryTtlMs ?? DEFAULT_POLICY.entryTtlMs,
      ip: { ...DEFAULT_POLICY.ip, ...policy.ip },
      maxEntries: policy.maxEntries ?? DEFAULT_POLICY.maxEntries,
    };
    this.accounts = new Map();
    this.ips = new Map();
  }

  retryAfterMs({ email, ip }) {
    const now = this.now();
    this.#prune(now);
    return Math.max(
      this.#retryAfter(this.accounts.get(accountKey(email)), now),
      this.#retryAfter(this.ips.get(normalizeIp(ip)), now),
    );
  }

  recordFailure({ email, ip }) {
    const now = this.now();
    this.#prune(now);
    this.#record(this.accounts, accountKey(email), this.policy.account, now);
    this.#record(this.ips, normalizeIp(ip), this.policy.ip, now);
  }

  recordSuccess({ email, ip }) {
    this.accounts.delete(accountKey(email));
    this.ips.delete(normalizeIp(ip));
  }

  #record(map, key, policy, now) {
    const previous = map.get(key);
    const failures = (previous?.failures || 0) + 1;
    const exponent = failures - policy.freeFailures - 1;
    const delayMs = exponent < 0
      ? 0
      : Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
    map.delete(key);
    map.set(key, { blockedUntil: now + delayMs, failures, lastSeen: now });
    this.#bound(map);
  }

  #retryAfter(entry, now) {
    return entry ? Math.max(0, entry.blockedUntil - now) : 0;
  }

  #prune(now) {
    for (const map of [this.accounts, this.ips]) {
      for (const [key, entry] of map) {
        if (now - entry.lastSeen >= this.policy.entryTtlMs) {
          map.delete(key);
        }
      }
    }
  }

  #bound(map) {
    while (map.size > this.policy.maxEntries) {
      map.delete(map.keys().next().value);
    }
  }
}

module.exports = {
  DEFAULT_POLICY,
  LoginThrottle,
  resolveClientAddress,
};
