const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { ExternalSourceClient } = require('../src/apps/external-source-client.cjs');
const { AppOperationLimiter } = require('../src/apps/app-operation-limits.cjs');
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

// One rejection is an owner pasting the wrong repository. The same source doing
// it repeatedly is what a taken-over or force-pushed repository looks like, and
// until this was counted the only trace was an error shown to whoever asked.
test('a source serving a package the gate refuses is counted against that source', async () => {
  const events = [];
  const client = new ExternalSourceClient({
    fetchImpl: serveRepo(baseManifest({ id: 'immich' })),
    now: () => new Date('2026-07-15T10:00:00.000Z'),
    officialPackageIds: ['immich'],
    platformVersion: '0.11.0',
    recordSecurityEvent: (event) => events.push(event),
    stateDir: tempDir(),
  });

  await assert.rejects(() => client.downloadCandidate(activeSource()), { code: 'CANDIDATE_REJECTED' });
  assert.deepEqual(events, [{
    at: '2026-07-15T10:00:00.000Z',
    eventType: 'app-source-candidate-rejected',
    subject: activeSource().id,
  }]);
  assert.match(events[0].subject, /^src-[a-f0-9]{12}$/u);
});

// The bound that fires per source says something about that source. The
// host-wide one says only that MOS was busy with other sources, so counting it
// against this one would be a false accusation.
test('a throttled source is counted but a busy host is not blamed on it', async () => {
  const events = [];
  const options = {
    fetchImpl: serveRepo(baseManifest()),
    now: () => new Date('2026-07-15T10:00:00.000Z'),
    platformVersion: '0.11.0',
    recordSecurityEvent: (event) => events.push(event),
    stateDir: tempDir(),
  };
  const throttled = new ExternalSourceClient({ ...options, limiter: new AppOperationLimiter({ policy: { download: { maxPerWindow: 0 } } }) });
  await assert.rejects(() => throttled.downloadCandidate(activeSource()), { code: 'APP_DOWNLOAD_THROTTLED' });
  assert.deepEqual(events.map((event) => event.eventType), ['app-source-download-throttled']);

  const busy = new ExternalSourceClient({ ...options, limiter: new AppOperationLimiter({ policy: { download: { maxConcurrent: 0 } } }) });
  await assert.rejects(() => busy.downloadCandidate(activeSource()), { code: 'APP_DOWNLOAD_BUSY' });
  assert.equal(events.length, 1);
});

// The whole point of counting these is that the record can be kept and read
// later, so it must not become the place the owner's pasted URL comes to rest.
// Nothing is scrubbed here: the id is a digest of the repository, so there is
// never a URL in hand to leak.
test('a counted source event carries an opaque id and never the repository URL', async () => {
  const events = [];
  const client = new ExternalSourceClient({
    fetchImpl: serveRepo(baseManifest({ id: 'immich' })),
    officialPackageIds: ['immich'],
    platformVersion: '0.11.0',
    recordSecurityEvent: (event) => events.push(event),
    stateDir: tempDir(),
  });

  await assert.rejects(() => client.downloadCandidate(activeSource()), { code: 'CANDIDATE_REJECTED' });
  const recorded = JSON.stringify(events);
  assert.doesNotMatch(recorded, /https?:|github\.com|community|notes|@/u);
  assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'eventType', 'subject']);
});

// Recording is an observation of a refusal, not part of it. A store that cannot
// take the event must not turn a rejected candidate into a different error, or
// hide that the candidate was rejected at all.
test('a failing event recorder cannot change how a refused candidate fails', async () => {
  const client = new ExternalSourceClient({
    fetchImpl: serveRepo(baseManifest({ id: 'immich' })),
    officialPackageIds: ['immich'],
    platformVersion: '0.11.0',
    recordSecurityEvent: () => { throw new Error('database is gone'); },
    stateDir: tempDir(),
  });

  await assert.rejects(() => client.downloadCandidate(activeSource()), (error) => error.code === 'CANDIDATE_REJECTED' && /official package id/u.test(error.message));
});
