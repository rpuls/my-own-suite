const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SourceLimiter,
  TOKENS_PER_NAME,
  TOKEN_LIFETIME_MS,
  TokenBook,
  UPDATES_PER_SOURCE,
  nextSerial,
  parseUpdate,
  parseZone,
  renderZone,
} = require('../../infrastructure/acme-responder/responder-core.cjs');
const { ZoneStore, createServer, sourceOf } = require('../../infrastructure/acme-responder/responder.cjs');

const token = (seed) => String(seed).padEnd(43, 'x').slice(0, 43);

test('the responder holds tokens only for the private addresses the Easy Door names', () => {
  for (const subdomain of ['192-168-68-123', '10-0-0-5', '172-16-0-1', '172-31-255-254']) {
    assert.deepEqual(parseUpdate({ subdomain, txt: token('a') }), { subdomain, txt: token('a') });
  }
  for (const subdomain of ['203-0-113-9', '172-32-0-1', '192-168-1-256', 'home.192-168-1-5', '192-168-1-5.example.com', '', 'x']) {
    assert.throws(() => parseUpdate({ subdomain, txt: token('a') }), { code: 'INVALID_SUBDOMAIN', statusCode: 400 });
  }
});

test('only an ACME-shaped TXT value is accepted', () => {
  for (const txt of ['', 'short', `${token('a')}x`, `${token('a').slice(0, 42)}=`, `${token('a').slice(0, 42)} `]) {
    assert.throws(() => parseUpdate({ subdomain: '192-168-1-5', txt }), { code: 'INVALID_TXT' });
  }
});

test('households on one address keep their own tokens, capped with the oldest evicted', () => {
  const book = new TokenBook();
  for (let index = 0; index < TOKENS_PER_NAME + 2; index += 1) {
    book.add({ name: '192-168-1-100', txt: token(index) }, 1000 + index);
  }
  const live = book.entries().map((entry) => entry.txt);
  assert.equal(live.length, TOKENS_PER_NAME);
  assert.equal(live.includes(token(0)), false);
  assert.equal(live.includes(token(TOKENS_PER_NAME + 1)), true);
});

test('tokens expire ten minutes after they were posted', () => {
  const book = new TokenBook();
  book.add({ name: '192-168-1-5', txt: token('a') }, 0);
  assert.equal(book.prune(TOKEN_LIFETIME_MS - 1), 0);
  assert.equal(book.prune(TOKEN_LIFETIME_MS), 1);
  assert.equal(book.entries().length, 0);
});

test('the zone file is the state: what it renders it reads back', () => {
  const book = new TokenBook();
  book.add({ name: '192-168-1-5', txt: token('a') }, 0);
  book.add({ name: '10-0-0-5', txt: token('b') }, 0);
  const zone = renderZone({ apexAddress: '198.51.100.7', book, serial: 42 });

  assert.match(zone, /^@ 300 IN A 198\.51\.100\.7$/mu);
  assert.match(zone, /^192-168-1-5 30 IN TXT "/mu);
  const parsed = parseZone(zone);
  assert.equal(parsed.serial, 42);
  assert.deepEqual(new TokenBook(parsed.entries).entries(), book.entries());
});

test('the serial always grows, even for two writes in one second', () => {
  assert.equal(nextSerial(0, 1_800_000_000_500), 1_800_000_000);
  assert.equal(nextSerial(1_800_000_000, 1_800_000_000_900), 1_800_000_001);
});

test('a source is limited to a handful of updates an hour', () => {
  const limiter = new SourceLimiter();
  for (let index = 0; index < UPDATES_PER_SOURCE; index += 1) assert.equal(limiter.admit('198.51.100.1', index), true);
  assert.equal(limiter.admit('198.51.100.1', UPDATES_PER_SOURCE), false);
  assert.equal(limiter.admit('198.51.100.2', UPDATES_PER_SOURCE), true);
  assert.equal(limiter.admit('198.51.100.1', 60 * 60 * 1000 + 1), true);
});

test('the forwarded address is trusted only from the local proxy', () => {
  const request = (remoteAddress, forwarded) => ({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress } });
  assert.equal(sourceOf(request('127.0.0.1', '198.51.100.1')), '198.51.100.1');
  assert.equal(sourceOf(request('203.0.113.9', '198.51.100.1')), '203.0.113.9');
});

async function withServer(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-acme-'));
  const store = new ZoneStore(path.join(directory, 'zone'));
  const server = createServer({ store, limiter: new SourceLimiter(), counts: { accepted: 0, rejected: {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, zoneFile: store.filePath });
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('an update in the acme-dns wire shape lands in the zone file', async () => {
  await withServer(async ({ base, zoneFile }) => {
    const response = await fetch(`${base}/update`, {
      method: 'POST',
      headers: { 'X-Api-User': 'mos', 'X-Api-Key': 'mos', 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain: '192-168-68-123', txt: token('live') }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { txt: token('live') });
    assert.match(fs.readFileSync(zoneFile, 'utf8'), new RegExp(`^192-168-68-123 30 IN TXT "${token('live')}"`, 'mu'));
  });
});

test('registration does not exist and a bad update is refused', async () => {
  await withServer(async ({ base, zoneFile }) => {
    assert.equal((await fetch(`${base}/register`, { method: 'POST' })).status, 404);
    const response = await fetch(`${base}/update`, { method: 'POST', body: JSON.stringify({ subdomain: '8-8-8-8', txt: token('a') }) });
    assert.equal(response.status, 400);
    assert.equal(fs.existsSync(zoneFile), false);
  });
});
