const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { CATALOG_REFRESH_POLICY, DEFAULT_PACKAGE_LIMITS, advisoriesForVersion, canonicalPackagePath, compareSemver, digestAppPackage, validateAdvisoryIndex, validateCatalog } = require('./package-contracts.cjs');
const { readAppPackageManifest } = require('./package-manifest.cjs');
const { AppOperationLimiter } = require('./app-operation-limits.cjs');
const { createCandidateDir, releaseCandidateDir } = require('./candidate-storage.cjs');
const { readSigningPublicKey, verifyCatalogSignature } = require('./catalog-signature.cjs');

const DEFAULT_LIMITS = Object.freeze({ catalogBytes: 1024 * 1024, timeoutMs: 10_000, ...DEFAULT_PACKAGE_LIMITS });
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

class OfficialCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function githubRepository(repository) {
  let url;
  try { url = new URL(repository); } catch { throw new OfficialCatalogError('CATALOG_SOURCE_INVALID', 'Official catalog repository must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) {
    throw new OfficialCatalogError('CATALOG_SOURCE_INVALID', 'Official catalog repository must be an uncredentialed github.com HTTPS URL.');
  }
  const parts = url.pathname.replace(/\/$/u, '').split('/').filter(Boolean);
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part))) {
    throw new OfficialCatalogError('CATALOG_SOURCE_INVALID', 'Official catalog repository must identify one GitHub owner and repository.');
  }
  return { owner: parts[0], repo: parts[1].replace(/\.git$/u, '') };
}

