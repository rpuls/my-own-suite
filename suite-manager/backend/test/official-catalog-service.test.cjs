const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { OfficialCatalogService, githubRepository } = require('../src/apps/official-catalog-service.cjs');

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

test('official source accepts only a narrow uncredentialed GitHub repository URL', () => {
  assert.deepEqual(githubRepository('https://github.com/rpuls/my-own-suite'), { owner: 'rpuls', repo: 'my-own-suite' });
  for (const value of ['http://github.com/rpuls/my-own-suite', 'https://token@github.com/rpuls/my-own-suite', 'https://gitlab.com/rpuls/my-own-suite', 'https://github.com/rpuls/my-own-suite/tree/main']) {
    assert.throws(() => githubRepository(value), { code: 'CATALOG_SOURCE_INVALID' });
  }
});

test('refresh resolves the branch once and downloads catalog content from that immutable revision', async () => {
  const calls = [];
  const service = new OfficialCatalogService({
    fetchImpl: async (url, options) => {
      calls.push({ options, url });
      return calls.length === 1 ? jsonResponse({ sha: revision }) : jsonResponse(catalog, { headers: { etag: 'catalog-one' } });
    },
    now: () => new Date('2026-07-14T10:00:00.000Z'),
    stateDir: tempDir(),
  });
  const result = await service.refresh();
  assert.equal(calls[0].url, 'https://api.github.com/repos/rpuls/my-own-suite/commits/main');
  assert.equal(calls[1].url, `https://raw.githubusercontent.com/rpuls/my-own-suite/${revision}/apps/catalog.json`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(result.status.revision, revision);
  assert.equal(result.status.freshness, 'fresh');
});

test('failed refresh preserves last-known-good catalog and records a secret-free status error', async () => {
  const stateDir = tempDir();
  const good = new OfficialCatalogService({ fetchImpl: async (url) => url.includes('/commits/') ? jsonResponse({ sha: revision }) : jsonResponse(catalog), stateDir });
  await good.refresh();
  const offline = new OfficialCatalogService({ fetchImpl: async () => { throw new Error('network included secret-token'); }, stateDir });
  await assert.rejects(() => offline.refresh(), { code: 'CATALOG_FETCH_FAILED' });
  assert.equal(offline.catalog().packages.immich.packageVersion, '1.2.0');
  assert.equal(offline.status().error.message, 'Official catalog request failed.');
  assert.doesNotMatch(JSON.stringify(offline.status()), /secret-token/u);
});

test('update classification distinguishes upgrades and same-version digest conflicts', () => {
  const stateDir = tempDir();
  fs.writeFileSync(path.join(stateDir, 'official-app-catalog.json'), JSON.stringify({ catalog, fetchedAt: new Date().toISOString(), revision, schemaVersion: 1 }));
  const service = new OfficialCatalogService({ stateDir });
  assert.equal(service.updateFor('immich', { packageDigest: `sha256:${'2'.repeat(64)}`, packageVersion: '1.1.0' }).status, 'update-available');
  assert.equal(service.updateFor('immich', { packageDigest: `sha256:${'2'.repeat(64)}`, packageVersion: '1.2.0' }).status, 'integrity-error');
  assert.equal(service.updateFor('immich', { packageDigest: digest, packageVersion: '1.2.0' }).status, 'current');
});
