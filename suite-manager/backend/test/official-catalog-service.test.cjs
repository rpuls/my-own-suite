const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { OfficialCatalogService, githubRepository } = require('../src/apps/official-catalog-service.cjs');
const { digestAppPackage } = require('../src/apps/package-contracts.cjs');
const { generateSigningKeyPair, signCatalogBytes } = require('../src/apps/catalog-signature.cjs');

// A publisher key for the tests, standing in for the one that ships in `trust/`.
const publisher = generateSigningKeyPair();

const revision = 'a'.repeat(40);
const digest = `sha256:${'1'.repeat(64)}`;
const catalog = {
  packages: {
    immich: {
      minimumMosVersion: '0.1.0',
      packageDigest: digest,
      packageVersion: '1.2.0',
      path: 'apps/immich',
      privacy: { status: 'reviewed' },
    },
  },
  schemaVersion: 1,
};

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mos-catalog-')); }
function jsonResponse(value, options = {}) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...options.headers }, status: options.status || 200 }); }

function catalogService(options = {}) {
  return new OfficialCatalogService({ signingPublicKey: publisher.publicKey, ...options });
}

// A fixture is signed over exactly the bytes it serves, so it is trusted here for
// the same reason a real catalog is and for no other reason.
function signedResponse(value, key = publisher.privateKey) {
  return new Response(`${signCatalogBytes(JSON.stringify(value), key)}\n`);
}

// A repository publishing a signed catalog, and optionally a signed advisory
// feed, at one revision.
function serveRepo({ advisories = null, key = publisher.privateKey, value = catalog } = {}) {
  return async (url) => {
    if (url.includes('/commits/')) return jsonResponse({ sha: revision });
    if (url.endsWith('/apps/catalog.json')) return jsonResponse(value);
    if (url.endsWith('/apps/catalog.json.sig')) return signedResponse(value, key);
    if (url.endsWith('/apps/advisories.json')) return advisories ? jsonResponse(advisories) : new Response('Not Found', { status: 404 });
    if (url.endsWith('/apps/advisories.json.sig')) return signedResponse(advisories, key);
    throw new Error(`unexpected ${url}`);
  };
}

// The cache as a verified refresh leaves it: the signed bytes and the signature,
// never the parsed result.
function writeVerifiedCache(stateDir, value = catalog) {
  const catalogText = JSON.stringify(value);
  fs.writeFileSync(path.join(stateDir, 'official-app-catalog.json'), JSON.stringify({
    catalogText,
    fetchedAt: new Date().toISOString(),
    revision,
    schemaVersion: 2,
    signature: signCatalogBytes(catalogText, publisher.privateKey),
  }));
  return stateDir;
}

test('official source accepts only a narrow uncredentialed GitHub repository URL', () => {
  assert.deepEqual(githubRepository('https://github.com/rpuls/my-own-suite'), { owner: 'rpuls', repo: 'my-own-suite' });
  for (const value of ['http://github.com/rpuls/my-own-suite', 'https://token@github.com/rpuls/my-own-suite', 'https://gitlab.com/rpuls/my-own-suite', 'https://github.com/rpuls/my-own-suite/tree/main']) {
    assert.throws(() => githubRepository(value), { code: 'CATALOG_SOURCE_INVALID' });
  }
});

