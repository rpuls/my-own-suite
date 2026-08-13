const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compareAppPackages } = require('../src/apps/app-update-comparison.cjs');
const { digestAppPackage } = require('../src/apps/package-contracts.cjs');

// A package is only as trusted as the source it resolved from, and only a
// MOS-reviewed source has had its shipped privacy review reviewed by MOS. The
// fixture defaults to that source; external packages pass EXTERNAL_SOURCE.
const OFFICIAL_SOURCE = Object.freeze({ kind: 'official-git', path: 'apps/example', repository: 'https://github.com/rpuls/my-own-suite', revision: 'a'.repeat(40), trust: 'mos-reviewed' });
const EXTERNAL_SOURCE = Object.freeze({ kind: 'external-git', path: '.mos', repository: 'https://github.com/someone/example', revision: 'b'.repeat(40), trust: 'unverified' });

function appPackage(version, mutate = (manifest) => manifest, source = OFFICIAL_SOURCE) {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-compare-'));
  const manifest = mutate({
    manifestVersion: 1,
    category: 'test',
    health: { type: 'http', url: 'http://example:8080/health' },
    id: 'example',
    minimumMosVersion: '0.1.0',
    name: 'Example',
    resources: { services: { example: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['data:/data'] } }, },
    routes: [{ host: 'example', port: 8080, service: 'example' }],
    setup: { fields: [{ id: 'account', label: 'Account', required: true, secret: false, type: 'text' }] },
    summary: 'Example package.',
    version,
  });
  fs.writeFileSync(path.join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(packageDir, 'Dockerfile'), 'FROM scratch\n');
  return { manifest, packageDigest: digestAppPackage(packageDir), packageDir, source };
}

function writePrivacyReview(appPkg, posture, dimensions) {
  fs.writeFileSync(path.join(appPkg.packageDir, 'privacy-review.json'), `${JSON.stringify({
    appId: appPkg.manifest.id,
    dimensions,
    evidence: [],
    openQuestions: [],
    policies: [],
    posture,
    provenance: { humanReviewed: true, method: 'human', model: 'manual-review', modelIdentifierSource: 'user-supplied', repositoryCommit: 'test', skill: 'assess-app-privacy', skillRevision: '1' },
    reviewedAt: '2026-07-01T00:00:00.000Z',
    schemaVersion: 1,
    scope: {
      components: [{ artifact: 'docker.io/example/example:1.0.0', name: 'example', version: '1.0.0' }],
      packageDigest: appPkg.packageDigest,
      packageVersion: appPkg.manifest.version,
      source: appPkg.source,
    },
  }, null, 2)}\n`);
}

