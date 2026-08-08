const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  DEFAULT_LIMITS,
  downloadMosPackage,
  extractMosPackage,
  parseGitPackageUrl,
  resolveCommit,
} = require('../src/apps/git-archive-source.cjs');

const sha = 'b'.repeat(40);

async function tempDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-archive-')); }

// Build a real ustar header + gzip so tests exercise the actual reader, not a mock.
function tarHeader(name, size, typeflag = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(typeflag, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += header[index];
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function tarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = entry.typeflag === '5' ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
    blocks.push(tarHeader(entry.name, data.length, entry.typeflag || '0'));
    if (data.length) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return zlib.gzipSync(Buffer.concat(blocks));
}

const validManifest = JSON.stringify({
  manifestVersion: 1,
  category: 'tools', health: { type: 'http', url: 'http://notes:8080/health' }, id: 'community-notes',
  minimumMosVersion: '0.1.0', name: 'Community Notes', resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080 } } },
  routes: [{ host: 'notes', port: 8080, service: 'notes' }], setup: { fields: [] }, summary: 'Notes.', version: '1.0.0',
}, null, 2);

function validArchive(root = `repo-${sha}`) {
  return tarGz([
    { name: `${root}/`, typeflag: '5' },
    { name: `${root}/README.md`, data: '# repo\n' }, // ignored: outside .mos
    { name: `${root}/.mos/`, typeflag: '5' },
    { name: `${root}/.mos/manifest.json`, data: validManifest },
    { name: `${root}/.mos/Dockerfile`, data: 'FROM scratch\n' },
  ]);
}

test('a pasted GitHub repo URL parses to coordinates, with or without an explicit ref', () => {
  assert.deepEqual(parseGitPackageUrl('https://github.com/community/notes'), { host: 'github.com', owner: 'community', ref: null, repo: 'notes', repository: 'https://github.com/community/notes' });
  assert.deepEqual(parseGitPackageUrl('https://github.com/community/notes.git'), { host: 'github.com', owner: 'community', ref: null, repo: 'notes', repository: 'https://github.com/community/notes' });
  assert.equal(parseGitPackageUrl('https://github.com/community/notes/tree/v1.0.0').ref, 'v1.0.0');
  for (const bad of [
    'not-a-url', 'http://github.com/community/notes', 'https://token@github.com/community/notes',
    'https://gitlab.com/community/notes', 'https://codeberg.org/community/notes', 'https://github.com/community',
    'https://github.com/community/notes/blob/main/x',
  ]) {
    assert.throws(() => parseGitPackageUrl(bad), { code: 'SOURCE_URL_INVALID' }, bad);
  }
});

test('resolveCommit resolves the default branch then pins an immutable commit', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://api.github.com/repos/community/notes') return new Response(JSON.stringify({ default_branch: 'trunk' }));
    if (url === 'https://api.github.com/repos/community/notes/commits/trunk') return new Response(JSON.stringify({ sha }));
    throw new Error(`unexpected ${url}`);
  };
  assert.equal(await resolveCommit(fetchImpl, { host: 'github.com', owner: 'community', ref: null, repo: 'notes' }), sha);
  assert.deepEqual(calls, ['https://api.github.com/repos/community/notes', 'https://api.github.com/repos/community/notes/commits/trunk']);

  const pinned = async (url) => (url.endsWith('/commits/v1.0.0') ? new Response(JSON.stringify({ sha })) : (() => { throw new Error('should not fetch repo info'); })());
  assert.equal(await resolveCommit(pinned, { host: 'github.com', owner: 'community', ref: 'v1.0.0', repo: 'notes' }), sha);
});

test('extractMosPackage materializes only the .mos folder as the package root', async () => {
  const dest = await tempDir();
  extractMosPackage(validArchive(), dest, DEFAULT_LIMITS);
  assert.ok(fs.existsSync(path.join(dest, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(dest, 'Dockerfile')));
  assert.ok(!fs.existsSync(path.join(dest, 'README.md'))); // repo files outside .mos are not extracted
});

test('extractMosPackage fails closed on symlinks, traversal, extended headers, and multiple roots', async () => {
  const root = `repo-${sha}`;
  const cases = [
    { archive: tarGz([{ name: `${root}/.mos/evil`, typeflag: '2', data: '' }]), code: 'CANDIDATE_CONTENTS_INVALID' }, // symlink
    { archive: tarGz([{ name: `${root}/.mos/../../etc/passwd`, data: 'x' }]), code: 'CANDIDATE_PATH_INVALID' }, // traversal
    { archive: tarGz([{ name: `${root}/.mos/manifest.json`, typeflag: 'x', data: 'pax' }]), code: 'CANDIDATE_CONTENTS_INVALID' }, // extended header
    { archive: tarGz([{ name: `${root}/.mos/a`, data: 'a' }, { name: `other-${sha}/.mos/b`, data: 'b' }]), code: 'CANDIDATE_CONTENTS_INVALID' }, // two roots
    { archive: tarGz([{ name: `${root}/.mos/notmanifest.txt`, data: 'x' }]), code: 'CANDIDATE_INVALID' }, // no manifest
  ];
  for (const { archive, code } of cases) {
    const dest = await tempDir();
    assert.throws(() => extractMosPackage(archive, dest, DEFAULT_LIMITS), { code }, code);
  }
});

test('extractMosPackage enforces the file-count and byte limits', async () => {
  const root = `repo-${sha}`;
  const dest = await tempDir();
  const tiny = { ...DEFAULT_LIMITS, maxFiles: 1 };
  assert.throws(() => extractMosPackage(tarGz([
    { name: `${root}/.mos/manifest.json`, data: validManifest }, { name: `${root}/.mos/Dockerfile`, data: 'FROM scratch\n' },
  ]), dest, tiny), { code: 'CANDIDATE_TOO_LARGE' });
});

test('downloadMosPackage pins the archive to the resolved commit and extracts it', async (t) => {
  const dest = await tempDir();
  t.after(() => fs.rmSync(dest, { force: true, recursive: true }));
  const fetchImpl = async (url) => {
    if (url === `https://codeload.github.com/community/notes/tar.gz/${sha}`) return new Response(validArchive());
    throw new Error(`unexpected ${url}`);
  };
  await downloadMosPackage(fetchImpl, { host: 'github.com', owner: 'community', repo: 'notes', sha }, dest, DEFAULT_LIMITS);
  assert.ok(fs.existsSync(path.join(dest, 'manifest.json')));
  await assert.rejects(() => downloadMosPackage(fetchImpl, { host: 'github.com', owner: 'community', repo: 'notes', sha: 'main' }, dest, DEFAULT_LIMITS), { code: 'SOURCE_REVISION_INVALID' });
});
