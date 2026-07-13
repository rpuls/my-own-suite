const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AppPackageContractError,
  CATALOG_REFRESH_POLICY,
  advisoryAffectsVersion,
  canonicalPackagePath,
  digestAppPackage,
  validateAdvisory,
  validateCatalog,
  validatePlatformCompatibility,
  validatePrivacyBinding,
  validateSourceIdentity,
} = require('../src/apps/package-contracts.cjs');

const contractFixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'app-package-contracts.json'), 'utf8'));

function packageFixture(lineEnding = '\n') {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-package-contract-'));
  const manifest = {
    category: 'test',
    health: { type: 'http', url: 'http://example:8080/health' },
    id: 'example',
    minimumMosVersion: '0.1.0',
    name: 'Example',
    resources: { services: { example: { dockerfile: 'Dockerfile', internalPort: 8080 } } },
    routes: [{ host: 'example', port: 8080, service: 'example' }],
    setup: { fields: [] },
    summary: 'Example package.',
    version: '1.0.0',
  };
  fs.writeFileSync(path.join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2).replace(/\n/gu, lineEnding)}${lineEnding}`);
  fs.writeFileSync(path.join(packageDir, 'Dockerfile'), `FROM scratch${lineEnding}`);
  return packageDir;
}

test('package digest is stable across LF and CRLF checkouts', (t) => {
  const lf = packageFixture('\n');
  const crlf = packageFixture('\r\n');
  t.after(() => {
    fs.rmSync(lf, { force: true, recursive: true });
    fs.rmSync(crlf, { force: true, recursive: true });
  });
  assert.equal(digestAppPackage(lf), digestAppPackage(crlf));
});

test('package digest binds file paths and contents', (t) => {
  const packageDir = packageFixture();
  t.after(() => fs.rmSync(packageDir, { force: true, recursive: true }));
  const before = digestAppPackage(packageDir);
  fs.appendFileSync(path.join(packageDir, 'Dockerfile'), '# changed\n');
  assert.notEqual(digestAppPackage(packageDir), before);
});

test('package validation rejects undeclared files and symlinks', (t) => {
  const packageDir = packageFixture();
  t.after(() => fs.rmSync(packageDir, { force: true, recursive: true }));
  fs.writeFileSync(path.join(packageDir, 'unexpected.bin'), 'not declared');
  assert.throws(() => digestAppPackage(packageDir), (error) => {
    assert.ok(error instanceof AppPackageContractError);
    assert.match(error.details.join('\n'), /not allowed or declared/u);
    return true;
  });
});

test('canonical package paths reject traversal and platform ambiguity', () => {
  assert.equal(canonicalPackagePath('assets/config.json'), 'assets/config.json');
  assert.equal(canonicalPackagePath('../secret'), null);
  assert.equal(canonicalPackagePath('assets\\config.json'), null);
  assert.equal(canonicalPackagePath('assets/../manifest.json'), null);
});

test('source trust is derived from the configured official source', () => {
  const officialRepository = contractFixtures.officialSource.repository;
  assert.deepEqual(validateSourceIdentity(contractFixtures.officialSource, { officialRepository }), []);
  assert.deepEqual(validateSourceIdentity(contractFixtures.externalUnverifiedSource, { officialRepository }), []);
  assert.deepEqual(validateSourceIdentity(contractFixtures.malformedSource, { officialRepository }), [
    'source.path must be a canonical package-local path.',
    'mos-reviewed trust is derived only from the configured official repository.',
    'external sources cannot claim mos-reviewed trust.',
  ]);
});

test('platform minimum version rejects incompatible candidates', () => {
  assert.deepEqual(validatePlatformCompatibility(contractFixtures.incompatibleManifest, '0.11.0'), [
    'Package requires MOS 99.0.0 or newer; current version is 0.11.0.',
  ]);
  assert.deepEqual(validatePlatformCompatibility({ minimumMosVersion: '0.10.0' }, '0.11.0'), []);
});

test('catalog validation fails closed on malformed identity and privacy metadata', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(validateCatalog({
    packages: {
      'Bad_App': { minimumMosVersion: 'future', packageDigest: 'sha256:nope', packageVersion: 'moving', path: '../escape', privacy: { status: 'certified' } },
      example: { minimumMosVersion: '0.1.0', packageDigest: digest, packageVersion: '1.0.0', path: 'apps/example', privacy: { status: 'review-required' } },
    },
    schemaVersion: 1,
  }), [
    'catalog.packages.Bad_App uses an invalid package id.',
    'catalog.packages.Bad_App.path must match its official package id.',
    'catalog.packages.Bad_App.packageVersion must be semver-like.',
    'catalog.packages.Bad_App.minimumMosVersion must be semver-like.',
    'catalog.packages.Bad_App.packageDigest must be a SHA-256 digest.',
    'catalog.packages.Bad_App.privacy.status is invalid.',
  ]);
});

test('privacy binding rejects review metadata from a different package source', () => {
  const source = contractFixtures.officialSource;
  const manifest = { id: 'example-app', version: '1.0.0' };
  const packageDigest = `sha256:${'b'.repeat(64)}`;
  const review = {
    appId: 'example-app',
    provenance: { model: 'gpt-5' },
    schemaVersion: 1,
    scope: { components: [{ name: 'Example', version: '1.0.0' }], packageDigest, packageVersion: '1.0.0', source: contractFixtures.externalUnverifiedSource },
  };
  assert.ok(validatePrivacyBinding(review, { manifest, packageDigest, source }).some((error) => error.includes('does not match the resolved source')));
});

test('privacy-invalidated advisories apply only to their bounded package versions', () => {
  const advisory = contractFixtures.privacyInvalidatedAdvisory;
  assert.deepEqual(validateAdvisory(advisory), []);
  assert.equal(advisoryAffectsVersion(advisory, '1.4.0'), true);
  assert.equal(advisoryAffectsVersion(advisory, '2.0.0'), false);
});

test('catalog refresh policy keeps a bounded retry cadence and last-known-good cache window', () => {
  assert.equal(CATALOG_REFRESH_POLICY.catalogIntervalMs, 6 * 60 * 60 * 1000);
  assert.equal(CATALOG_REFRESH_POLICY.advisoryIntervalMs, 60 * 60 * 1000);
  assert.ok(CATALOG_REFRESH_POLICY.backoffInitialMs < CATALOG_REFRESH_POLICY.backoffMaximumMs);
  assert.ok(CATALOG_REFRESH_POLICY.cacheStaleAfterMs > CATALOG_REFRESH_POLICY.catalogIntervalMs);
  assert.equal(CATALOG_REFRESH_POLICY.jitterRatio, 0.1);
});
