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

// A fake download client so the service is exercised without network access. It
// resolves a fixed revision and returns a candidate shaped like the real client.
function fakeClient(overrides = {}) {
  return {
    async resolveRevision(record) { return { ...record, revision }; },
    async downloadCandidate(record) {
      const packageId = 'community-notes';
      return {
        cleanup: () => {},
        manifest: { id: packageId, version: '1.0.0' },
        namespacedPackageId: `x-abcdef01-${packageId}`,
        packageId,
        permissions: ['route:notes', 'volume:notes-data'],
        source: { kind: 'external-git', path: '.mos', repository: record.repository, revision, trust: record.trust },
        trust: record.trust,
      };
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
  assert.equal(resolved.card.external, true);
  assert.equal(resolved.card.trust, 'unverified');
  assert.equal(resolved.card.mosReviewed, false);
  assert.equal(resolved.card.installStatus, 'external-available');
  assert.equal(resolved.card.iconUrl, '');
  assert.deepEqual(resolved.permissions, ['route:notes', 'volume:notes-data']);
  assert.deepEqual(resolved.source, {
    catalogPath: '.mos', kind: 'external-git', packageId: 'community-notes', repository: 'https://github.com/community/community-notes', revision, trust: 'unverified',
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
    category: 'tools', health: { type: 'http', url: 'http://notes:8080/health' }, icon: 'icon.png', id: 'community-notes',
    minimumMosVersion: '0.1.0', name: 'Community Notes', resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['notes-data:/data'] } } },
    routes: [{ host: 'notes', port: 8080, service: 'notes' }], setup: { fields: [] }, summary: 'Notes.', version: '1.0.0',
  };
  const owner = 'community';
  const repo = 'notes';
  const archive = tarGz(revision, { Dockerfile: Buffer.from('FROM scratch\n'), 'icon.png': iconBytes, 'manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  const fetchImpl = async (url) => {
    if (url === `https://api.github.com/repos/${owner}/${repo}/commits/main`) return new Response(JSON.stringify({ sha: revision }));
    if (url === `https://codeload.github.com/${owner}/${repo}/tar.gz/${revision}`) return new Response(archive);
    throw new Error(`unexpected ${url}`);
  };
  const client = new ExternalSourceClient({ fetchImpl, officialPackageIds: ['immich'], platformVersion: '0.11.0', stateDir: store.stateDir });
  const svc = new ExternalSourceService({ client, now, officialPackageIds: ['immich'], platformVersion: '0.11.0', store });
  const resolved = await svc.resolveUrl('https://github.com/community/notes/tree/main');
  assert.equal(resolved.card.iconDataUrl, `data:image/png;base64,${iconBytes.toString('base64')}`);
  assert.equal(resolved.card.external, true);
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
      snapshotPath: '/var/lib/mos/app-packages/x-abcdef01-community-notes/installed', snapshotState: 'installed',
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
      snapshotPath: '/var/lib/mos/app-packages/immich/installed', snapshotState: 'installed',
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
  assert.equal(orphaned.snapshotState, 'installed');
  assert.equal(orphaned.snapshotPath, '/var/lib/mos/app-packages/x-abcdef01-community-notes/installed');
  assert.equal(store.getAppProjections(orphaned.id).length, 1);
  // The unrelated official install is completely unaffected.
  assert.equal(store.getAppInstanceByPackageId('immich').status, 'installed');
  store.close();
});
