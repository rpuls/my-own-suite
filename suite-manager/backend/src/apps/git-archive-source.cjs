const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { DEFAULT_PACKAGE_LIMITS, canonicalPackagePath } = require('./package-contracts.cjs');
const { ExternalSourceError } = require('./external-source-registry.cjs');

// A published external app package lives in a `.mos/` folder at the root of its
// git repository. MOS identifies a package by its repository URL alone (one repo
// = one app), fetches a provider-neutral gzip archive of the repo at an immutable
// commit, and extracts only `.mos/` through a hardened reader. Git hosts are
// restricted to a small allowlist so a pasted URL cannot point at an arbitrary
// or credentialed endpoint.
//
// Only github.com is enabled to begin with. The download/extract pipeline is
// host-agnostic; adding gitlab.com or codeberg.org later is one HOST_DESCRIPTORS
// entry (repo-info + ref→commit endpoints and a direct archive URL) plus tests.

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  metadataBytes: 1024 * 1024,
  timeoutMs: 15_000,
  ...DEFAULT_PACKAGE_LIMITS,
});

// Per-host descriptors. Every host exposes: a repo-info endpoint (to learn the
// default branch), a ref→commit endpoint (to pin an immutable revision before
// any file is trusted), and a direct archive URL that does not redirect.
const HOST_DESCRIPTORS = Object.freeze({
  'github.com': {
    archiveUrl: (owner, repo, sha) => `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`,
    commitSha: (json) => json?.sha,
    commitUrl: (owner, repo, ref) => `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    defaultBranch: (json) => json?.default_branch,
    repoInfoUrl: (owner, repo) => `https://api.github.com/repos/${owner}/${repo}`,
  },
});

const ALLOWED_HOSTS = Object.freeze(Object.keys(HOST_DESCRIPTORS));

// Parse a pasted repository URL into `{ host, owner, repo, ref }`. Accepts a bare
// repo URL (default branch) or an explicit `/tree/<ref>` branch/tag link. The
// host must be on the allowlist; credentials and non-HTTPS are rejected.
function parseGitPackageUrl(input) {
  let url;
  try { url = new URL(String(input)); } catch { throw new ExternalSourceError('SOURCE_URL_INVALID', 'Paste a valid repository URL.'); }
  if (url.protocol !== 'https:') throw new ExternalSourceError('SOURCE_URL_INVALID', 'Repository URLs must use HTTPS.');
  if (url.username || url.password) throw new ExternalSourceError('SOURCE_URL_INVALID', 'Repository URLs must not embed credentials.');
  if (!HOST_DESCRIPTORS[url.hostname]) throw new ExternalSourceError('SOURCE_URL_INVALID', `Only ${ALLOWED_HOSTS.join(', ')} repositories are supported.`);
  const parts = url.pathname.replace(/\/+$/u, '').split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (parts.length < 2) throw new ExternalSourceError('SOURCE_URL_INVALID', 'Link to a repository, e.g. https://github.com/owner/repo.');
  const [owner, repoRaw, ...rest] = parts;
  const repo = repoRaw.replace(/\.git$/u, '');
  if (!SEGMENT_PATTERN.test(owner) || !SEGMENT_PATTERN.test(repo)) throw new ExternalSourceError('SOURCE_URL_INVALID', 'That does not look like an owner/repository URL.');
  let ref = null;
  if (rest.length) {
    if (rest[0] === 'tree' && rest[1]) ref = rest.slice(1).join('/');
    else throw new ExternalSourceError('SOURCE_URL_INVALID', 'Link to the repository or a specific branch/tag.');
  }
  return { host: url.hostname, owner, ref, repo, repository: `https://${url.hostname}/${owner}/${repo}` };
}

function repoCoordinates(repository) {
  return parseGitPackageUrl(repository);
}

async function request(fetchImpl, url, { timeoutMs }, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'mos-external-source', ...headers }, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) throw new ExternalSourceError('SOURCE_REDIRECT_REJECTED', 'External source requests must not redirect.');
    if (!response.ok) throw new ExternalSourceError('SOURCE_FETCH_FAILED', `External source request failed with HTTP ${response.status}.`);
    return response;
  } catch (error) {
    if (error instanceof ExternalSourceError) throw error;
    throw new ExternalSourceError('SOURCE_FETCH_FAILED', error?.name === 'AbortError' ? 'External source request timed out.' : 'External source request failed.');
  } finally { clearTimeout(timer); }
}

async function boundedBytes(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new ExternalSourceError('SOURCE_TOO_LARGE', 'External source response exceeds the byte limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new ExternalSourceError('SOURCE_TOO_LARGE', 'External source response exceeds the byte limit.');
  return bytes;
}

async function requestJson(fetchImpl, url, limits) {
  const bytes = await boundedBytes(await request(fetchImpl, url, limits), limits.metadataBytes);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new ExternalSourceError('SOURCE_FETCH_FAILED', 'External source returned invalid metadata.'); }
}

// Resolve a repository ref (or the default branch) to an immutable commit before
// any archive content is trusted.
async function resolveCommit(fetchImpl, { host, owner, ref, repo }, limits = DEFAULT_LIMITS) {
  const descriptor = HOST_DESCRIPTORS[host];
  if (!descriptor) throw new ExternalSourceError('SOURCE_URL_INVALID', 'This git host is not supported.');
  let targetRef = ref;
  if (!targetRef) {
    const info = await requestJson(fetchImpl, descriptor.repoInfoUrl(owner, repo), limits);
    targetRef = descriptor.defaultBranch(info);
    if (!targetRef) throw new ExternalSourceError('SOURCE_REVISION_INVALID', 'Could not determine the repository default branch.');
  }
  const sha = descriptor.commitSha(await requestJson(fetchImpl, descriptor.commitUrl(owner, repo, targetRef), limits));
  if (!COMMIT_PATTERN.test(String(sha || ''))) throw new ExternalSourceError('SOURCE_REVISION_INVALID', 'The git host did not resolve the ref to an immutable commit.');
  return sha;
}

