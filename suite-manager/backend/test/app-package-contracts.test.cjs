const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AppPackageContractError,
  CATALOG_REFRESH_POLICY,
  advisoriesForVersion,
  advisoryAffectsVersion,
  canonicalPackagePath,
  describeRequestedPermissions,
  diffRequestedPermissions,
  derivePrivacyPosture,
  digestAppPackage,
  namespacedPackageId,
  parseNamespacedPackageId,
  validateAdvisory,
  validateAdvisoryIndex,
  validateArchitectureCompatibility,
  validateCatalog,
  validateConstrainedCapabilities,
  validateExternalIdentity,
  validatePlatformCompatibility,
  validatePrivacyAssessment,
  validatePrivacyBinding,
  validateSourceIdentity,
  verifySnapshotIdentity,
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

test('snapshot identity verification resolves bare and namespaced package ids to the manifest id', (t) => {
  const packageDir = packageFixture();
  t.after(() => fs.rmSync(packageDir, { force: true, recursive: true }));
  const expectedDigest = digestAppPackage(packageDir);

  assert.equal(verifySnapshotIdentity(packageDir, { expectedDigest, packageId: 'example' }).id, 'example');
  assert.equal(verifySnapshotIdentity(packageDir, { expectedDigest, packageId: 'x-abcdef01-example' }).id, 'example');
  assert.throws(() => verifySnapshotIdentity(packageDir, { expectedDigest, packageId: 'other' }), /PACKAGE_SNAPSHOT_MISMATCH/u);
  assert.throws(() => verifySnapshotIdentity(packageDir, { expectedDigest, packageId: 'x-abcdef01-other' }), /PACKAGE_SNAPSHOT_MISMATCH/u);
  assert.throws(
    () => verifySnapshotIdentity(packageDir, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: `sha256:${'0'.repeat(64)}`, packageId: 'example' }),
    /INSTALLED_PACKAGE_CHANGED/u,
  );
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

test('a package is refused on a host it says it does not run on', () => {
  assert.deepEqual(validateArchitectureCompatibility({ architectures: ['amd64'] }, 'arm64'), [
    'Package runs on amd64; this host is arm64.',
  ]);
  assert.deepEqual(validateArchitectureCompatibility({ architectures: ['amd64'] }, 'amd64'), []);
  assert.deepEqual(validateArchitectureCompatibility({ architectures: ['amd64', 'arm64'] }, 'arm64'), []);
});

// The check explains a build failure that was already coming. Neither unknown is
// evidence of one, so neither may invent a refusal: an undeclared package is
// every package written before the field existed, and an unidentified host would
// otherwise have every declaring package blocked on it.
test('nothing is refused for an architecture no one has named', () => {
  assert.deepEqual(validateArchitectureCompatibility({ id: 'example' }, 'arm64'), []);
  assert.deepEqual(validateArchitectureCompatibility({ architectures: ['amd64'] }, null), []);
  assert.deepEqual(validateArchitectureCompatibility({ architectures: ['amd64'] }, 'riscv64'), []);
});

// A declaration MOS cannot read is not a declaration it may ignore: ignoring it
// would silently drop the constraint the package meant to state.
test('an unreadable architecture declaration is refused rather than skipped', () => {
  const expected = ['Package architectures must be a non-empty list of amd64, arm64.'];
  assert.deepEqual(validateArchitectureCompatibility({ architectures: [] }, 'amd64'), expected);
  assert.deepEqual(validateArchitectureCompatibility({ architectures: 'amd64' }, 'amd64'), expected);
  assert.deepEqual(validateArchitectureCompatibility({ architectures: ['amd64', 'sparc'] }, 'amd64'), expected);
  // Refused even when the host is unknown: the declaration is broken either way.
  assert.deepEqual(validateArchitectureCompatibility({ architectures: ['sparc'] }, null), expected);
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

test('posture derivation never turns an unknown dimension into a favorable result', () => {
  const local = {
    accountDependency: 'local-only',
    confidence: 'verified',
    dataProcessing: 'local',
    externalServices: 'none-required',
    policyExposure: 'self-hosted-software-only',
    telemetry: 'none-observed',
  };
  assert.equal(derivePrivacyPosture(local), 'private-by-default');
  assert.equal(derivePrivacyPosture({ ...local, telemetry: 'disabled-by-mos' }), 'privacy-configured');
  assert.equal(derivePrivacyPosture({ ...local, externalServices: 'optional' }), 'privacy-configured');
  assert.equal(derivePrivacyPosture({ ...local, externalServices: 'required' }), 'external-dependency');
  assert.equal(derivePrivacyPosture({ ...local, accountDependency: 'required-upstream-account' }), 'external-dependency');
  assert.equal(derivePrivacyPosture({ ...local, dataProcessing: 'required-external' }), 'external-dependency');
  assert.equal(derivePrivacyPosture({ ...local, telemetry: 'unavoidable' }), 'external-dependency');
  // Optional telemetry MOS did not disable supports no favorable posture.
  assert.equal(derivePrivacyPosture({ ...local, telemetry: 'optional' }), 'review-required');
  for (const dimension of Object.keys(local)) {
    assert.equal(derivePrivacyPosture({ ...local, [dimension]: 'unknown' }), 'review-required');
  }
  assert.equal(derivePrivacyPosture({ ...local, policyExposure: 'unclear' }), 'review-required');
  assert.equal(derivePrivacyPosture(undefined), 'review-required');
});

test('assessment validation rejects postures its dimensions do not derive and favorable postures without evidence', () => {
  const dimensions = {
    accountDependency: 'local-only',
    confidence: 'verified',
    dataProcessing: 'local',
    externalServices: 'none-required',
    policyExposure: 'self-hosted-software-only',
    telemetry: 'none-observed',
  };
  const evidence = [{ claim: 'No outbound requests observed at runtime.', source: 'apps/example/Dockerfile', type: 'observed' }];
  assert.deepEqual(validatePrivacyAssessment({ dimensions, evidence, posture: 'private-by-default' }), []);
  assert.ok(validatePrivacyAssessment({ dimensions: { ...dimensions, telemetry: 'unknown' }, evidence, posture: 'private-by-default' })
    .some((error) => error.includes('expected review-required')));
  assert.ok(validatePrivacyAssessment({ dimensions, evidence: [], posture: 'private-by-default' })
    .some((error) => error.includes('at least one evidence entry')));
  assert.ok(validatePrivacyAssessment({ dimensions, evidence: [{ claim: ' ', source: '' }], posture: 'private-by-default' })
    .some((error) => error.includes('at least one evidence entry')));
  assert.deepEqual(validatePrivacyAssessment({ dimensions: {}, evidence: [], posture: 'review-required' }), []);
});

test('privacy-invalidated advisories apply only to their bounded package versions', () => {
  const advisory = contractFixtures.privacyInvalidatedAdvisory;
  assert.deepEqual(validateAdvisory(advisory), []);
  assert.equal(advisoryAffectsVersion(advisory, '1.4.0'), true);
  assert.equal(advisoryAffectsVersion(advisory, '2.0.0'), false);
});

test('advisory validation requires an id, a valid publishedAt, and an HTTPS evidence URL', () => {
  const base = contractFixtures.privacyInvalidatedAdvisory;
  assert.deepEqual(validateAdvisory({ ...base, evidenceUrl: 'https://example.com/e' }), []);
  assert.ok(validateAdvisory({ ...base, id: '' }).some((error) => error.includes('advisory.id')));
  assert.ok(validateAdvisory({ ...base, publishedAt: 'not-a-date' }).some((error) => error.includes('publishedAt')));
  assert.ok(validateAdvisory({ ...base, evidenceUrl: 'http://example.com/e' }).some((error) => error.includes('evidenceUrl')));
});

test('advisory index validation rejects malformed entries and duplicate ids', () => {
  const advisory = contractFixtures.privacyInvalidatedAdvisory;
  assert.deepEqual(validateAdvisoryIndex({ advisories: [advisory], schemaVersion: 1 }), []);
  assert.deepEqual(validateAdvisoryIndex({ advisories: [], schemaVersion: 1 }), []);
  assert.ok(validateAdvisoryIndex({ advisories: advisory, schemaVersion: 1 }).some((error) => error.includes('must be an array')));
  assert.ok(validateAdvisoryIndex({ advisories: [advisory, advisory], schemaVersion: 1 }).some((error) => error.includes('duplicates advisory id')));
  assert.ok(validateAdvisoryIndex({ advisories: [{ ...advisory, severity: 'nope' }], schemaVersion: 1 }).some((error) => error.startsWith('advisories[0]')));
});

test('advisoriesForVersion returns applicable advisories most severe first', () => {
  const index = {
    advisories: [
      { affectedVersions: '*', id: 'A', packageId: 'example-app', publishedAt: '2026-01-01T00:00:00Z', remediation: 'x', schemaVersion: 1, severity: 'low', summary: 's', type: 'policy-change' },
      { affectedVersions: '>=1.0.0 <2.0.0', id: 'B', packageId: 'example-app', publishedAt: '2026-02-01T00:00:00Z', remediation: 'x', schemaVersion: 1, severity: 'critical', summary: 's', type: 'security' },
      { affectedVersions: '*', id: 'C', packageId: 'other-app', publishedAt: '2026-01-01T00:00:00Z', remediation: 'x', schemaVersion: 1, severity: 'high', summary: 's', type: 'security' },
    ],
    schemaVersion: 1,
  };
  const applicable = advisoriesForVersion(index, 'example-app', '1.4.0');
  assert.deepEqual(applicable.map((advisory) => advisory.id), ['B', 'A']);
  assert.deepEqual(advisoriesForVersion(index, 'example-app', '2.5.0').map((advisory) => advisory.id), ['A']);
  assert.deepEqual(advisoriesForVersion(null, 'example-app', '1.4.0'), []);
});

test('the constrained profile permits declared routes and named volumes but rejects host escalation', () => {
  const source = contractFixtures.externalUnverifiedSource;
  assert.deepEqual(validateConstrainedCapabilities(contractFixtures.constrainedManifest, { trust: source.trust }), []);
  assert.deepEqual(validateConstrainedCapabilities(contractFixtures.constrainedManifest, { trust: 'mos-reviewed' }), []);
  const errors = validateConstrainedCapabilities(contractFixtures.escalatingManifest, { trust: 'unverified' });
  assert.ok(errors.some((error) => error.includes('manifest.privileged')));
  assert.ok(errors.some((error) => error.includes('networkMode')));
  assert.ok(errors.some((error) => error.includes('host path or bind mounts')));
  assert.ok(errors.some((error) => error.includes('Docker socket')));
});

test('an mos-reviewed package is exempt from the constrained profile', () => {
  assert.deepEqual(validateConstrainedCapabilities(contractFixtures.escalatingManifest, { trust: 'mos-reviewed' }), []);
});

test('namespaced identity keeps official ids bare and isolates external sources by repository and path', () => {
  assert.equal(namespacedPackageId(contractFixtures.officialSource, 'immich'), 'immich');
  const external = namespacedPackageId(contractFixtures.externalUnverifiedSource, 'immich');
  assert.match(external, /^x-[a-f0-9]{8}-immich$/u);
  const otherPath = { ...contractFixtures.externalUnverifiedSource, path: 'apps/other' };
  assert.notEqual(namespacedPackageId(otherPath, 'immich'), external);
  assert.equal(namespacedPackageId(contractFixtures.externalUnverifiedSource, 'immich'), external);
  assert.deepEqual(parseNamespacedPackageId(external), { namespace: external.slice(2, 10), namespaced: true, packageId: 'immich' });
  assert.deepEqual(parseNamespacedPackageId('immich'), { namespace: null, namespaced: false, packageId: 'immich' });
});

test('external identity blocks official impersonation and self-asserted trust', () => {
  const source = contractFixtures.externalUnverifiedSource;
  const officialPackageIds = ['immich', 'seafile'];
  assert.deepEqual(validateExternalIdentity(contractFixtures.constrainedManifest, source, { officialPackageIds }), []);
  assert.deepEqual(validateExternalIdentity({ id: 'immich' }, source, { officialPackageIds }), ['external package id collides with an official package id.']);
  assert.ok(validateExternalIdentity({ id: 'mos-secrets' }, source, { officialPackageIds }).some((error) => error.includes('reserved official prefix')));
  assert.ok(validateExternalIdentity({ id: 'community-notes', verified: true }, source, { officialPackageIds }).some((error) => error.includes('self-assert verified')));
  assert.deepEqual(validateExternalIdentity({ id: 'immich' }, contractFixtures.officialSource, { officialPackageIds }), []);
});

test('requested permissions summarize routes, volumes, and integrations and expose increases', () => {
  const installed = describeRequestedPermissions(contractFixtures.constrainedManifest);
  assert.deepEqual(installed, ['route:notes', 'volume:notes-data']);
  const candidate = describeRequestedPermissions({
    ...contractFixtures.constrainedManifest,
    integrations: { postgres: {} },
    resources: { services: { notes: { volumes: ['notes-data:/data', 'notes-uploads:/uploads'] } } },
    routes: [{ host: 'notes' }, { host: 'notes-admin' }],
  });
  assert.deepEqual(diffRequestedPermissions(installed, candidate), ['integration:postgres', 'route:notes-admin', 'volume:notes-uploads']);
  assert.deepEqual(diffRequestedPermissions(candidate, installed), []);
});

test('catalog refresh policy keeps a bounded retry cadence and last-known-good cache window', () => {
  assert.equal(CATALOG_REFRESH_POLICY.catalogIntervalMs, 6 * 60 * 60 * 1000);
  assert.equal(CATALOG_REFRESH_POLICY.advisoryIntervalMs, 60 * 60 * 1000);
  assert.ok(CATALOG_REFRESH_POLICY.backoffInitialMs < CATALOG_REFRESH_POLICY.backoffMaximumMs);
  assert.ok(CATALOG_REFRESH_POLICY.cacheStaleAfterMs > CATALOG_REFRESH_POLICY.catalogIntervalMs);
  assert.equal(CATALOG_REFRESH_POLICY.jitterRatio, 0.1);
});
