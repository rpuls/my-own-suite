const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ExternalSourceClient } = require('../src/apps/external-source-client.cjs');
const { buildSourceRecord, withRevision } = require('../src/apps/external-source-registry.cjs');

const revision = 'b'.repeat(40);
const owner = 'community';
const repo = 'apps';
const repository = `https://github.com/${owner}/${repo}`;
const catalogPath = 'apps';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mos-external-')); }
function jsonResponse(value, options = {}) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...options.headers }, status: options.status || 200 }); }

function baseManifest(overrides = {}) {
  return {
    category: 'test',
    health: { type: 'http', url: 'http://notes:8080/health' },
    id: 'community-notes',
    minimumMosVersion: '0.1.0',
    name: 'Community Notes',
    resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['notes-data:/data'] } } },
    routes: [{ host: 'notes', port: 8080, service: 'notes' }],
    setup: { fields: [] },
    summary: 'Community notes package.',
    version: '1.0.0',
    ...overrides,
  };
}

// Serve an on-disk package folder through a mocked GitHub contents/raw API bound
// to a fixed revision, so tests exercise the real download+validation path.
function servePackage(packageId, files) {
  const entryPath = `${catalogPath}/${packageId}`;
  return async (url) => {
    if (url === `https://api.github.com/repos/${owner}/${repo}/commits/main`) return jsonResponse({ sha: revision });
    if (url === `https://api.github.com/repos/${owner}/${repo}/contents/${entryPath}?ref=${revision}`) {
      return jsonResponse(Object.entries(files).map(([name, bytes]) => ({
        download_url: `https://raw.githubusercontent.com/${owner}/${repo}/${revision}/${entryPath}/${name}`,
        path: `${entryPath}/${name}`,
        size: bytes.length,
        type: 'file',
      })));
    }
    const name = url.split('/').at(-1);
    if (files[name] && url === `https://raw.githubusercontent.com/${owner}/${repo}/${revision}/${entryPath}/${name}`) return new Response(files[name]);
    return new Response('Not Found', { status: 404 });
  };
}

function packageFiles(manifest) {
  return {
    Dockerfile: Buffer.from('FROM scratch\n'),
    'manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  };
}

function activeSource() {
  return withRevision(buildSourceRecord({ catalogPath, publisher: 'community', repository, trust: 'unverified' }, { now: () => new Date('2026-07-15T10:00:00.000Z') }), revision);
}

test('resolveRevision binds the source to an immutable commit before any content is trusted', async () => {
  const client = new ExternalSourceClient({ fetchImpl: servePackage('community-notes', packageFiles(baseManifest())), platformVersion: '0.11.0', stateDir: tempDir() });
  const source = buildSourceRecord({ catalogPath, repository, trust: 'unverified' }, { now: () => new Date('2026-07-15T10:00:00.000Z') });
  assert.equal(source.revision, null);
  const resolved = await client.resolveRevision(source);
  assert.equal(resolved.revision, revision);
});

test('a valid unverified candidate downloads with namespaced identity, unverified trust, and its permission surface', async (t) => {
  const client = new ExternalSourceClient({ fetchImpl: servePackage('community-notes', packageFiles(baseManifest())), officialPackageIds: ['immich'], platformVersion: '0.11.0', stateDir: tempDir() });
  const candidate = await client.downloadCandidate(activeSource(), 'community-notes');
  t.after(() => candidate.cleanup());
  assert.equal(candidate.trust, 'unverified');
  assert.equal(candidate.source.kind, 'external-git');
  assert.equal(candidate.source.revision, revision);
  assert.match(candidate.instanceId, /^x-[a-f0-9]{8}-community-notes$/u);
  assert.deepEqual(candidate.permissions, ['route:notes', 'volume:notes-data']);
  assert.equal(candidate.manifest.version, '1.0.0');
});

test('a candidate download is refused from a non-active source and before the revision is resolved', async () => {
  const client = new ExternalSourceClient({ fetchImpl: servePackage('community-notes', packageFiles(baseManifest())), platformVersion: '0.11.0', stateDir: tempDir() });
  const unresolved = buildSourceRecord({ catalogPath, repository, trust: 'unverified' }, { now: () => new Date('2026-07-15T10:00:00.000Z') });
  await assert.rejects(() => client.downloadCandidate(unresolved, 'community-notes'), { code: 'SOURCE_REVISION_INVALID' });
  const removed = { ...activeSource(), status: 'removed' };
  await assert.rejects(() => client.downloadCandidate(removed, 'community-notes'), { code: 'SOURCE_NOT_INSTALLABLE' });
});

test('impersonation, host escalation, and traversal fixtures fail before build/apply', async () => {
  const stateDir = tempDir();
  const impersonator = new ExternalSourceClient({ fetchImpl: servePackage('immich', packageFiles(baseManifest({ id: 'immich' }))), officialPackageIds: ['immich'], platformVersion: '0.11.0', stateDir });
  await assert.rejects(() => impersonator.downloadCandidate(activeSource(), 'immich'), (error) => error.code === 'CANDIDATE_REJECTED' && /official package id/u.test(error.message));

  const privileged = baseManifest({ privileged: true, resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['/etc:/host-etc'] } } } });
  const escalating = new ExternalSourceClient({ fetchImpl: servePackage('community-notes', packageFiles(privileged)), platformVersion: '0.11.0', stateDir });
  await assert.rejects(() => escalating.downloadCandidate(activeSource(), 'community-notes'), (error) => error.code === 'CANDIDATE_REJECTED' && /manifest\.privileged/u.test(error.message) && /host path or bind mounts/u.test(error.message));

  const socket = baseManifest({ resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['sock:/var/run/docker.sock'] } } } });
  const dockerSocket = new ExternalSourceClient({ fetchImpl: servePackage('community-notes', packageFiles(socket)), platformVersion: '0.11.0', stateDir });
  await assert.rejects(() => dockerSocket.downloadCandidate(activeSource(), 'community-notes'), (error) => error.code === 'CANDIDATE_REJECTED' && /Docker socket/u.test(error.message));

  const traversal = new ExternalSourceClient({
    fetchImpl: async (url) => {
      if (url.endsWith('/commits/main')) return jsonResponse({ sha: revision });
      if (url.includes('/contents/')) return jsonResponse([{ download_url: `https://raw.githubusercontent.com/${owner}/${repo}/${revision}/apps/community-notes/../secret`, path: 'apps/community-notes/../secret', size: 4, type: 'file' }]);
      return new Response('data');
    },
    platformVersion: '0.11.0',
    stateDir,
  });
  await assert.rejects(() => traversal.downloadCandidate(activeSource(), 'community-notes'), { code: 'CANDIDATE_PATH_INVALID' });
});

test('a candidate that requires a newer platform than installed is rejected', async () => {
  const client = new ExternalSourceClient({ fetchImpl: servePackage('community-notes', packageFiles(baseManifest({ minimumMosVersion: '9.9.9' }))), platformVersion: '0.11.0', stateDir: tempDir() });
  await assert.rejects(() => client.downloadCandidate(activeSource(), 'community-notes'), (error) => error.code === 'CANDIDATE_REJECTED' && /requires MOS/u.test(error.message));
});