async function boundedResponse(response, maximumBytes) {
  if (!response.ok) throw new OfficialCatalogError('CATALOG_FETCH_FAILED', `Official catalog request failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new OfficialCatalogError('CATALOG_TOO_LARGE', 'Official catalog response exceeds the byte limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new OfficialCatalogError('CATALOG_TOO_LARGE', 'Official catalog response exceeds the byte limit.');
  return bytes;
}

class OfficialCatalogService {
  constructor({
    branch = 'main',
    fetchImpl = globalThis.fetch,
    limiter = new AppOperationLimiter(),
    limits = DEFAULT_LIMITS,
    now = () => new Date(),
    platformVersion = '0.0.0',
    random = Math.random,
    recordSecurityEvent = () => {},
    repository = 'https://github.com/rpuls/my-own-suite',
    signingPublicKey,
    stateDir,
  }) {
    this.branch = branch;
    this.fetch = fetchImpl;
    this.limiter = limiter;
    this.limits = limits;
    this.recordSecurityEvent = recordSecurityEvent;
    this.stateDir = stateDir;
    this.now = now;
    this.platformVersion = platformVersion;
    this.random = random;
    this.repository = repository;
    this.github = githubRepository(repository);
    // A MOS with no publisher key has no way to tell a catalog its publisher
    // produced from one anybody else did, and this catalog decides which
    // packages are treated as reviewed. There is no safe way to carry on
    // without it, so a release missing its key fails here rather than quietly
    // trusting whatever it is handed.
    if (!signingPublicKey) throw new OfficialCatalogError('CATALOG_SIGNING_KEY_MISSING', 'This MOS release is missing the official catalog signing key.');
    this.signingPublicKey = readSigningPublicKey(signingPublicKey);
    this.cachePath = path.join(stateDir, 'official-app-catalog.json');
    this.timer = null;
    this.failures = 0;
    this.refreshing = null;
    this.cache = this.readCache();
    this.lastAttemptedAt = this.cache?.attemptedAt || null;
    this.lastError = this.cache?.error || null;
  }

  // Signed bytes in, parsed result out. A parsed catalog cannot be re-verified —
  // re-serializing it does not reproduce what was signed — so the cache keeps the
  // text and the signature and derives everything else from them.
  verifiedText(text, signature, validate) {
    if (!verifyCatalogSignature({ bytes: text, publicKey: this.signingPublicKey, signature })) return null;
    try {
      const value = JSON.parse(text);
      return validate(value).length === 0 ? value : null;
    } catch {
      return null;
    }
  }

  // This cache is what an offline MOS decides trust from for as long as it stays
  // offline, and it sits in state rather than in the release, so it is verified
  // on the way in exactly as it was on the way out. A cache that no longer
  // verifies — tampered with, or signed by a key this release no longer carries —
  // is discarded rather than served.
  readCache() {
    try {
      const cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (cache.schemaVersion !== 2 || !COMMIT_PATTERN.test(cache.revision)) return null;
      const catalog = this.verifiedText(cache.catalogText, cache.signature, validateCatalog);
      if (!catalog) return null;
      // Advisories ride alongside the catalog but must never make a valid catalog
      // cache unusable; drop them if they no longer verify or validate.
      const advisories = cache.advisoriesText
        ? this.verifiedText(cache.advisoriesText, cache.advisoriesSignature, validateAdvisoryIndex)
        : null;
      if (advisories) return { ...cache, advisories, catalog };
      const { advisoriesRevision, advisoriesSignature, advisoriesText, ...rest } = cache;
      return { ...rest, catalog };
    } catch {}
    return null;
  }

  // The parsed catalog and advisories are derived from the signed text, so only
  // the text and its signature are persisted: writing the parsed copy too would
  // let the two disagree, and the copy nobody verified would be the convenient
  // one to read.
  writeCache(cache) {
    const { advisories, catalog, ...persistable } = cache;
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const temporary = `${this.cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(persistable, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.cachePath);
  }

  async fetchSignature(revision, name) {
    const url = `https://raw.githubusercontent.com/${this.github.owner}/${this.github.repo}/${revision}/apps/${name}.sig`;
    const response = await this.request(url);
    if (response.status === 404) {
      throw new OfficialCatalogError(
        name === 'advisories.json' ? 'ADVISORIES_SIGNATURE_MISSING' : 'CATALOG_SIGNATURE_MISSING',
        `Official ${name} signature is missing.`,
      );
    }
    return (await boundedResponse(response, 1024)).toString('utf8');
  }

  noteSecurityEvent(eventType, at) {
    try {
      this.recordSecurityEvent({
        at,
        eventType,
        subject: crypto.createHash('sha256').update(this.repository).digest('hex').slice(0, 12),
      });
    } catch {}
  }

  status() {
    const fetchedAt = this.cache?.fetchedAt || null;
    const ageMs = fetchedAt ? Math.max(0, this.now().getTime() - Date.parse(fetchedAt)) : null;
    const advisoriesFetchedAt = this.cache?.advisoriesFetchedAt || null;
    const advisoriesAgeMs = advisoriesFetchedAt ? Math.max(0, this.now().getTime() - Date.parse(advisoriesFetchedAt)) : null;
    return {
      advisories: {
        count: this.cache?.advisories?.advisories?.length ?? null,
        error: this.cache?.advisoriesError || null,
        fetchedAt: advisoriesFetchedAt,
        freshness: !advisoriesFetchedAt ? 'unavailable' : advisoriesAgeMs > CATALOG_REFRESH_POLICY.cacheStaleAfterMs ? 'stale' : 'fresh',
        revision: this.cache?.advisoriesRevision || null,
      },
      error: this.lastError,
      fetchedAt,
      freshness: !fetchedAt ? 'unavailable' : ageMs > CATALOG_REFRESH_POLICY.cacheStaleAfterMs ? 'stale' : 'fresh',
      repository: this.repository,
      revision: this.cache?.revision || null,
    };
  }

  catalog() { return this.cache?.catalog || null; }

  // Applicable official advisories for an installed/candidate version. Advisories
  // are current source-trusted metadata; they never mutate installed snapshots.
  advisoriesFor(packageId, packageVersion) {
    if (!packageId || !packageVersion) return [];
    return advisoriesForVersion(this.cache?.advisories, packageId, packageVersion);
  }

  // A revision that publishes no feed at all still means "nothing to warn about",
  // as it did before this was signed. That is the honest limit of a signature: it
  // proves who wrote what MOS was given, never that MOS was given everything, and
  // withholding a feed cannot be told apart from never having published one.
  async fetchAdvisories(revision) {
    const url = `https://raw.githubusercontent.com/${this.github.owner}/${this.github.repo}/${revision}/apps/advisories.json`;
    const response = await this.request(url);
    if (response.status === 404) return { advisories: { advisories: [], schemaVersion: 1 }, advisoriesSignature: null, advisoriesText: null };
    const advisoriesText = (await boundedResponse(response, this.limits.catalogBytes)).toString('utf8');
    const advisoriesSignature = await this.fetchSignature(revision, 'advisories.json');
    if (!verifyCatalogSignature({ bytes: advisoriesText, publicKey: this.signingPublicKey, signature: advisoriesSignature })) {
      throw new OfficialCatalogError('ADVISORIES_SIGNATURE_INVALID', 'Official advisory feed is not signed by the key this MOS release trusts.');
    }
    const index = JSON.parse(advisoriesText);
    const errors = validateAdvisoryIndex(index);
    if (errors.length) throw new OfficialCatalogError('ADVISORIES_INVALID', `Official advisory feed is invalid: ${errors.join(' ')}`);
    return { advisories: index, advisoriesSignature, advisoriesText };
  }

  async downloadCandidate(packageId) {
    const entry = this.catalog()?.packages?.[packageId];
    if (!entry || !this.cache?.revision) throw new OfficialCatalogError('CANDIDATE_UNAVAILABLE', 'That package is not available in the verified catalog cache.');
    // Bounded per package: reviewed or not, a candidate download is still one
    // file-by-file walk of a GitHub tree and a package written to disk.
    return this.limiter.runDownload(`${this.repository}#${packageId}`, () => this.performDownload(packageId, entry));
  }

  async performDownload(packageId, entry) {
    const revision = this.cache.revision;
    const candidateDir = createCandidateDir(this.stateDir, `${packageId}-`);
    let fileCount = 0;
    let packageBytes = 0;
    const visit = async (repositoryPath) => {
      const apiUrl = `https://api.github.com/repos/${this.github.owner}/${this.github.repo}/contents/${repositoryPath}?ref=${revision}`;
      const listing = JSON.parse((await boundedResponse(await this.request(apiUrl), this.limits.catalogBytes)).toString('utf8'));
      if (!Array.isArray(listing)) throw new OfficialCatalogError('CANDIDATE_CONTENTS_INVALID', 'GitHub returned invalid candidate directory metadata.');
      for (const item of listing) {
        const relativePath = String(item.path || '').slice(`${entry.path}/`.length);
        const canonical = canonicalPackagePath(relativePath);
        if (!canonical || item.path !== `${entry.path}/${canonical}`) throw new OfficialCatalogError('CANDIDATE_PATH_INVALID', 'Candidate contains a non-canonical path.');
        if (item.type === 'dir') {
          await visit(item.path);
          continue;
        }
        if (item.type !== 'file') throw new OfficialCatalogError('CANDIDATE_CONTENTS_INVALID', 'Candidate contains an unsupported repository entry.');
        fileCount += 1;
        if (fileCount > this.limits.maxFiles) throw new OfficialCatalogError('CANDIDATE_TOO_LARGE', 'Candidate exceeds the file-count limit.');
        if (!Number.isInteger(item.size) || item.size < 0 || item.size > this.limits.maxFileBytes) throw new OfficialCatalogError('CANDIDATE_TOO_LARGE', 'Candidate file exceeds the byte limit.');
        packageBytes += item.size;
        if (packageBytes > this.limits.maxPackageBytes) throw new OfficialCatalogError('CANDIDATE_TOO_LARGE', 'Candidate exceeds the package byte limit.');
        const expectedUrl = `https://raw.githubusercontent.com/${this.github.owner}/${this.github.repo}/${revision}/${item.path}`;
        if (item.download_url !== expectedUrl) throw new OfficialCatalogError('CANDIDATE_SOURCE_INVALID', 'Candidate file URL is not bound to the resolved source revision.');
        const bytes = await boundedResponse(await this.request(expectedUrl), this.limits.maxFileBytes);
        const destination = path.join(candidateDir, ...canonical.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes, { mode: 0o600 });
      }
    };
    try {
      await visit(entry.path);
      const packageDigest = digestAppPackage(candidateDir);
      if (packageDigest !== entry.packageDigest) throw new OfficialCatalogError('CANDIDATE_DIGEST_MISMATCH', 'Downloaded candidate does not match the verified catalog digest.');
      const appPackage = readAppPackageManifest(candidateDir);
      if (appPackage.manifest.id !== packageId || appPackage.manifest.version !== entry.packageVersion) throw new OfficialCatalogError('CANDIDATE_IDENTITY_MISMATCH', 'Downloaded candidate identity does not match the verified catalog.');
      return {
        ...appPackage,
        cleanup: () => releaseCandidateDir(candidateDir),
        packageDigest,
        source: { kind: 'official-git', path: entry.path, repository: this.repository, revision, trust: 'mos-reviewed' },
      };
    } catch (error) {
      releaseCandidateDir(candidateDir);
      if (error instanceof OfficialCatalogError) throw error;
      throw new OfficialCatalogError('CANDIDATE_INVALID', 'Downloaded candidate failed package validation.');
    }
  }

  // Catalog URLs are exact and pinned, so a redirect means GitHub is steering the
  // request somewhere it was not asked to go, and it is refused rather than
  // followed. A redirect is a 3xx carrying a Location, though — `304 Not Modified`
  // is a 3xx without one, and it is the expected answer to the conditional catalog
  // fetch, so it is handed back to the caller rather than mistaken for a redirect.
  async request(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    try {
      const response = await this.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mos-catalog', ...headers }, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        throw new OfficialCatalogError('CATALOG_REDIRECT_REJECTED', 'Official catalog requests must not redirect.');
      }
      return response;
    } catch (error) {
      if (error instanceof OfficialCatalogError) throw error;
      throw new OfficialCatalogError('CATALOG_FETCH_FAILED', error?.name === 'AbortError' ? 'Official catalog request timed out.' : 'Official catalog request failed.');
    } finally { clearTimeout(timer); }
  }

  // Milliseconds a freshly fetched catalog stays reusable. Zero once the window
  // has passed, and zero if the last attempt failed so a retry is never blocked.
  reusableForMs() {
    if (!this.lastAttemptedAt || this.lastError) return 0; // a failed attempt must never block its retry
    const elapsed = this.now().getTime() - Date.parse(this.lastAttemptedAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
    return Math.max(0, CATALOG_REFRESH_POLICY.reuseWindowMs - elapsed);
  }

  // Fetches the catalog from GitHub and always answers with one: joining an
  // in-flight fetch, or reusing a recent success, rather than failing.
  async refresh() {
    if (this.refreshing) return this.refreshing;
    const reusedForMs = this.reusableForMs();
    if (reusedForMs > 0) return { catalog: this.catalog(), reusedForMs, status: this.status() };
    this.refreshing = this.performRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async performRefresh() {
    const attemptedAt = this.now().toISOString();
    this.lastAttemptedAt = attemptedAt;
    try {
      const refUrl = `https://api.github.com/repos/${this.github.owner}/${this.github.repo}/commits/${encodeURIComponent(this.branch)}`;
      const ref = JSON.parse((await boundedResponse(await this.request(refUrl), this.limits.catalogBytes)).toString('utf8'));
      if (!COMMIT_PATTERN.test(String(ref.sha || ''))) throw new OfficialCatalogError('CATALOG_REVISION_INVALID', 'GitHub did not resolve the catalog branch to an immutable commit.');
      const revision = ref.sha;
      const catalogUrl = `https://raw.githubusercontent.com/${this.github.owner}/${this.github.repo}/${revision}/apps/catalog.json`;
      const response = await this.request(catalogUrl, this.cache?.revision === revision && this.cache?.etag ? { 'If-None-Match': this.cache.etag } : {});
      if (response.status === 304 && this.cache) {
        this.cache = { ...this.cache, attemptedAt, error: null, fetchedAt: attemptedAt, revision };
      } else {
        const catalogText = (await boundedResponse(response, this.limits.catalogBytes)).toString('utf8');
        // Before it is parsed, let alone believed. Whoever served these bytes had
        // to hold the publisher's key to have MOS act on them, so being able to
        // push to the repository, or to convince this box that you are GitHub, is
        // no longer enough to decide what it treats as reviewed.
        const signature = await this.fetchSignature(revision, 'catalog.json');
        if (!verifyCatalogSignature({ bytes: catalogText, publicKey: this.signingPublicKey, signature })) {
          throw new OfficialCatalogError('CATALOG_SIGNATURE_INVALID', 'Official catalog is not signed by the key this MOS release trusts.');
        }
        const catalog = JSON.parse(catalogText);
        const errors = validateCatalog(catalog);
        if (errors.length) throw new OfficialCatalogError('CATALOG_INVALID', `Official catalog is invalid: ${errors.join(' ')}`);
        this.cache = { attemptedAt, catalog, catalogText, error: null, etag: response.headers.get('etag') || null, fetchedAt: attemptedAt, revision, schemaVersion: 2, signature };
      }
      this.failures = 0;
      this.lastError = null;
      // Advisories are fetched from the same immutable revision, so they only
      // change when the revision does. A malformed or unreachable feed keeps the
      // last-known-good advisories and never fails the catalog refresh.
      if (this.cache.advisoriesRevision !== revision) {
        try {
          this.cache = { ...this.cache, ...await this.fetchAdvisories(revision), advisoriesError: null, advisoriesFetchedAt: attemptedAt, advisoriesRevision: revision };
        } catch (error) {
          // An advisory feed that does not verify is not a feed MOS may act on,
          // but withholding advisories is exactly what suppressing them looks
          // like, so it is counted rather than only swallowed.
          const safeError = { code: error.code || 'ADVISORIES_FETCH_FAILED', message: error.message || 'Official advisory refresh failed.' };
          this.cache = { ...this.cache, advisoriesError: safeError };
          if (['ADVISORIES_SIGNATURE_INVALID', 'ADVISORIES_SIGNATURE_MISSING'].includes(error?.code)) {
            this.noteSecurityEvent('app-catalog-signature-invalid', attemptedAt);
          }
        }
      }
      this.writeCache(this.cache);
      return { catalog: this.catalog(), reusedForMs: 0, status: this.status() };
    } catch (error) {
      this.failures += 1;
      const safeError = { code: error.code || 'CATALOG_FETCH_FAILED', message: error.message || 'Official catalog refresh failed.' };
      this.lastError = safeError;
      // A catalog that cannot refresh is a MOS that has stopped learning which
      // installed packages have advisories against them. That is quiet by
      // nature: the last-known-good cache keeps serving and nothing looks wrong,
      // so it is worth a durable count rather than only a status field the owner
      // has to think to look at. Counted per configured catalog repository by
      // digest, not by URL, and never allowed to replace the refresh failure.
      //
      // A signature that does not verify is kept apart from a refresh that did
      // not happen: one says the network is down, the other says something served
      // this box a catalog its publisher did not sign, and reading them as the
      // same number would bury the second under the first.
      this.noteSecurityEvent(error?.code === 'CATALOG_SIGNATURE_INVALID' ? 'app-catalog-signature-invalid' : 'app-catalog-refresh-failed', attemptedAt);
      if (this.cache) {
        this.cache = { ...this.cache, attemptedAt, error: safeError };
        this.writeCache(this.cache);
      }
      throw Object.assign(error, { catalogStatus: this.status() });
    }
  }

  updateFor(packageId, instance) {
    const candidate = this.catalog()?.packages?.[packageId] || null;
    if (!candidate) return { available: null, installed: instance ? { packageDigest: instance.packageDigest, packageVersion: instance.packageVersion } : null, status: instance ? 'not-in-catalog' : 'unavailable' };
    const available = {
      ...candidate,
      compatibility: compareSemver(this.platformVersion, candidate.minimumMosVersion) >= 0 ? 'compatible' : 'requires-platform-update',
      sourceRevision: this.cache.revision,
    };
    if (!instance) return { available, installed: null, status: 'installable' };
    const installed = { packageDigest: instance.packageDigest, packageVersion: instance.packageVersion };
    // Version alone decides this, never the digest. An official app is installed
    // from the checkout on this box, not downloaded from the catalog, so the
    // installed digest describes whatever contents that checkout held while the
    // catalog digest describes the catalog branch's tip. The two are equal only
    // when the checkout happens to sit exactly on that tip, which is false for
    // every box pinned to a release tag and every box tracking a branch. Reading
    // their inequality as a tampering signal reported the ordinary case as a
    // fault. The digest is still what an update is verified against, at the point
    // MOS actually downloads candidate bytes to apply (see downloadCandidate),
    // where there is a real reference to compare to.
    const comparison = compareSemver(candidate.packageVersion, instance.packageVersion);
    const status = comparison > 0 ? 'update-available'
      : comparison < 0 ? 'installed-newer'
        : 'current';
    return { available, installed, status };
  }

  schedule() {
    if (this.timer) return;
    const base = this.failures ? Math.min(CATALOG_REFRESH_POLICY.backoffInitialMs * (2 ** (this.failures - 1)), CATALOG_REFRESH_POLICY.backoffMaximumMs) : CATALOG_REFRESH_POLICY.catalogIntervalMs;
    const delay = Math.round(base * (1 + ((this.random() * 2) - 1) * CATALOG_REFRESH_POLICY.jitterRatio));
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await this.refresh(); } catch {}
      this.schedule();
    }, delay);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

module.exports = { OfficialCatalogError, OfficialCatalogService, githubRepository };
