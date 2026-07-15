const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { ExternalSourceClient } = require('../src/apps/external-source-client.cjs');
const { buildSourceRecord, withRevision } = require('../src/apps/external-source-registry.cjs');

const revision = 'b'.repeat(40);
const owner = 'community';
const repo = 'notes';
const repository = `https://github.com/${owner}/${repo}`;

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mos-external-')); }

function tarHeader(name, size, typeflag = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write(typeflag, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += header[index];
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function tarGz(files) {
  const blocks = [];
  for (const [name, bytes] of Object.entries(files)) {
    const data = Buffer.from(bytes);
    blocks.push(tarHeader(`repo-${revision}/.mos/${name}`, data.length));
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function baseManifest(overrides = {}) {
  return {
    category: 'test', health: { type: 'http', url: 'http://notes:8080/health' }, id: 'community-notes',
    minimumMosVersion: '0.1.0', name: 'Community Notes',
    resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['notes-data:/data'] } } },
    routes: [{ host: 'notes', port: 8080, service: 'notes' }], setup: { fields: [] }, summary: 'Notes.', version: '1.0.0',
    ...overrides,
  };
}

function serveRepo(manifest) {
  const archive = tarGz({ Dockerfile: 'FROM scratch\n', 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n` });
  return async (url) => {
    if (url === `https://api.github.com/repos/${owner}/${repo}/commits/main`) return new Response(JSON.stringify({ sha: revision }));
    if (url === `https://codeload.github.com/${owner}/${repo}/tar.gz/${revision}`) return new Response(archive);
    throw new Error(`unexpected ${url}`);
  };
}

function activeSource() {
  return withRevision(buildSourceRecord({ repository, trust: 'unverified' }, { now: () => new Date('2026-07-15T10:00:00.000Z') }), revision);
}

test('resolveRevision binds the repository ref to an immutable commit', async () => {
  const client = new ExternalSourceClient({ fetchImpl: serveRepo(baseManifest()), platformVersion: '0.11.0', stateDir: tempDir() });
  const source = buildSourceRecord({ repository, trust: 'unverified' }, { now: () => new Date('2026-07-15T10:00:00.000Z') });
  assert.equal(source.revision, null);
  assert.equal((await client.resolveRevision(source, 'main')).revision, revision);
});

test('a valid unverified candidate downloads with a manifest id, namespaced identity, and its permission surface', async (t) => {
  const client = new ExternalSourceClient({ fetchImpl: serveRepo(baseManifest()), officialPackageIds: ['immich'], platformVersion: '0.11.0', stateDir: tempDir() });
  const candidate = await client.downloadCandidate(activeSource());
  t.after(() => candidate.cleanup());
  assert.equal(candidate.trust, 'unverified');
  assert.equal(candidate.packageId, 'community-notes');
  assert.equal(candidate.source.path, '.mos');
  assert.match(candidate.namespacedPackageId, /^x-[a-f0-9]{8}-community-notes$/u);
  assert.deepEqual(candidate.permissions, ['route:notes', 'volume:notes-data']);
});

test('a candidate download is refused from a non-active source and before the revision is resolved', async () => {
  const client = new ExternalSourceClient({ fetchImpl: serveRepo(baseManifest()), platformVersion: '0.11.0', stateDir: tempDir() });
  const unresolved = buildSourceRecord({ repository, trust: 'unverified' }, { now: () => new Date('2026-07-15T10:00:00.000Z') });
  await assert.rejects(() => client.downloadCandidate(unresolved), { code: 'SOURCE_REVISION_INVALID' });
  await assert.rejects(() => client.downloadCandidate({ ...activeSource(), status: 'removed' }), { code: 'SOURCE_NOT_INSTALLABLE' });
});

test('impersonation, host escalation, and platform incompatibility fail before build/apply', async () => {
  const stateDir = tempDir();
  const impersonator = new ExternalSourceClient({ fetchImpl: serveRepo(baseManifest({ id: 'immich' })), officialPackageIds: ['immich'], platformVersion: '0.11.0', stateDir });
  await assert.rejects(() => impersonator.downloadCandidate(activeSource()), (error) => error.code === 'CANDIDATE_REJECTED' && /official package id/u.test(error.message));

  const privileged = baseManifest({ privileged: true, resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['/etc:/host-etc'] } } } });
  const escalating = new ExternalSourceClient({ fetchImpl: serveRepo(privileged), platformVersion: '0.11.0', stateDir });
  await assert.rejects(() => escalating.downloadCandidate(activeSource()), (error) => error.code === 'CANDIDATE_REJECTED' && /manifest\.privileged/u.test(error.message) && /host path or bind mounts/u.test(error.message));

  const future = new ExternalSourceClient({ fetchImpl: serveRepo(baseManifest({ minimumMosVersion: '9.9.9' })), platformVersion: '0.11.0', stateDir });
  await assert.rejects(() => future.downloadCandidate(activeSource()), (error) => error.code === 'CANDIDATE_REJECTED' && /requires MOS/u.test(error.message));
});