test('refresh resolves the branch once and downloads catalog content from that immutable revision', async () => {
  const calls = [];
  const serve = serveRepo();
  const service = catalogService({
    fetchImpl: async (url, options) => { calls.push({ options, url }); return serve(url); },
    now: () => new Date('2026-07-14T10:00:00.000Z'),
    stateDir: tempDir(),
  });
  const result = await service.refresh();
  assert.equal(calls[0].url, 'https://api.github.com/repos/rpuls/my-own-suite/commits/main');
  assert.equal(calls[1].url, `https://raw.githubusercontent.com/rpuls/my-own-suite/${revision}/apps/catalog.json`);
  // The signature comes from the same immutable revision as what it signs.
  assert.equal(calls[2].url, `https://raw.githubusercontent.com/rpuls/my-own-suite/${revision}/apps/catalog.json.sig`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(result.status.revision, revision);
  assert.equal(result.status.freshness, 'fresh');
});

test('refresh treats a 304 on the conditional catalog request as unchanged, not a redirect', async () => {
  const stateDir = tempDir();
  // Seed the cache a prior successful refresh leaves behind: signed bytes, the
  // matching revision, and the etag that arms the next conditional request.
  const catalogText = JSON.stringify(catalog);
  fs.writeFileSync(path.join(stateDir, 'official-app-catalog.json'), JSON.stringify({
    catalogText,
    etag: '"seed-etag"',
    fetchedAt: new Date('2026-07-14T09:00:00.000Z').toISOString(),
    revision,
    schemaVersion: 2,
    signature: signCatalogBytes(catalogText, publisher.privateKey),
  }));
  let conditional = false;
  const service = catalogService({
    fetchImpl: async (url, options) => {
      if (url.includes('/commits/')) return jsonResponse({ sha: revision });
      if (url.endsWith('/apps/catalog.json')) {
        // Main is unchanged, so the refresh sends If-None-Match and GitHub answers
        // 304 — a Location-less 3xx that must not be read as a redirect.
        assert.equal(options.headers['If-None-Match'], '"seed-etag"');
        conditional = true;
        return new Response(null, { status: 304 });
      }
      if (url.endsWith('/apps/advisories.json')) return new Response('Not Found', { status: 404 });
      throw new Error(`unexpected ${url}`);
    },
    now: () => new Date('2026-07-14T10:00:00.000Z'),
    stateDir,
  });
  const result = await service.refresh();
  assert.equal(conditional, true);
  assert.equal(result.status.error, null);
  assert.equal(result.status.revision, revision);
  assert.equal(result.status.freshness, 'fresh');
});

test('refresh still refuses an actual redirect', async () => {
  const service = catalogService({
    // A 3xx that carries a Location is a real redirect off the pinned URL, and
    // stays refused; only the Location-less 304 above is allowed through.
    fetchImpl: async () => new Response(null, { headers: { location: 'https://evil.example.com/catalog.json' }, status: 302 }),
    now: () => new Date('2026-07-14T10:00:00.000Z'),
    stateDir: tempDir(),
  });
  await assert.rejects(service.refresh(), (error) => {
    assert.equal(error.code, 'CATALOG_REDIRECT_REJECTED');
    return true;
  });
});

test('refresh fetches the advisory feed from the same revision and exposes applicable advisories', async () => {
  const advisories = {
    advisories: [
      { affectedVersions: '>=1.0.0 <2.0.0', id: 'MOS-1', packageId: 'immich', publishedAt: '2026-07-01T00:00:00Z', remediation: 'Update.', schemaVersion: 1, severity: 'high', summary: 'Review invalidated.', type: 'privacy-review-invalidated' },
    ],
    schemaVersion: 1,
  };
  const calls = [];
  const serve = serveRepo({ advisories });
  const service = catalogService({
    fetchImpl: async (url) => { calls.push(url); return serve(url); },
    stateDir: tempDir(),
  });
  await service.refresh();
  assert.ok(calls.some((url) => url === `https://raw.githubusercontent.com/rpuls/my-own-suite/${revision}/apps/advisories.json`));
  assert.equal(service.status().advisories.count, 1);
  assert.deepEqual(service.advisoriesFor('immich', '1.2.0').map((advisory) => advisory.id), ['MOS-1']);
  assert.deepEqual(service.advisoriesFor('immich', '2.0.0'), []);
  assert.deepEqual(service.advisoriesFor('unknown', '1.2.0'), []);
});

test('a missing or malformed advisory feed never fails the catalog refresh', async () => {
  const missing = catalogService({ fetchImpl: serveRepo(), stateDir: tempDir() });
  const result = await missing.refresh();
  assert.equal(result.status.freshness, 'fresh');
  assert.deepEqual(missing.advisoriesFor('immich', '1.2.0'), []);

  // Properly signed and structurally invalid: the signature says the publisher
  // wrote it, which is not the same as it being usable.
  const malformed = catalogService({
    fetchImpl: serveRepo({ advisories: { advisories: [{ id: '' }], schemaVersion: 1 } }),
    stateDir: tempDir(),
  });
  assert.equal((await malformed.refresh()).status.revision, revision);
  assert.deepEqual(malformed.advisoriesFor('immich', '1.2.0'), []);
});

test('failed refresh preserves last-known-good catalog and records a secret-free status error', async () => {
  const stateDir = tempDir();
  const good = catalogService({ fetchImpl: serveRepo(), stateDir });
  await good.refresh();
  const offline = catalogService({ fetchImpl: async () => { throw new Error('network included secret-token'); }, stateDir });
  await assert.rejects(() => offline.refresh(), { code: 'CATALOG_FETCH_FAILED' });
  assert.equal(offline.catalog().packages.immich.packageVersion, '1.2.0');
  assert.equal(offline.status().error.message, 'Official catalog request failed.');
  assert.doesNotMatch(JSON.stringify(offline.status()), /secret-token/u);
});

// A catalog that cannot refresh is a MOS that has stopped learning which of its
// installed packages have advisories against them, and it is quiet: the
// last-known-good cache keeps serving and nothing about the Apps screen looks
// wrong. Counting it durably is the difference between that being discoverable
// and it depending on someone thinking to check a status field.
test('a catalog that cannot refresh is counted without recording where it fetches from', async () => {
  const events = [];
  const service = catalogService({
    fetchImpl: async () => { throw new Error('network included secret-token'); },
    now: () => new Date('2026-07-14T10:00:00.000Z'),
    recordSecurityEvent: (event) => events.push(event),
    repository: 'https://github.com/rpuls/my-own-suite',
    stateDir: tempDir(),
  });

  await assert.rejects(() => service.refresh(), { code: 'CATALOG_FETCH_FAILED' });
  assert.deepEqual(events, [{
    at: '2026-07-14T10:00:00.000Z',
    eventType: 'app-catalog-refresh-failed',
    subject: events[0]?.subject,
  }]);
  assert.match(events[0].subject, /^[a-f0-9]{12}$/u);
  assert.doesNotMatch(JSON.stringify(events), /github\.com|rpuls|secret-token/u);
});

// The count is an observation of the failure, not part of handling it: the
// refresh must still fail the way it always did, with its own error.
test('a failing event recorder cannot change how a failed refresh reports', async () => {
  const service = catalogService({
    fetchImpl: async () => { throw new Error('offline'); },
    recordSecurityEvent: () => { throw new Error('database is gone'); },
    stateDir: tempDir(),
  });

  await assert.rejects(() => service.refresh(), { code: 'CATALOG_FETCH_FAILED' });
  assert.equal(service.status().error.message, 'Official catalog request failed.');
});

// The point of the whole exercise: being able to push to the repository, or to
// convince this box that you are GitHub, is no longer enough to decide which
// packages it treats as reviewed. Only the publisher's key is.
test('a catalog signed by anyone else is refused and never becomes the cache', async () => {
  const impostor = generateSigningKeyPair();
  const events = [];
  const stateDir = tempDir();
  const service = catalogService({
    fetchImpl: serveRepo({ key: impostor.privateKey }),
    now: () => new Date('2026-07-14T10:00:00.000Z'),
    recordSecurityEvent: (event) => events.push(event),
    stateDir,
  });

  await assert.rejects(() => service.refresh(), { code: 'CATALOG_SIGNATURE_INVALID' });
  assert.equal(service.catalog(), null);
  assert.equal(fs.existsSync(path.join(stateDir, 'official-app-catalog.json')), false);
  // Kept apart from a refresh that merely did not happen: one says the network is
  // down, the other says something served this box a catalog nobody trusts.
  assert.deepEqual(events.map((event) => event.eventType), ['app-catalog-signature-invalid']);
});

test('a catalog whose contents no longer match its signature is refused', async () => {
  const service = catalogService({
    fetchImpl: async (url) => {
      if (url.includes('/commits/')) return jsonResponse({ sha: revision });
      // Signed as one thing, served as another: a single flipped version.
      if (url.endsWith('/apps/catalog.json')) return jsonResponse({ ...catalog, packages: { ...catalog.packages, immich: { ...catalog.packages.immich, packageVersion: '9.9.9' } } });
      return signedResponse(catalog);
    },
    stateDir: tempDir(),
  });

  await assert.rejects(() => service.refresh(), { code: 'CATALOG_SIGNATURE_INVALID' });
  assert.equal(service.catalog(), null);
});

// An advisory feed nobody trusts is not one MOS may act on, but a feed is only
// ever a reason to warn, so failing to trust it must not take the catalog down
// with it.
test('an advisory feed signed by anyone else is dropped without failing the refresh', async () => {
  const impostor = generateSigningKeyPair();
  const events = [];
  const advisories = { advisories: [{ affectedVersions: '*', id: 'FAKE-1', packageId: 'immich', publishedAt: '2026-07-01T00:00:00Z', remediation: 'Install this.', schemaVersion: 1, severity: 'critical', summary: 'Update immediately.', type: 'security' }], schemaVersion: 1 };
  const serve = serveRepo({ advisories });
  const service = catalogService({
    fetchImpl: async (url) => (url.endsWith('/apps/advisories.json.sig') ? signedResponse(advisories, impostor.privateKey) : serve(url)),
    recordSecurityEvent: (event) => events.push(event),
    stateDir: tempDir(),
  });

  assert.equal((await service.refresh()).status.revision, revision);
  assert.deepEqual(service.advisoriesFor('immich', '1.2.0'), []);
  assert.deepEqual(events.map((event) => event.eventType), ['app-catalog-signature-invalid']);
});

test('a served advisory feed with a missing signature is visible and counted', async () => {
  const events = [];
  const serve = serveRepo({ advisories: { advisories: [], schemaVersion: 1 } });
  const service = catalogService({
    fetchImpl: async (url) => (url.endsWith('/apps/advisories.json.sig') ? new Response('', { status: 404 }) : serve(url)),
    recordSecurityEvent: (event) => events.push(event),
    stateDir: tempDir(),
  });

  const result = await service.refresh();
  assert.equal(result.status.revision, revision);
  assert.equal(result.status.advisories.error.code, 'ADVISORIES_SIGNATURE_MISSING');
  assert.equal(result.status.advisories.freshness, 'unavailable');
  assert.deepEqual(events.map((event) => event.eventType), ['app-catalog-signature-invalid']);
});

// The cache decides trust for as long as a box stays offline, and it lives in
// state rather than in the release, so it is verified on the way in too.
test('a cache edited on disk is discarded rather than served', async () => {
  const stateDir = writeVerifiedCache(tempDir());
  const cachePath = path.join(stateDir, 'official-app-catalog.json');
  assert.ok(catalogService({ stateDir }).catalog());

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const tampered = JSON.parse(cache.catalogText);
  tampered.packages.immich.packageDigest = `sha256:${'9'.repeat(64)}`;
  fs.writeFileSync(cachePath, JSON.stringify({ ...cache, catalogText: JSON.stringify(tampered) }));

  assert.equal(catalogService({ stateDir }).catalog(), null);
});

// A release with no key cannot tell its publisher's catalog from anyone else's,
// and this catalog decides what counts as reviewed. There is no version of
// carrying on that is not simply trusting whatever arrives.
test('a release missing its publisher key refuses to run a catalog at all', () => {
  assert.throws(() => new OfficialCatalogService({ stateDir: tempDir() }), { code: 'CATALOG_SIGNING_KEY_MISSING' });
  assert.throws(() => new OfficialCatalogService({ signingPublicKey: 'not a key', stateDir: tempDir() }), { code: 'CATALOG_SIGNATURE_INVALID' });
});

test('update classification distinguishes upgrades and same-version digest conflicts', () => {
  const service = catalogService({ stateDir: writeVerifiedCache(tempDir()) });
  assert.equal(service.updateFor('immich', { packageDigest: `sha256:${'2'.repeat(64)}`, packageVersion: '1.1.0' }).status, 'update-available');
  assert.equal(service.updateFor('immich', { packageDigest: `sha256:${'2'.repeat(64)}`, packageVersion: '1.2.0' }).status, 'integrity-error');
  assert.equal(service.updateFor('immich', { packageDigest: digest, packageVersion: '1.2.0' }).status, 'current');
});

test('candidate download is revision-bound and verifies the complete digest before returning package inputs', async (t) => {
  const fixture = tempDir();
  const manifest = { category: 'test', health: { type: 'http', url: 'http://example:8080/health' }, id: 'example', minimumMosVersion: '0.1.0', name: 'Example', resources: { services: { example: { dockerfile: 'Dockerfile', internalPort: 8080 } } }, routes: [{ host: 'example', port: 8080, service: 'example' }], setup: { fields: [] }, summary: 'Example.', version: '1.1.0' };
  fs.writeFileSync(path.join(fixture, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(fixture, 'Dockerfile'), 'FROM scratch\n');
  const candidateDigest = digestAppPackage(fixture);
  const stateDir = writeVerifiedCache(tempDir(), {
    packages: { example: { minimumMosVersion: '0.1.0', packageDigest: candidateDigest, packageVersion: '1.1.0', path: 'apps/example', privacy: { status: 'review-required' } } },
    schemaVersion: 1,
  });
  const raw = Object.fromEntries(['Dockerfile', 'manifest.json'].map((name) => [name, fs.readFileSync(path.join(fixture, name))]));
  const service = catalogService({
    fetchImpl: async (url) => {
      if (url.includes('/contents/apps/example?')) return jsonResponse(Object.entries(raw).map(([name, bytes]) => ({ download_url: `https://raw.githubusercontent.com/rpuls/my-own-suite/${revision}/apps/example/${name}`, path: `apps/example/${name}`, size: bytes.length, type: 'file' })));
      const name = url.split('/').at(-1);
      return new Response(raw[name]);
    },
    platformVersion: '0.11.0',
    stateDir,
  });
  const candidate = await service.downloadCandidate('example');
  t.after(() => { candidate.cleanup(); fs.rmSync(fixture, { force: true, recursive: true }); });
  assert.equal(candidate.packageDigest, candidateDigest);
  assert.equal(candidate.manifest.version, '1.1.0');
  assert.equal(candidate.source.revision, revision);
});