function readString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

function parseOctal(buffer) {
  let digits = '';
  for (const byte of buffer) {
    if (byte === 0 || byte === 0x20) { if (digits) break; continue; }
    digits += String.fromCharCode(byte);
  }
  if (!digits) return 0;
  if (!/^[0-7]+$/u.test(digits)) return -1;
  return Number.parseInt(digits, 8);
}

// Minimal, defensive ustar reader. It never follows links or honours per-file
// extended headers; unexpected entry types fail closed at the extractor.
function readTarEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = parseOctal(header.subarray(124, 136));
    if (size < 0) throw new ExternalSourceError('CANDIDATE_CONTENTS_INVALID', 'Archive contains an unreadable entry size.');
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new ExternalSourceError('CANDIDATE_CONTENTS_INVALID', 'Archive entry exceeds the archive bounds.');
    entries.push({ data: buffer.subarray(dataStart, dataEnd), name: prefix ? `${prefix}/${name}` : name, typeflag });
    offset = dataStart + (Math.ceil(size / 512) * 512);
  }
  return entries;
}

// Extract only `<root>/.mos/**` from a repo archive into destDir, which becomes
// the package directory. Rejects links, devices, extended headers, traversal,
// absolute paths, multiple roots, and anything over the file/byte limits.
function extractMosPackage(archiveBytes, destDir, limits = DEFAULT_LIMITS) {
  let tar;
  try { tar = zlib.gunzipSync(archiveBytes, { maxOutputLength: limits.maxPackageBytes }); }
  catch { throw new ExternalSourceError('CANDIDATE_TOO_LARGE', 'The repository archive is too large or not a valid gzip archive.'); }
  let root = null;
  let fileCount = 0;
  let totalBytes = 0;
  let written = 0;
  for (const entry of readTarEntries(tar)) {
    if (entry.typeflag === 'g') continue; // pax global header (e.g. GitHub commit metadata)
    if (entry.typeflag === 'x') throw new ExternalSourceError('CANDIDATE_CONTENTS_INVALID', 'Archive uses unsupported extended headers.');
    if (!['0', '5'].includes(entry.typeflag)) throw new ExternalSourceError('CANDIDATE_CONTENTS_INVALID', 'Archive contains a link, device, or other unsupported entry.');
    const name = entry.name.replace(/\/+$/u, '');
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) throw new ExternalSourceError('CANDIDATE_PATH_INVALID', 'Archive contains an unsafe path.');
    const segments = name.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..')) throw new ExternalSourceError('CANDIDATE_PATH_INVALID', 'Archive contains a path-traversal entry.');
    if (root === null) root = segments[0];
    if (segments[0] !== root) throw new ExternalSourceError('CANDIDATE_CONTENTS_INVALID', 'Archive contains more than one root directory.');
    if (segments[1] !== '.mos') continue;
    if (entry.typeflag === '5') continue; // directories are created implicitly from file paths
    const relative = segments.slice(2).join('/');
    if (!relative) continue;
    const canonical = canonicalPackagePath(relative);
    if (!canonical) throw new ExternalSourceError('CANDIDATE_PATH_INVALID', `Archive contains a non-canonical .mos path: ${relative}.`);
    fileCount += 1;
    if (fileCount > limits.maxFiles) throw new ExternalSourceError('CANDIDATE_TOO_LARGE', 'The package exceeds the file-count limit.');
    if (entry.data.length > limits.maxFileBytes) throw new ExternalSourceError('CANDIDATE_TOO_LARGE', 'A package file exceeds the byte limit.');
    totalBytes += entry.data.length;
    if (totalBytes > limits.maxPackageBytes) throw new ExternalSourceError('CANDIDATE_TOO_LARGE', 'The package exceeds the byte limit.');
    const target = path.join(destDir, ...canonical.split('/'));
    const containment = path.relative(destDir, target);
    if (containment.startsWith('..') || path.isAbsolute(containment)) throw new ExternalSourceError('CANDIDATE_PATH_INVALID', 'Archive entry escapes the package directory.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { mode: 0o600 });
    written += 1;
  }
  if (!written || !fs.existsSync(path.join(destDir, 'manifest.json'))) {
    throw new ExternalSourceError('CANDIDATE_INVALID', 'The repository does not contain a .mos app package.');
  }
}

// Download the repo archive at a resolved commit and materialize its `.mos/`
// package into destDir.
async function downloadMosPackage(fetchImpl, { host, owner, repo, sha }, destDir, limits = DEFAULT_LIMITS) {
  const descriptor = HOST_DESCRIPTORS[host];
  if (!descriptor) throw new ExternalSourceError('SOURCE_URL_INVALID', 'This git host is not supported.');
  if (!COMMIT_PATTERN.test(String(sha || ''))) throw new ExternalSourceError('SOURCE_REVISION_INVALID', 'Resolve the repository revision before downloading it.');
  const archive = await boundedBytes(await request(fetchImpl, descriptor.archiveUrl(owner, repo, sha), limits, { Accept: 'application/gzip' }), limits.maxArchiveBytes);
  extractMosPackage(archive, destDir, limits);
}

module.exports = {
  ALLOWED_HOSTS,
  COMMIT_PATTERN,
  DEFAULT_LIMITS,
  HOST_DESCRIPTORS,
  downloadMosPackage,
  extractMosPackage,
  parseGitPackageUrl,
  repoCoordinates,
  resolveCommit,
};
