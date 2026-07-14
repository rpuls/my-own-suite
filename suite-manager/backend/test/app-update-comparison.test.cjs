const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compareAppPackages } = require('../src/apps/app-update-comparison.cjs');
const { digestAppPackage } = require('../src/apps/package-contracts.cjs');

function appPackage(version, mutate = (manifest) => manifest) {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-compare-'));
  const manifest = mutate({
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
  return { manifest, packageDigest: digestAppPackage(packageDir), packageDir, source: { kind: 'local', path: 'apps/example', repository: 'local', revision: version, trust: 'unverified' } };
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
