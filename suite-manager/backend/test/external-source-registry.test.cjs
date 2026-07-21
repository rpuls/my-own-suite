const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ExternalSourceError,
  INSTALL_BLOCKING_STATUSES,
  buildSourceRecord,
  instanceNamespaceId,
  removalPlan,
  sourceInstallable,
  validateExternalCandidate,
  validateSourceUrl,
  withRevision,
  withStatus,
} = require('../src/apps/external-source-registry.cjs');

const now = () => new Date('2026-07-15T10:00:00.000Z');
const revision = '89abcdef0123456789abcdef0123456789abcdef';

function externalInput(overrides = {}) {
  return { catalogPath: 'apps', publisher: 'community', repository: 'https://code.example/community/apps', trust: 'unverified', ...overrides };
}

test('external source URLs must be uncredentialed HTTPS with local sources gated to development', () => {
  assert.deepEqual(validateSourceUrl('https://code.example/community/apps'), []);
  assert.ok(validateSourceUrl('http://code.example/apps').some((error) => error.includes('HTTPS')));
  assert.ok(validateSourceUrl('https://user:pw@code.example/apps').some((error) => error.includes('credentials')));
  assert.deepEqual(validateSourceUrl('http://localhost:8080/apps'), ['local and file sources are development-only.']);
  assert.deepEqual(validateSourceUrl('http://localhost:8080/apps', { allowLocalSources: true }), []);
});

test('a source record stores URL, publisher, trust, and revision separately and defaults to active', () => {
  const record = buildSourceRecord(externalInput(), { now });
  assert.equal(record.id, buildSourceRecord(externalInput(), { now }).id);
  assert.match(record.id, /^src-[a-f0-9]{12}$/u);
  assert.equal(record.revision, null);
  assert.equal(record.status, 'active');
  assert.equal(record.trust, 'unverified');
  assert.equal(record.publisher, 'community');
  assert.equal(sourceInstallable(record), true);
  const resolved = withRevision(record, revision);
  assert.equal(resolved.revision, revision);
  assert.throws(() => withRevision(record, 'main'), (error) => error instanceof ExternalSourceError && error.code === 'SOURCE_REVISION_INVALID');
});

test('source records reject non-HTTPS URLs, mos-reviewed trust, and unverifiable publisher-signed claims', () => {
  assert.throws(() => buildSourceRecord(externalInput({ repository: 'http://code.example/apps' }), { now }), { code: 'SOURCE_URL_INVALID' });
  assert.throws(() => buildSourceRecord(externalInput({ trust: 'mos-reviewed' }), { now }), { code: 'SOURCE_TRUST_INVALID' });
  assert.throws(() => buildSourceRecord(externalInput({ kind: 'local' }), { now }), { code: 'SOURCE_KIND_INVALID' });
});

// There is no publisher key to check a signature against, so any string bought
// the "signed by the publisher" label an owner reads before deciding to install.
// A label nothing stands behind is worse than the unverified one it replaced, so
// the claim is refused until there is something to check it with. The signature
// is still kept: it is what a publisher-key check would compare against, and
// storing it buys no trust while nothing has verified it.
test('an external source cannot buy a publisher-signed label with a signature nobody can check', () => {
  assert.throws(() => buildSourceRecord(externalInput({ trust: 'publisher-signed' }), { now }), { code: 'SOURCE_TRUST_INVALID' });
  assert.throws(() => buildSourceRecord(externalInput({ signature: 'sig', trust: 'publisher-signed' }), { now }), { code: 'SOURCE_TRUST_INVALID' });
  const record = buildSourceRecord(externalInput({ signature: 'sig' }), { now });
  assert.equal(record.trust, 'unverified');
  assert.equal(record.signature, 'sig');
});

test('source status transitions gate new installs and keep compromise and removal terminal', () => {
  const record = buildSourceRecord(externalInput(), { now });
  for (const status of INSTALL_BLOCKING_STATUSES) {
    assert.equal(sourceInstallable({ ...record, status }), false);
  }
  const unavailable = withStatus(record, 'unavailable', 'Source unreachable.');
  assert.equal(sourceInstallable(unavailable), false);
  assert.equal(sourceInstallable(withStatus(unavailable, 'active')), true);
  const compromised = withStatus(record, 'compromised', 'Key compromise reported.');
  assert.throws(() => withStatus(compromised, 'active'), { code: 'SOURCE_STATUS_TRANSITION_INVALID' });
  assert.throws(() => withStatus(withStatus(record, 'removed'), 'active'), { code: 'SOURCE_STATUS_TRANSITION_INVALID' });
});

test('removing a source orphans matching installs without uninstalling them', () => {
  const record = buildSourceRecord(externalInput(), { now });
  // Production-shaped rows: an external instance records the source's catalog
  // path itself as its sourcePath (see external-source-client), never a
  // per-package subpath. The bug this pins down was a prefix filter that only
  // matched a path shape production never writes.
  const instances = [
    { id: 'x-abc-notes', sourceKind: 'external-git', sourcePath: record.catalogPath, sourceRepository: record.repository },
    { id: 'x-def-todo', sourceKind: 'external-git', sourcePath: record.catalogPath, sourceRepository: 'https://other.example/apps' },
    { id: 'immich', sourceKind: 'official-git', sourcePath: 'apps/immich', sourceRepository: 'https://github.com/rpuls/my-own-suite' },
  ];
  const plan = removalPlan(record, instances);
  assert.equal(plan.keepsSnapshots, true);
  assert.deepEqual(plan.orphanedInstanceIds, ['x-abc-notes']);
  assert.equal(plan.removedRecord.status, 'removed');
});

test('namespaced instance identity isolates a package by its source', () => {
  const record = buildSourceRecord(externalInput(), { now });
  const id = instanceNamespaceId(record, 'notes');
  assert.match(id, /^x-[a-f0-9]{8}-notes$/u);
  const otherSource = buildSourceRecord(externalInput({ repository: 'https://other.example/apps' }), { now });
  assert.notEqual(instanceNamespaceId(otherSource, 'notes'), id);
});

test('the external candidate gate fails closed on impersonation and host escalation and returns permissions', () => {
  const source = { kind: 'external-git', path: 'apps/community-notes', repository: 'https://code.example/community/apps', revision, trust: 'unverified' };
  const manifest = {
    id: 'community-notes',
    minimumMosVersion: '0.1.0',
    resources: { services: { notes: { volumes: ['notes-data:/data'] } } },
    routes: [{ host: 'notes', port: 8080, service: 'notes' }],
    version: '1.0.0',
  };
  const clean = validateExternalCandidate({ manifest, officialPackageIds: ['immich'], platformVersion: '0.11.0', source });
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(clean.permissions, ['route:ext-notes', 'volume:notes-data']);

  const hostile = validateExternalCandidate({
    manifest: { ...manifest, id: 'immich', privileged: true, resources: { services: { notes: { volumes: ['/etc:/host-etc'] } } } },
    officialPackageIds: ['immich'],
    platformVersion: '0.11.0',
    source,
  });
  assert.ok(hostile.errors.some((error) => error.includes('collides with an official package id')));
  assert.ok(hostile.errors.some((error) => error.includes('manifest.privileged')));
  assert.ok(hostile.errors.some((error) => error.includes('host path or bind mounts')));
});
