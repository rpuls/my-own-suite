const fs = require('node:fs');
const path = require('node:path');

const { CATALOG_REFRESH_POLICY, compareSemver, validateCatalog } = require('./package-contracts.cjs');

const DEFAULT_LIMITS = Object.freeze({ catalogBytes: 1024 * 1024, timeoutMs: 10_000 });
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
    limits = DEFAULT_LIMITS,
    now = () => new Date(),
    platformVersion = '0.0.0',
    random = Math.random,
    repository = 'https://github.com/rpuls/my-own-suite',
    stateDir,
  }) {
    this.branch = branch;
    this.fetch = fetchImpl;
    this.limits = limits;
    this.now = now;
    this.platformVersion = platformVersion;
    this.random = random;
    this.repository = repository;
    this.github = githubRepository(repository);
    this.cachePath = path.join(stateDir, 'official-app-catalog.json');
    this.timer = null;
    this.failures = 0;
    this.lastAttemptedAt = this.cache?.attemptedAt || null;
    this.lastError = this.cache?.error || null;
    this.refreshing = null;
    this.cache = this.readCache();
  }

  readCache() {
    try {
      const cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (cache.schemaVersion === 1 && COMMIT_PATTERN.test(cache.revision) && validateCatalog(cache.catalog).length === 0) return cache;
    } catch {}
    return null;
  }

  writeCache(cache) {
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const temporary = `${this.cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.cachePath);
  }

  status() {
    const fetchedAt = this.cache?.fetchedAt || null;
    const ageMs = fetchedAt ? Math.max(0, this.now().getTime() - Date.parse(fetchedAt)) : null;
    return {
      error: this.lastError,
      fetchedAt,
      freshness: !fetchedAt ? 'unavailable' : ageMs > CATALOG_REFRESH_POLICY.cacheStaleAfterMs ? 'stale' : 'fresh',
      repository: this.repository,
      revision: this.cache?.revision || null,
    };
  }

  catalog() { return this.cache?.catalog || null; }

  async request(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    try {
      const response = await this.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mos-v2-catalog', ...headers }, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new OfficialCatalogError('CATALOG_REDIRECT_REJECTED', 'Official catalog requests must not redirect.');
      return response;
    } catch (error) {
      if (error instanceof OfficialCatalogError) throw error;
      throw new OfficialCatalogError('CATALOG_FETCH_FAILED', error?.name === 'AbortError' ? 'Official catalog request timed out.' : 'Official catalog request failed.');
    } finally { clearTimeout(timer); }
  }

  async refresh({ manual = false } = {}) {
    if (this.refreshing) return this.refreshing;
    if (manual && this.lastAttemptedAt && this.now().getTime() - Date.parse(this.lastAttemptedAt) < CATALOG_REFRESH_POLICY.manualMinimumIntervalMs) {
      throw new OfficialCatalogError('CATALOG_REFRESH_THROTTLED', 'Wait briefly before refreshing the app catalog again.');
    }
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
        const catalog = JSON.parse((await boundedResponse(response, this.limits.catalogBytes)).toString('utf8'));
        const errors = validateCatalog(catalog);
        if (errors.length) throw new OfficialCatalogError('CATALOG_INVALID', `Official catalog is invalid: ${errors.join(' ')}`);
        this.cache = { attemptedAt, catalog, error: null, etag: response.headers.get('etag') || null, fetchedAt: attemptedAt, revision, schemaVersion: 1 };
      }
      this.failures = 0;
      this.lastError = null;
      this.writeCache(this.cache);
      return { catalog: this.catalog(), status: this.status() };
    } catch (error) {
      this.failures += 1;
      const safeError = { code: error.code || 'CATALOG_FETCH_FAILED', message: error.message || 'Official catalog refresh failed.' };
      this.lastError = safeError;
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
    const comparison = compareSemver(candidate.packageVersion, instance.packageVersion);
    const status = comparison > 0 ? 'update-available'
      : comparison === 0 && candidate.packageDigest !== instance.packageDigest ? 'integrity-error'
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