// An update is free to drop an architecture, and the host is not something the
// owner can change in response. The preview has to say so, because the only
// other place it surfaces is a build that cannot pull its images.
test('an update that drops this host architecture is unsupported before it is staged', (t) => {
  const installed = appPackage('1.0.0');
  const candidate = appPackage('2.0.0', (manifest) => ({ ...manifest, architectures: ['amd64'] }));
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const input = { agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' };
  const refused = compareAppPackages({ ...input, hostArchitecture: 'arm64' });
  assert.equal(refused.compatibility, 'unsupported');
  assert.deepEqual(refused.validation.errors, ['Package runs on amd64; this host is arm64.']);
  assert.equal(compareAppPackages({ ...input, hostArchitecture: 'amd64' }).compatibility, 'compatible');
  // An agent too old to report a host leaves the update exactly as it was before
  // this check existed, rather than blocking every declaring package.
  assert.equal(compareAppPackages(input).compatibility, 'compatible');
});

test('comparison is deterministic and refuses undeclared required-field and volume breaks', (t) => {
  const installed = appPackage('1.0.0');
  const candidate = appPackage('2.0.0', (manifest) => {
    manifest.setup.fields = [{ id: 'token', label: 'API token', required: true, secret: true, type: 'password' }];
    manifest.resources.services.example.volumes = [];
    return manifest;
  });
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const input = { agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' };
  const first = compareAppPackages(input);
  const second = compareAppPackages(input);
  assert.deepEqual(first, second);
  assert.equal(first.compatibility, 'unsupported');
  assert.deepEqual(first.requiredInput, [{ id: 'token', label: 'API token', secret: true, type: 'password' }]);
  assert.match(first.validation.errors.join(' '), /setup.*volumes/u);
});

test('declared breaking changes remain owner-visible and require confirmation rather than silently passing', (t) => {
  const installed = appPackage('1.0.0');
  const candidate = appPackage('2.0.0', (manifest) => {
    manifest.resources.services.example.volumes = [];
    manifest.update = { backupRequired: true, breakingChanges: ['volumes'], downtime: 'extended', migrations: ['Export existing data.'], ownerActions: ['Confirm the data migration.'], rollback: 'unsupported' };
    return manifest;
  });
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const comparison = compareAppPackages({ agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' });
  assert.equal(comparison.compatibility, 'owner-action-required');
  assert.equal(comparison.metadata.backupRequired, true);
  assert.equal(comparison.metadata.rollback, 'unsupported');
});

test('privacy assessments carry their dimensions into both sides of the comparison', (t) => {
  const installed = appPackage('1.0.0');
  const candidate = appPackage('1.1.0');
  writePrivacyReview(installed, 'private-by-default', { accountDependency: 'local-only', confidence: 'verified', dataProcessing: 'local', externalServices: 'none-required', policyExposure: 'self-hosted-software-only', telemetry: 'none-observed' });
  writePrivacyReview(candidate, 'external-dependency', { accountDependency: 'local-only', confidence: 'verified', dataProcessing: 'optional-external', externalServices: 'required', policyExposure: 'upstream-services-involved', telemetry: 'optional' });
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const comparison = compareAppPackages({ agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' });
  assert.equal(comparison.installed.privacy.status, 'reviewed');
  assert.equal(comparison.installed.privacy.posture, 'private-by-default');
  assert.equal(comparison.installed.privacy.dimensions.telemetry, 'none-observed');
  assert.equal(comparison.candidate.privacy.status, 'reviewed');
  assert.equal(comparison.candidate.privacy.dimensions.externalServices, 'required');
  const change = comparison.changes.find((item) => item.area === 'privacy');
  assert.match(change.summary, /from private-by-default to external-dependency/u);
});

test('an unverified package cannot present its own privacy review as a MOS review', (t) => {
  const dimensions = { accountDependency: 'local-only', confidence: 'verified', dataProcessing: 'local', externalServices: 'none-required', policyExposure: 'self-hosted-software-only', telemetry: 'none-observed' };
  const installed = appPackage('1.0.0', (manifest) => manifest, EXTERNAL_SOURCE);
  const candidate = appPackage('1.1.0', (manifest) => manifest, EXTERNAL_SOURCE);
  // Both sides ship a review that binds correctly to their own contents and
  // source. The binding is honest; what it is not is a MOS review.
  writePrivacyReview(installed, 'private-by-default', dimensions);
  writePrivacyReview(candidate, 'private-by-default', dimensions);
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const comparison = compareAppPackages({ agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' });
  for (const side of [comparison.installed.privacy, comparison.candidate.privacy]) {
    assert.equal(side.status, 'review-required');
    assert.equal(side.posture, null);
    assert.equal(side.dimensions, null);
  }
  assert.equal(comparison.changes.find((item) => item.area === 'privacy'), undefined);
});

test('an unverified update that widens the access it asks for needs explicit consent', (t) => {
  const installed = appPackage('1.0.0', (manifest) => manifest, EXTERNAL_SOURCE);
  const candidate = appPackage('1.1.0', (manifest) => {
    manifest.routes.push({ host: 'example-admin', port: 8081, service: 'example' });
    manifest.resources.services.example.volumes = ['data:/data', 'extra:/extra'];
    return manifest;
  }, EXTERNAL_SOURCE);
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const comparison = compareAppPackages({ agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' });
  assert.equal(comparison.updateStatus, 'update-available');
  assert.deepEqual(comparison.permissions.installed, ['route:ext-example', 'volume:data']);
  assert.deepEqual(comparison.permissions.added, ['route:ext-example-admin', 'volume:extra']);
  assert.deepEqual(comparison.permissions.removed, []);
  assert.equal(comparison.compatibility, 'owner-action-required');
  const change = comparison.changes.find((item) => item.area === 'permissions');
  assert.equal(change.classification, 'operator-action-required');
  assert.match(change.summary, /route:ext-example-admin/u);
});

test('the same access increase from the reviewed catalog is reported without demanding consent', (t) => {
  const installed = appPackage('1.0.0');
  const candidate = appPackage('1.1.0', (manifest) => {
    manifest.routes.push({ host: 'example-admin', port: 8081, service: 'example' });
    return manifest;
  });
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const comparison = compareAppPackages({ agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' });
  assert.deepEqual(comparison.permissions.added, ['route:example-admin']);
  assert.equal(comparison.changes.find((item) => item.area === 'permissions').classification, 'automatically-handled');
  assert.equal(comparison.compatibility, 'compatible');
});

// Differing contents under the installed version number is not an update and is
// never applied as one, but it is also not a fault to report: the installed
// package came from this box's checkout rather than from the catalog, so the two
// digests were never contracted to match. Downloaded candidate bytes are still
// verified against the signed catalog digest before anything is applied.
test('a candidate that reuses the installed version number is current, and is not offered as an update', (t) => {
  const installed = appPackage('1.0.0');
  const candidate = appPackage('1.0.0', (manifest) => {
    manifest.summary = 'Same version number, different package.';
    return manifest;
  });
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const comparison = compareAppPackages({ agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' });
  assert.notEqual(installed.packageDigest, candidate.packageDigest);
  assert.equal(comparison.updateStatus, 'current');
  assert.equal(comparison.compatibility, 'compatible');
  assert.deepEqual(comparison.validation.errors, []);
});

test('an unchanged candidate reports as current rather than as an update', (t) => {
  const installed = appPackage('1.0.0');
  const candidate = appPackage('1.0.0');
  t.after(() => [installed, candidate].forEach((item) => fs.rmSync(item.packageDir, { force: true, recursive: true })));
  const comparison = compareAppPackages({ agentCapabilities: ['apps.package.snapshot'], agentContractVersion: 1, candidate, installed, platformVersion: '0.11.0' });
  assert.equal(comparison.updateStatus, 'current');
  assert.deepEqual(comparison.permissions.added, []);
  assert.equal(comparison.compatibility, 'compatible');
});
