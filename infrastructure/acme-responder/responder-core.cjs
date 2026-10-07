// The ACME responder's rules, free of I/O. It holds DNS-01 challenge tokens for
// Easy Door wildcard certificates and nothing else; the zone file it renders is
// its only state, so a rebuilt box loses only tokens minutes from expiring.

const { EASY_DOOR_DASHED_ADDRESS } = require('../../shared/easy-door.cjs');

const ZONE = 'acme.myownsuite.org';
const NAMESERVER = 'ns-acme.myownsuite.org';

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;
const TOKENS_PER_NAME = 8;
const LIVE_TOKEN_LIMIT = 20000;
const TXT_TTL_SECONDS = 30;

const UPDATES_PER_SOURCE = 20;
const SOURCE_WINDOW_MS = 60 * 60 * 1000;

const SUBDOMAIN_PATTERN = new RegExp(`^${EASY_DOOR_DASHED_ADDRESS}$`, 'u');
// base64url(SHA-256(key authorization)), unpadded: the only TXT value ACME asks for.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

class ResponderError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseUpdate(body) {
  const subdomain = typeof body?.subdomain === 'string' ? body.subdomain : '';
  const txt = typeof body?.txt === 'string' ? body.txt : '';
  if (!SUBDOMAIN_PATTERN.test(subdomain)) throw new ResponderError(400, 'INVALID_SUBDOMAIN');
  if (!TOKEN_PATTERN.test(txt)) throw new ResponderError(400, 'INVALID_TXT');
  return { subdomain, txt };
}

// Several households share one LAN address and renew independently, so a name
// keeps several live tokens rather than acme-dns's last two.
class TokenBook {
  constructor(entries = []) {
    this.byName = new Map();
    for (const entry of entries) this.insert(entry);
  }

  get size() {
    let total = 0;
    for (const tokens of this.byName.values()) total += tokens.length;
    return total;
  }

  insert({ name, txt, expiresAt }) {
    const tokens = (this.byName.get(name) || []).filter((token) => token.txt !== txt);
    tokens.push({ txt, expiresAt });
    tokens.sort((a, b) => a.expiresAt - b.expiresAt);
    this.byName.set(name, tokens.slice(-TOKENS_PER_NAME));
  }

  add({ name, txt }, now) {
    this.prune(now);
    const known = (this.byName.get(name) || []).some((token) => token.txt === txt);
    if (!known && this.size >= LIVE_TOKEN_LIMIT) throw new ResponderError(503, 'TOKEN_LIMIT');
    this.insert({ name, txt, expiresAt: now + TOKEN_LIFETIME_MS });
  }

  prune(now) {
    let removed = 0;
    for (const [name, tokens] of this.byName) {
      const live = tokens.filter((token) => token.expiresAt > now);
      removed += tokens.length - live.length;
      if (live.length) this.byName.set(name, live);
      else this.byName.delete(name);
    }
    return removed;
  }

  entries() {
    return [...this.byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([name, tokens]) => tokens.map((token) => ({ name, ...token })));
  }
}

class SourceLimiter {
  constructor() {
    this.calls = new Map();
  }

  admit(source, now) {
    const recent = (this.calls.get(source) || []).filter((at) => now - at < SOURCE_WINDOW_MS);
    if (recent.length >= UPDATES_PER_SOURCE) {
      this.calls.set(source, recent);
      return false;
    }
    recent.push(now);
    this.calls.set(source, recent);
    return true;
  }

  forget(now) {
    for (const [source, calls] of this.calls) {
      if (calls.every((at) => now - at >= SOURCE_WINDOW_MS)) this.calls.delete(source);
    }
  }
}

// CoreDNS reloads the file only when the serial grows, and two writes can land
// in the same second.
function nextSerial(previous, now) {
  return Math.max(Number(previous) + 1 || 0, Math.floor(now / 1000));
}

const TOKEN_LINE = /^(\S+) \d+ IN TXT "([A-Za-z0-9_-]{43})" ; expires (\d+)$/u;
const SERIAL_LINE = /^@ \d+ IN SOA \S+ \S+ (\d+) /u;

function renderZone({ apexAddress, book, serial }) {
  const lines = [
    `$ORIGIN ${ZONE}.`,
    `@ 3600 IN SOA ${NAMESERVER}. hostmaster.myownsuite.org. ${serial} 7200 3600 1209600 ${TXT_TTL_SECONDS}`,
    `@ 3600 IN NS ${NAMESERVER}.`,
  ];
  if (apexAddress) lines.push(`@ 300 IN A ${apexAddress}`);
  for (const { name, txt, expiresAt } of book.entries()) {
    lines.push(`${name} ${TXT_TTL_SECONDS} IN TXT "${txt}" ; expires ${expiresAt}`);
  }
  return `${lines.join('\n')}\n`;
}

// Reads back only what renderZone wrote; anything else in the file is ignored.
function parseZone(text) {
  const entries = [];
  let serial = 0;
  for (const line of String(text || '').split('\n')) {
    const serialMatch = SERIAL_LINE.exec(line);
    if (serialMatch) serial = Number(serialMatch[1]);
    const tokenMatch = TOKEN_LINE.exec(line);
    if (tokenMatch && SUBDOMAIN_PATTERN.test(tokenMatch[1])) {
      entries.push({ name: tokenMatch[1], txt: tokenMatch[2], expiresAt: Number(tokenMatch[3]) });
    }
  }
  return { entries, serial };
}

module.exports = {
  ResponderError,
  SourceLimiter,
  TOKENS_PER_NAME,
  TOKEN_LIFETIME_MS,
  TokenBook,
  UPDATES_PER_SOURCE,
  ZONE,
  nextSerial,
  parseUpdate,
  parseZone,
  renderZone,
};
