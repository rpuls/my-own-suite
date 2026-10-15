const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');
const { ExternalSourceService } = require('../src/apps/external-source-service.cjs');
const { ExternalSourceClient } = require('../src/apps/external-source-client.cjs');
const { ExternalSourceError } = require('../src/apps/external-source-registry.cjs');

const now = () => new Date('2026-07-15T10:00:00.000Z');
const revision = 'b'.repeat(40);
const repository = 'https://github.com/community/apps';

async function tempStore() {
  return new SuiteManagerStore(await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-external-svc-')));
}

// Build a real repo archive (`repo-<sha>/.mos/**`) so the icon path is exercised
// end-to-end through the actual client and hardened extractor.
function tarGz(sha, files) {
  const blocks = [];
  for (const [name, bytes] of Object.entries(files)) {
    const data = Buffer.from(bytes);
    const header = Buffer.alloc(512);
    header.write(`repo-${sha}/.mos/${name}`, 0, 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += header[index];
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

// One validated package entry, shaped like the real client's readPackage output.
function fakePackage(record, packageId) {
  return {
    errors: [],
    folder: null,
    manifest: { category: 'tools', id: packageId, name: packageId, summary: `${packageId}.`, version: '1.0.0' },
    manifestPath: `${packageId}/manifest.json`,
    namespacedPackageId: `x-abcdef01-${packageId}`,
    packageDigest: `sha256:${'0'.repeat(64)}`,
    packageDir: null,
    packageId,
    permissions: ['route:notes', 'volume:notes-data'],
    source: { kind: 'external-git', path: '.mos', repository: record.repository, revision, trust: record.trust },
    trust: record.trust,
  };
}

// A fake download client so the service is exercised without network access. It
// resolves a fixed revision and serves the packages it was built with, selecting
// between them the way the real client does.
function fakeClient(overrides = {}, packageIds = ['community-notes']) {
  return {
    async resolveRevision(record) { return { ...record, revision }; },
    async listPackages(record) {
      return { cleanup: () => {}, packages: packageIds.map((id) => fakePackage(record, id)) };
    },
    async downloadCandidate(record, { packageId = null } = {}) {
      const packages = packageIds.map((id) => fakePackage(record, id));
      const wanted = packageId
        ? packages.find((entry) => entry.namespacedPackageId === packageId)
        : (packages.length === 1 ? packages[0] : null);
      if (!wanted) {
        throw new ExternalSourceError(
          packageId ? 'SOURCE_PACKAGE_NOT_FOUND' : 'SOURCE_PACKAGE_REQUIRED',
          packageId ? 'This source does not publish that app package.' : 'This source publishes more than one app package; name the one to install.',
        );
      }
      return { ...wanted, cleanup: () => {} };
    },
    ...overrides,
  };
}

function service(store, client = fakeClient()) {
  return new ExternalSourceService({ client, now, officialPackageIds: ['immich'], platformVersion: '0.11.0', store });
}

test('adding a source records it uncredentialed, unverified, and revision-resolved with explicit non-official status', async () => {
  const store = await tempStore();
  const svc = service(store);
  const added = await svc.addSource({ catalogPath: 'apps', publisher: 'community', repository, trust: 'unverified' });
  assert.equal(added.trust, 'unverified');
  assert.equal(added.mosReviewed, false);
  assert.equal(added.official, false);
  assert.equal(added.revision, revision);
  assert.deepEqual(svc.listSources().map((source) => source.id), [added.id]);
  await assert.rejects(() => svc.addSource({ catalogPath: 'apps', repository, trust: 'unverified' }), { code: 'SOURCE_ALREADY_ADDED' });
  store.close();
});

test('adding a credentialed or non-HTTPS source is rejected before anything is persisted', async () => {
  const store = await tempStore();
  const svc = service(store);
  await assert.rejects(() => svc.addSource({ repository: 'http://github.com/community/apps', trust: 'unverified' }), (error) => error instanceof ExternalSourceError && error.code === 'SOURCE_URL_INVALID');
  await assert.rejects(() => svc.addSource({ repository: 'https://user:pw@github.com/community/apps', trust: 'unverified' }), { code: 'SOURCE_URL_INVALID' });
  assert.deepEqual(svc.listSources(), []);
  store.close();
});

test('resolving a pasted repository URL returns an external, unverified card without persisting anything', async () => {
  const store = await tempStore();
  const svc = service(store);
  const resolved = await svc.resolveUrl('https://github.com/community/community-notes');
  assert.equal(resolved.packages.length, 1); // a single-package repository is the one-entry case
  const [card] = resolved.packages;
  assert.equal(card.external, true);
  assert.equal(card.trust, 'unverified');
  assert.equal(card.mosReviewed, false);
  assert.equal(card.installStatus, 'external-available');
  assert.equal(card.iconUrl, '');
  assert.equal(card.packageId, 'community-notes');
  assert.deepEqual(card.permissions, ['route:notes', 'volume:notes-data']);
  assert.equal(resolved.added, false);
  assert.deepEqual(resolved.source, {
    catalogPath: '.mos', id: resolved.source.id, kind: 'external-git', repository: 'https://github.com/community/community-notes', revision, trust: 'unverified',
  });
  assert.deepEqual(svc.listSources(), []); // nothing persisted by a preview
  store.close();
});

// The install path is the only external flow that persists anything, so it must
// register the source, hand the freshly re-validated candidate to the shared
// install pipeline, and keep unverified trust all the way through.
test('installing a pasted URL registers the source and installs the revalidated candidate as unverified', async () => {
  const store = await tempStore();
  const installs = [];
  const svc = new ExternalSourceService({
    appPackages: {
      async installExternalPackage(input) {
        installs.push(input);
        return { id: 'instance-1', packageId: input.candidate.namespacedPackageId, status: 'installed' };
      },
    },
    client: fakeClient(),
    now,
    officialPackageIds: ['immich'],
    platformVersion: '0.11.0',
    store,
  });

  const result = await svc.installUrl('https://github.com/community/community-notes', { config: { adminEmail: 'owner@example.com' } });

  assert.equal(result.trust, 'unverified');
  assert.equal(result.mosReviewed, false);
  assert.match(result.packageId, /^x-[a-f0-9]{8}-community-notes$/u);
  assert.deepEqual(result.permissions, ['route:notes', 'volume:notes-data']);
  assert.equal(result.instance.packageId, result.packageId);
  assert.equal(result.source.revision, revision);
  assert.equal(result.source.trust, 'unverified');
  assert.equal(result.source.mosReviewed, false);
  assert.deepEqual(installs.map((item) => item.input), [{ adminEmail: 'owner@example.com' }]);
  assert.equal(installs[0].candidate.source.trust, 'unverified');
  assert.deepEqual(svc.listSources().map((source) => [source.repository, source.status]), [['https://github.com/community/community-notes', 'active']]);
  store.close();
});

test('installing from a compromised source is blocked and installs nothing', async () => {
  const store = await tempStore();
  const svc = new ExternalSourceService({
    appPackages: { async installExternalPackage() { throw new Error('should not be called'); } },
    client: fakeClient(),
    now,
    officialPackageIds: ['immich'],
    platformVersion: '0.11.0',
    store,
  });
  const added = await svc.addSource({ catalogPath: '.mos', repository: 'https://github.com/community/community-notes', trust: 'unverified' });
  svc.setSourceStatus(added.id, 'compromised', 'Publisher account takeover.');

  await assert.rejects(() => svc.installUrl('https://github.com/community/community-notes'), { code: 'SOURCE_NOT_INSTALLABLE' });
  assert.equal(svc.listSources()[0].status, 'compromised');
  store.close();
});

test('installing a URL from an unsupported host fails before any network access or persistence', async () => {
  const store = await tempStore();
  const svc = new ExternalSourceService({
    appPackages: { async installExternalPackage() { throw new Error('should not be called'); } },
    client: { resolveRevision() { throw new Error('should not be called'); }, downloadCandidate() { throw new Error('should not be called'); } },
    now,
    officialPackageIds: ['immich'],
    platformVersion: '0.11.0',
    store,
  });
  await assert.rejects(() => svc.installUrl('https://gitlab.com/community/notes'), { code: 'SOURCE_URL_INVALID' });
  assert.deepEqual(svc.listSources(), []);
  store.close();
});

test('resolving a URL from an unsupported host fails before any network access', async () => {
  const store = await tempStore();
  const svc = service(store, { resolveRevision() { throw new Error('should not be called'); }, downloadCandidate() { throw new Error('should not be called'); } });
  await assert.rejects(() => svc.resolveUrl('https://gitlab.com/community/notes'), { code: 'SOURCE_URL_INVALID' });
  store.close();
});

test('a resolved card inlines the package own icon as a data URL', async () => {
  const store = await tempStore();
  const iconBytes = Buffer.from('89504e470d0a1a0a', 'hex'); // tiny PNG-ish blob
  const manifest = {
    manifestVersion: 1,
    category: 'tools', health: { type: 'http', url: 'http://notes:8080/health' }, icon: 'icon.png', id: 'community-notes',
    minimumMosVersion: '0.1.0', name: 'Community Notes', resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['notes-data:/data'] } } },
    routes: [{ host: 'notes', port: 8080, service: 'notes' }], setup: { fields: [] }, summary: 'Notes.', version: '1.0.0',
  };
  const owner = 'community';
  const repo = 'notes';
  const archive = tarGz(revision, { Dockerfile: Buffer.from('FROM scratch\n'), 'icon.png': iconBytes, 'manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  const fetchImpl = async (url) => {
    if (url === `https://api.github.com/repos/${owner}/${repo}/commits/main`) return new Response(revision);
    if (url === `https://codeload.github.com/${owner}/${repo}/tar.gz/${revision}`) return new Response(archive);
    throw new Error(`unexpected ${url}`);
  };
  const client = new ExternalSourceClient({ fetchImpl, officialPackageIds: ['immich'], platformVersion: '0.11.0', stateDir: store.stateDir });
  const svc = new ExternalSourceService({ client, now, officialPackageIds: ['immich'], platformVersion: '0.11.0', store });
  const resolved = await svc.resolveUrl('https://github.com/community/notes/tree/main');
  assert.equal(resolved.packages[0].iconDataUrl, `data:image/png;base64,${iconBytes.toString('base64')}`);
  assert.equal(resolved.packages[0].external, true);
  store.close();
});

// The point of the slice: one repository may publish a catalog of apps, and the
// single-package repository is simply the one-entry case of the same thing.
test('a source publishing several packages lists all of them and refuses to guess which to install', async () => {
  const store = await tempStore();
  const client = fakeClient({}, ['scan-bridge', 'community-notes']);
  const svc = new ExternalSourceService({
    appPackages: { async installExternalPackage({ candidate }) { return { id: 'i1', packageId: candidate.namespacedPackageId, status: 'installed' }; } },
    client, now, officialPackageIds: ['immich'], platformVersion: '0.11.0', store,
  });
  const resolved = await svc.resolveUrl(repository);
  assert.deepEqual(resolved.packages.map((card) => card.packageId), ['scan-bridge', 'community-notes']);
  // Every card is addressed by its source-namespaced id, so two sources shipping
  // one package id can never collide in the Apps list.
  assert.deepEqual(resolved.packages.map((card) => card.id), ['x-abcdef01-scan-bridge', 'x-abcdef01-community-notes']);

  await assert.rejects(() => svc.installUrl(repository), { code: 'SOURCE_PACKAGE_REQUIRED' });
  await assert.rejects(() => svc.installUrl(repository, { packageId: 'x-abcdef01-nope' }), { code: 'SOURCE_PACKAGE_NOT_FOUND' });
  const installed = await svc.installUrl(repository, { packageId: 'x-abcdef01-scan-bridge' });
  assert.equal(installed.packageId, 'x-abcdef01-scan-bridge');
  assert.equal(installed.trust, 'unverified');
  store.close();
});

// Adding a source is what fills the cache; the Apps list then reads only the cache,
// so browsing an added catalog costs no network at all.
test('an added source caches its package list and serves it to the Apps list without refetching', async () => {
  const store = await tempStore();
  let listings = 0;
  const client = fakeClient({
    async listPackages(record) {
      listings += 1;
      return { cleanup: () => {}, packages: ['scan-bridge', 'community-notes'].map((id) => fakePackage(record, id)) };
    },
  }, ['scan-bridge', 'community-notes']);
  const svc = service(store, client);
  const added = await svc.addSource({ publisher: 'community', repository, trust: 'unverified' });
  assert.equal(listings, 1);
  assert.equal(added.catalog.packageCount, 2);
  assert.equal(added.catalog.revision, revision);

  assert.deepEqual(svc.catalogPackages().map((card) => card.id), ['x-abcdef01-scan-bridge', 'x-abcdef01-community-notes']);
  assert.equal(svc.catalogPackages()[0].source.repository, repository);
  assert.equal(listings, 1); // reading the catalog never touches the network

  // A probe that finds the same commit must not pay for the archive again.
  const probe = await svc.refreshSource(added.id, { force: true });
  assert.equal(probe.catalog.packageCount, 2);
  assert.equal(probe.outcome, 'unchanged');
  assert.equal(listings, 1);
  store.close();
});

// The regression this caught once: an update replaced 'Not yet reviewed' with 'Not
// assessed by MOS' and the Apps page kept the old card, because an unchanged
// revision skips the archive download and the whole rendered card is cached.
test('MOS-owned card fields are re-derived on read, so a cached card cannot outlive the rules that made it', async () => {
  const store = await tempStore();
  const client = fakeClient({
    async listPackages(record) {
      return { cleanup: () => {}, packages: [fakePackage(record, 'community-notes')] };
    },
  }, ['community-notes']);
  const svc = service(store, client);
  const added = await svc.addSource({ publisher: 'community', repository, trust: 'unverified' });

  // A cache written by an older MOS: good source content, stale rules beside it.
  const stale = svc.cache.get(added.id);
  svc.cache.put(added.id, {
    packages: stale.packages.map((card) => ({
      ...card,
      advisories: [{ id: 'invented' }],
      catalogUpdate: { available: null, installed: null, status: 'up-to-date' },
      external: false,
      mosReviewed: true,
      privacy: { dimensions: null, posture: 'private-by-default', reviewedAt: null, status: 'reviewed' },
    })),
    revision: stale.revision,
  });

  const [card] = svc.catalogPackages();
  assert.equal(card.privacy.status, 'not-assessed');
  assert.equal(card.privacy.posture, null);
  assert.equal(card.mosReviewed, false);
  assert.equal(card.external, true);
  assert.equal(card.trust, 'unverified');
  assert.deepEqual(card.advisories, []);
  assert.equal(card.catalogUpdate.status, 'external-source');
  // What the source published still comes from the cache.
  assert.equal(card.packageId, 'community-notes');
  assert.deepEqual(card.permissions, ['route:notes', 'volume:notes-data']);
  store.close();
});
// A source MOS cannot reach has not retracted what it published yesterday, and the
// reason it could not be reached is the whole point of the warning an owner sees.
test('an unreachable source keeps serving its cached packages and records what the host actually answered', async () => {
  const store = await tempStore();
  let fail = false;
  const client = fakeClient({
    async resolveRevision(record) {
      if (fail) {
        const error = new ExternalSourceError('SOURCE_NOT_VISIBLE', 'The git host will not show this repository to an anonymous request.');
        throw error;
      }
      return { ...record, revision };
    },
  });
  const svc = service(store, client);
  const added = await svc.addSource({ repository, trust: 'unverified' });
  fail = true;
  const { catalog: status, outcome } = await svc.refreshSource(added.id, { force: true });
  assert.equal(outcome, 'failed');
  assert.equal(status.error.code, 'SOURCE_NOT_VISIBLE');
  assert.equal(status.error.failures, 1);
  assert.equal(status.packageCount, 1); // the previously published package is still offered
  assert.deepEqual(svc.catalogPackages().map((card) => card.packageId), ['community-notes']);
  // Consecutive failures stretch the wait rather than spending the hour's quota on
  // a repository that is gone.
  const { catalog: second } = await svc.refreshSource(added.id, { force: true });
  assert.equal(second.error.failures, 2);
  assert.ok(Date.parse(second.nextCheckAt) > Date.parse(status.nextCheckAt));
  store.close();
});

test('a source that is not installable offers no cards, and removing one forgets its cached list', async () => {
  const store = await tempStore();
  const svc = service(store);
  const added = await svc.addSource({ repository, trust: 'unverified' });
  assert.equal(svc.catalogPackages().length, 1);

  svc.setSourceStatus(added.id, 'unavailable', 'Owner marked it unavailable.');
  assert.deepEqual(svc.catalogPackages(), []); // nothing offerable, so nothing offered

  svc.setSourceStatus(added.id, 'active');
  assert.equal(svc.catalogPackages().length, 1);

  svc.removeSource(added.id);
  assert.deepEqual(svc.catalogPackages(), []);
  assert.equal(svc.cache.get(added.id), null);
  store.close();
});

// Removing a source is a decision the owner is entitled to take back. The record
// MOS keeps of the removal is hidden from them everywhere — the Settings list
// drops it, the Apps screen offers nothing from it — so if it still answered
// "already added" to the same URL the owner would be left with no add button, no
// row to act on, and no way to undo.
test('a source the owner removed can be added again, and its record does not block the paste', async () => {
  const store = await tempStore();
  const svc = service(store);
  const added = await svc.addSource({ repository, trust: 'unverified' });
  svc.removeSource(added.id);

  // The paste reports it as absent, which is what puts the add back in front of
  // the owner, and the install behind it is not blocked either.
  const resolved = await svc.resolveUrl(repository);
  assert.equal(resolved.added, false);

  const readded = await svc.addSource({ repository, trust: 'unverified' });
  // Same repository, so the same derived identity: anything still installed from
  // it is adopted again rather than orphaned twice.
  assert.equal(readded.id, added.id);
  assert.equal(readded.status, 'active');
  assert.equal(svc.catalogPackages().length, 1);

  // And a source the owner actually holds still refuses a second add.
  await assert.rejects(() => svc.addSource({ repository, trust: 'unverified' }), { code: 'SOURCE_ALREADY_ADDED' });
  store.close();
});

test('previewing a candidate returns its permission surface and unverified trust without persisting anything', async () => {
  const store = await tempStore();
  const svc = service(store);
  const added = await svc.addSource({ catalogPath: 'apps', repository, trust: 'unverified' });
  const preview = await svc.previewCandidate(added.id);
  assert.equal(preview.trust, 'unverified');
  assert.equal(preview.mosReviewed, false);
  assert.deepEqual(preview.permissions, ['route:notes', 'volume:notes-data']);
  assert.match(preview.namespacedPackageId, /^x-[a-f0-9]{8}-community-notes$/u);
  store.close();
});

test('status transitions are gated and a non-active source blocks new-install preview', async () => {
  const store = await tempStore();
  const svc = service(store);
  const added = await svc.addSource({ catalogPath: 'apps', repository, trust: 'unverified' });
  const compromised = svc.setSourceStatus(added.id, 'compromised', 'Key compromise reported.');
  assert.equal(compromised.status, 'compromised');
  assert.throws(() => svc.setSourceStatus(added.id, 'active'), { code: 'SOURCE_STATUS_TRANSITION_INVALID' });
  await assert.rejects(() => svc.previewCandidate(added.id), { code: 'SOURCE_NOT_INSTALLABLE' });
  store.close();
});

test('removing a source orphans its installs but never uninstalls them or breaks their lifecycle', async () => {
  const store = await tempStore();
  const svc = service(store);
  const added = await svc.addSource({ catalogPath: 'apps', repository, trust: 'unverified' });

  // An app installed from this source, and an unrelated official install.
  store.installAppInstance({
    at: '2026-07-15T10:05:00.000Z',
    instance: {
      categorySnapshot: 'tools', displayNameSnapshot: 'Community Notes', id: 'x-abcdef01-community-notes',
      manifestDigest: 'sha256:manifest', packageDigest: `sha256:${'c'.repeat(64)}`, packageId: 'community-notes', packageVersion: '1.0.0',
      snapshotPath: '/var/lib/mos/app-packages/x-abcdef01-community-notes/installed',
      // Production shape: the instance records the source's catalog path itself
      // (external-source-client), which is what ties it back to its source.
      source: { kind: 'external-git', path: 'apps', repository, revision, trust: 'unverified' },
    },
    operationId: 'op-external', projections: [{ contentJson: '{"services":[]}', digest: 'sha256:compose', kind: 'compose' }], request: { dryRunOnly: true },
  });
  store.installAppInstance({
    at: '2026-07-15T10:06:00.000Z',
    instance: {
      categorySnapshot: 'media', displayNameSnapshot: 'Immich', id: 'immich',
      manifestDigest: 'sha256:immich', packageDigest: `sha256:${'d'.repeat(64)}`, packageId: 'immich', packageVersion: '2.0.0',
      snapshotPath: '/var/lib/mos/app-packages/immich/installed',
      source: { kind: 'official-git', path: 'apps/immich', repository: 'https://github.com/rpuls/my-own-suite', revision: 'a'.repeat(40), trust: 'mos-reviewed' },
    },
    operationId: 'op-official', projections: [{ contentJson: '{"services":[]}', digest: 'sha256:compose', kind: 'compose' }], request: { dryRunOnly: true },
  });

  const result = svc.removeSource(added.id);
  assert.equal(result.keepsSnapshots, true);
  assert.deepEqual(result.orphanedInstanceIds, ['x-abcdef01-community-notes']);
  assert.equal(result.source.status, 'removed');

  // The orphaned install is untouched: still installed, snapshot intact, and its
  // projections/config remain fully readable and manageable.
  const orphaned = store.getAppInstanceByPackageId('community-notes');
  assert.equal(orphaned.status, 'installed');
  assert.equal(orphaned.snapshotPath, '/var/lib/mos/app-packages/x-abcdef01-community-notes/installed');
  assert.equal(store.getAppProjections(orphaned.id).length, 1);
  // The unrelated official install is completely unaffected.
  assert.equal(store.getAppInstanceByPackageId('immich').status, 'installed');
  store.close();
});

test('a forced refresh reports whether the source moved, was already current, or could not be reached', async () => {
  const store = await tempStore();
  let head = revision;
  let version = '1.0.0';
  let failure = null;
  const client = fakeClient({
    async resolveRevision(record) {
      if (failure) throw new ExternalSourceError(failure, 'The git host will not show this repository to an anonymous request.');
      return { ...record, revision: head };
    },
    async listPackages(record) {
      const entry = fakePackage(record, 'community-notes');
      return { cleanup: () => {}, packages: [{ ...entry, manifest: { ...entry.manifest, version } }] };
    },
  });
  const svc = service(store, client);
  const added = await svc.addSource({ repository, trust: 'unverified' });

  assert.equal((await svc.refreshSource(added.id, { force: true })).outcome, 'unchanged');

  head = 'c'.repeat(40);
  version = '1.1.0';
  const moved = await svc.refreshSource(added.id, { force: true });
  assert.equal(moved.outcome, 'moved');
  assert.equal(moved.catalog.revision, head);
  assert.equal(svc.catalogPackages()[0].version, '1.1.0');

  failure = 'SOURCE_NOT_VISIBLE';
  const failed = await svc.refreshSource(added.id, { force: true });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.catalog.error.code, 'SOURCE_NOT_VISIBLE');

  // Nothing happened is not the same answer as nothing changed.
  failure = null;
  svc.setSourceStatus(added.id, 'unavailable', 'Paused by the owner.');
  assert.equal((await svc.refreshSource(added.id, { force: true })).outcome, 'not-active');
  store.close();
});

test('a cached card carries the commit its list was read from and when MOS last confirmed it', async () => {
  const store = await tempStore();
  const svc = service(store);
  const added = await svc.addSource({ repository, trust: 'unverified' });

  const [card] = svc.catalogPackages();
  assert.equal(card.source.revision, revision);
  assert.equal(card.source.checkedAt, now().toISOString());
  assert.equal(card.source.id, added.id);
  store.close();
});
