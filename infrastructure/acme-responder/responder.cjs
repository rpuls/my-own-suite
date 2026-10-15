#!/usr/bin/env node

// The ACME responder: answers Caddy's acme-dns `/update` call and writes the
// token into the zone file CoreDNS serves. It logs no source, name or token,
// only failures and hourly counts.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  ResponderError,
  SourceLimiter,
  TokenBook,
  nextSerial,
  parseUpdate,
  parseZone,
  renderZone,
} = require('./responder-core.cjs');

const MAX_BODY_BYTES = 1024;
const PRUNE_INTERVAL_MS = 30 * 1000;
const COUNT_INTERVAL_MS = 60 * 60 * 1000;
const METADATA_RETRY_MS = 5000;

function log(message) {
  process.stdout.write(`[mos-acme-responder] ${message}\n`);
}

function writeFileAtomic(filePath, text) {
  const temporary = `${filePath}.tmp`;
  const handle = fs.openSync(temporary, 'w', 0o644);
  try {
    fs.writeSync(handle, text);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, filePath);
}

class ZoneStore {
  constructor(filePath) {
    this.filePath = filePath;
    const previous = fs.existsSync(filePath) ? parseZone(fs.readFileSync(filePath, 'utf8')) : { entries: [], serial: 0 };
    this.book = new TokenBook(previous.entries);
    this.serial = previous.serial;
    this.apexAddress = null;
  }

  write(now = Date.now()) {
    this.serial = nextSerial(this.serial, now);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileAtomic(this.filePath, renderZone({ apexAddress: this.apexAddress, book: this.book, serial: this.serial }));
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new ResponderError(413, 'BODY_TOO_LARGE'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { reject(new ResponderError(400, 'INVALID_JSON')); }
    });
    request.on('error', reject);
  });
}

// Caddy in front replaces X-Forwarded-For with the client it saw; anything not
// arriving through it is identified by the socket alone.
function sourceOf(request) {
  const peer = request.socket.remoteAddress || '';
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').pop().trim();
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  return loopback && forwarded ? forwarded : peer;
}

function createServer({ store, limiter, counts, now = () => Date.now() }) {
  return http.createServer(async (request, response) => {
    const respond = (statusCode, payload) => {
      response.writeHead(statusCode, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    try {
      if (request.method === 'GET' && request.url === '/health') {
        respond(200, { ok: true });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/update') throw new ResponderError(404, 'NOT_FOUND');
      if (!limiter.admit(sourceOf(request), now())) throw new ResponderError(429, 'RATE_LIMITED');
      const update = parseUpdate(await readBody(request));
      store.book.add({ name: update.subdomain, txt: update.txt }, now());
      store.write(now());
      counts.accepted += 1;
      respond(200, { txt: update.txt });
    } catch (error) {
      const known = error instanceof ResponderError;
      if (!known) log(`update failed: ${error.message}`);
      counts.rejected[known ? error.code : 'INTERNAL'] = (counts.rejected[known ? error.code : 'INTERNAL'] || 0) + 1;
      respond(known ? error.statusCode : 500, { error: known ? error.code : 'INTERNAL' });
    }
  });
}

// The apex A record is the box's own Reserved IP, so the API name needs no
// record in the parent zone. DigitalOcean assigns it moments after creation.
async function resolveApexAddress(metadataUrl) {
  for (;;) {
    try {
      const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(3000) });
      const address = (await response.text()).trim();
      if (response.ok && /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) return address;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, METADATA_RETRY_MS));
  }
}

function formatCounts(counts) {
  const rejected = Object.entries(counts.rejected).map(([code, count]) => `${code}=${count}`).join(' ');
  return `accepted=${counts.accepted}${rejected ? ` ${rejected}` : ''}`;
}

async function main() {
  const [host, port] = (process.env.MOS_ACME_LISTEN || '127.0.0.1:8053').split(':');
  const store = new ZoneStore(process.env.MOS_ACME_ZONE_FILE || '/var/lib/mos-acme/acme.myownsuite.org.zone');
  const limiter = new SourceLimiter();
  const counts = { accepted: 0, rejected: {} };

  store.book.prune(Date.now());
  store.write();

  setInterval(() => {
    const at = Date.now();
    limiter.forget(at);
    if (store.book.prune(at)) store.write(at);
  }, PRUNE_INTERVAL_MS).unref();

  setInterval(() => {
    if (counts.accepted || Object.keys(counts.rejected).length) log(`last hour: ${formatCounts(counts)}`);
    counts.accepted = 0;
    counts.rejected = {};
  }, COUNT_INTERVAL_MS).unref();

  createServer({ store, limiter, counts }).listen(Number(port), host, () => log(`listening on ${host}:${port}`));

  store.apexAddress = process.env.MOS_ACME_APEX_ADDRESS
    || await resolveApexAddress(process.env.MOS_ACME_METADATA_URL || 'http://169.254.169.254/metadata/v1/reserved_ip/ipv4/ip_address');
  store.write();
  log(`apex address ${store.apexAddress}`);
}

if (require.main === module) {
  main().catch((error) => {
    log(`fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { ZoneStore, createServer, sourceOf };
