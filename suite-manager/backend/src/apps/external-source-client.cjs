const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_PACKAGE_LIMITS, canonicalPackagePath, digestAppPackage } = require('./package-contracts.cjs');
const { readAppPackageManifest } = require('./package-manifest.cjs');
const { githubRepository } = require('./official-catalog-service.cjs');
const { ExternalSourceError, instanceNamespaceId, sourceInstallable, validateExternalCandidate, withRevision } = require('./external-source-registry.cjs');

const DEFAULT_LIMITS = Object.freeze({ catalogBytes: 1024 * 1024, timeoutMs: 10_000, ...DEFAULT_PACKAGE_LIMITS });
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

async function boundedResponse(response, maximumBytes) {
  if (!response.ok) throw new ExternalSourceError('SOURCE_FETCH_FAILED', `External source request failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new ExternalSourceError('SOURCE_TOO_LARGE', 'External source response exceeds the byte limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new ExternalSourceError('SOURCE_TOO_LARGE', 'External source response exceeds the byte limit.');
  return bytes;
}

// Downloads a candidate package from an owner-added external Git source and runs
// it through the constrained external-candidate gate before any build/apply can
// consume it. This is the external counterpart of OfficialCatalogService's
// download path: same revision-bound fetch, path allowlist, digest, and manifest
// validation, but the resulting candidate is never mos-reviewed and must pass the
// constrained capability profile and non-impersonation checks to be returned.
class ExternalSourceClient {
  constructor({ fetchImpl = globalThis.fetch, limits = DEFAULT_LIMITS, officialPackageIds = [], platformVersion = '0.0.0', stateDir }) {
    this.fetch = fetchImpl;
    this.limits = limits;
    this.officialPackageIds = officialPackageIds;
    this.platformVersion = platformVersion;
    this.stateDir = stateDir;
  }

  github(source) {
    try { return githubRepository(source?.repository); }
    catch { throw new ExternalSourceError('SOURCE_URL_INVALID', 'External source must be an uncredentialed github.com repository URL.'); }
  }

  async request(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    try {
      const response = await this.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mos-v2-external-source', ...headers }, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new ExternalSourceError('SOURCE_REDIRECT_REJECTED', 'External source requests must not redirect.');
      return response;
    } catch (error) {
      if (error instanceof ExternalSourceError) throw error;
      throw new ExternalSourceError('SOURCE_FETCH_FAILED', error?.name === 'AbortError' ? 'External source request timed out.' : 'External source request failed.');
    } finally { clearTimeout(timer); }
  }

  // Resolve the source's configured branch to an immutable commit and bind it to
  // the record. Candidate files are only trusted after the revision is resolved.
  async resolveRevision(source, ref = 'main') {
    const github = this.github(source);
    const refUrl = `https://api.github.com/repos/${github.owner}/${github.repo}/commits/${encodeURIComponent(ref)}`;
    const commit = JSON.parse((await boundedResponse(await this.request(refUrl), this.limits.catalogBytes)).toString('utf8'));
    if (!COMMIT_PATTERN.test(String(commit.sha || ''))) throw new ExternalSourceError('SOURCE_REVISION_INVALID', 'External source did not resolve the branch to an immutable commit.');
    return withRevision(source, commit.sha);
  }

  // Download a package from a resolved external source into an isolated temporary
  // directory, verify its contents, and fail closed through the constrained
  // external-candidate gate. A returned candidate is always non-official, carries
  // its resolved unverified/publisher-signed trust, and has a source-namespaced
  // instance id so it can never impersonate or collide with an official package.
  async downloadCandidate(source, packageId) {
    if (!sourceInstallable(source)) throw new ExternalSourceError('SOURCE_NOT_INSTALLABLE', 'New installs are only allowed from an active source.');
    if (!COMMIT_PATTERN.test(String(source?.revision || ''))) throw new ExternalSourceError('SOURCE_REVISION_INVALID', 'Resolve the source revision before downloading a candidate.');
    const github = this.github(source);
    const revision = source.revision;
    const entryPath = `${source.catalogPath}/${packageId}`;
    const candidateRoot = path.join(this.stateDir, 'external-app-candidates');
    fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
    const candidateDir = fs.mkdtempSync(path.join(candidateRoot, `${packageId}-`));
    let fileCount = 0;
    let packageBytes = 0;
    const visit = async (repositoryPath) => {
      const apiUrl = `https://api.github.com/repos/${github.owner}/${github.repo}/contents/${repositoryPath}?ref=${revision}`;
      const listing = JSON.parse((await boundedResponse(await this.request(apiUrl), this.limits.catalogBytes)).toString('utf8'));
      if (!Array.isArray(listing)) throw new ExternalSourceError('CANDIDATE_CONTENTS_INVALID', 'External source returned invalid candidate directory metadata.');
      for (const item of listing) {
        const relativePath = String(item.path || '').slice(`${entryPath}/`.length);
        const canonical = canonicalPackagePath(relativePath);
        if (!canonical || item.path !== `${entryPath}/${canonical}`) throw new ExternalSourceError('CANDIDATE_PATH_INVALID', 'Candidate contains a non-canonical path.');
        if (item.type === 'dir') { await visit(item.path); continue; }
        if (item.type !== 'file') throw new ExternalSourceError('CANDIDATE_CONTENTS_INVALID', 'Candidate contains an unsupported repository entry.');
        fileCount += 1;
        if (fileCount > this.limits.maxFiles) throw new ExternalSourceError('CANDIDATE_TOO_LARGE', 'Candidate exceeds the file-count limit.');
        if (!Number.isInteger(item.size) || item.size < 0 || item.size > this.limits.maxFileBytes) throw new ExternalSourceError('CANDIDATE_TOO_LARGE', 'Candidate file exceeds the byte limit.');
        packageBytes += item.size;
        if (packageBytes > this.limits.maxPackageBytes) throw new ExternalSourceError('CANDIDATE_TOO_LARGE', 'Candidate exceeds the package byte limit.');
        const expectedUrl = `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${revision}/${item.path}`;
        if (item.download_url !== expectedUrl) throw new ExternalSourceError('CANDIDATE_SOURCE_INVALID', 'Candidate file URL is not bound to the resolved source revision.');
        const bytes = await boundedResponse(await this.request(expectedUrl), this.limits.maxFileBytes);
        const destination = path.join(candidateDir, ...canonical.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes, { mode: 0o600 });
      }
    };
    try {
      await visit(entryPath);
      const packageDigest = digestAppPackage(candidateDir);
      const appPackage = readAppPackageManifest(candidateDir);
      const candidateSource = { kind: 'external-git', path: entryPath, repository: source.repository, revision, trust: source.trust };
      const gate = validateExternalCandidate({ manifest: appPackage.manifest, officialPackageIds: this.officialPackageIds, platformVersion: this.platformVersion, source: candidateSource });
      const errors = [...gate.errors];
      if (appPackage.manifest.id !== packageId) errors.push('candidate manifest id does not match the requested package.');
      if (errors.length) throw new ExternalSourceError('CANDIDATE_REJECTED', `External candidate failed validation: ${errors.join(' ')}`);
      return {
        ...appPackage,
        cleanup: () => fs.rmSync(candidateDir, { force: true, recursive: true }),
        instanceId: instanceNamespaceId(source, packageId),
        packageDigest,
        permissions: gate.permissions,
        source: candidateSource,
        trust: source.trust,
      };
    } catch (error) {
      fs.rmSync(candidateDir, { force: true, recursive: true });
      throw error instanceof ExternalSourceError ? error : new ExternalSourceError('CANDIDATE_INVALID', 'Downloaded external candidate failed package validation.');
    }
  }
}

module.exports = { ExternalSourceClient };
