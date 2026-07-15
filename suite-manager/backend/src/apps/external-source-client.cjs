const { digestAppPackage } = require('./package-contracts.cjs');
const { readAppPackageManifest } = require('./package-manifest.cjs');
const { AppOperationLimiter } = require('./app-operation-limits.cjs');
const { createCandidateDir, releaseCandidateDir } = require('./candidate-storage.cjs');
const { COMMIT_PATTERN, DEFAULT_LIMITS, downloadMosPackage, parseGitPackageUrl, resolveCommit } = require('./git-archive-source.cjs');
const { ExternalSourceError, instanceNamespaceId, sourceInstallable, validateExternalCandidate, withRevision } = require('./external-source-registry.cjs');

// The catalog path for an external package is fixed by the `.mos/` convention.
const EXTERNAL_PACKAGE_DIR = '.mos';

// Downloads an owner-added external package and runs it through the constrained
// external-candidate gate before any build/apply can consume it. The package is
// identified by its repository alone: MOS resolves the repo to an immutable
// commit, fetches a provider-neutral archive, extracts only `.mos/`, and learns
// the package id from the extracted manifest. The resulting candidate is never
// mos-reviewed and must pass the constrained capability profile and
// non-impersonation checks to be returned.
class ExternalSourceClient {
  constructor({ fetchImpl = globalThis.fetch, limiter = new AppOperationLimiter(), limits = DEFAULT_LIMITS, now = () => new Date(), officialPackageIds = [], platformVersion = '0.0.0', recordSecurityEvent = () => {}, stateDir }) {
    this.fetch = fetchImpl;
    this.limiter = limiter;
    this.limits = limits;
    this.now = now;
    this.officialPackageIds = officialPackageIds;
    this.platformVersion = platformVersion;
    this.recordSecurityEvent = recordSecurityEvent;
    this.stateDir = stateDir;
  }

  // A source serving a package the gate refuses is worth counting: one rejection
  // is an owner pasting the wrong repository, but the same source doing it over
  // and over is the shape of a repository that has been taken over or force-
  // pushed, and every rejection today is only an error shown to whoever asked.
  //
  // The source is identified by its id, which is a digest of the normalized
  // repository, so no URL — and therefore no credential and no query string —
  // reaches the record even though this holds a URL while it runs. Recording is
  // never allowed to turn a refusal into a different failure.
  noteSourceEvent(eventType, source) {
    try {
      if (source?.id) this.recordSecurityEvent({ at: this.now().toISOString(), eventType, subject: source.id });
    } catch {}
  }

  // Resolve the source repository's branch/tag (or default branch) to an
  // immutable commit and bind it to the record. Package files are only trusted
  // after the revision is resolved.
  async resolveRevision(source, ref = null) {
    const coordinates = parseGitPackageUrl(source.repository);
    const sha = await resolveCommit(this.fetch, { ...coordinates, ref: ref || coordinates.ref }, this.limits);
    return withRevision(source, sha);
  }

  // Download the `.mos/` package from a resolved external source into an isolated
  // temporary directory and fail closed through the constrained external-candidate
  // gate. A returned candidate is always non-official, carries its resolved
  // unverified/publisher-signed trust, and has a source-namespaced instance id so
  // it can never impersonate or collide with an official package.
  async downloadCandidate(source) {
    if (!sourceInstallable(source)) throw new ExternalSourceError('SOURCE_NOT_INSTALLABLE', 'New installs are only allowed from an active source.');
    if (!COMMIT_PATTERN.test(String(source?.revision || ''))) throw new ExternalSourceError('SOURCE_REVISION_INVALID', 'Resolve the source revision before downloading a candidate.');
    // Bounded per repository: a pasted URL is owner-supplied and every preview,
    // install, and update check downloads a fresh archive from it.
    try {
      return await this.limiter.runDownload(source.repository, () => this.performDownload(source));
    } catch (error) {
      // Both are things this source did. `APP_DOWNLOAD_BUSY` is deliberately not
      // counted: that bound is host-wide, so tripping it says only that MOS was
      // busy with other sources, which is not this one's behaviour.
      if (error?.code === 'APP_DOWNLOAD_THROTTLED') this.noteSourceEvent('app-source-download-throttled', source);
      if (error?.code === 'CANDIDATE_REJECTED' || error?.code === 'CANDIDATE_INVALID') {
        this.noteSourceEvent('app-source-candidate-rejected', source);
      }
      throw error;
    }
  }

  async performDownload(source) {
    const coordinates = parseGitPackageUrl(source.repository);
    // Download into the same host-owned candidate root the official update flow
    // uses, because the app agent only accepts snapshot sources confined to it.
    const candidateDir = createCandidateDir(this.stateDir, 'ext-');
    try {
      await downloadMosPackage(this.fetch, { ...coordinates, sha: source.revision }, candidateDir, this.limits);
      const packageDigest = digestAppPackage(candidateDir);
      const appPackage = readAppPackageManifest(candidateDir);
      const packageId = appPackage.manifest.id;
      const candidateSource = { kind: 'external-git', path: EXTERNAL_PACKAGE_DIR, repository: source.repository, revision: source.revision, trust: source.trust };
      const gate = validateExternalCandidate({ manifest: appPackage.manifest, officialPackageIds: this.officialPackageIds, platformVersion: this.platformVersion, source: candidateSource });
      if (gate.errors.length) throw new ExternalSourceError('CANDIDATE_REJECTED', `External candidate failed validation: ${gate.errors.join(' ')}`);
      // The collision-safe id every MOS-side identity (instance row, containers,
      // volumes, routes, build context) uses for this package. Without it the
      // package could not be isolated from an official id, so fail closed.
      const namespaced = instanceNamespaceId(source, packageId);
      if (!namespaced) throw new ExternalSourceError('CANDIDATE_REJECTED', 'External candidate failed validation: the package id cannot be namespaced for this source.');
      return {
        ...appPackage,
        cleanup: () => releaseCandidateDir(candidateDir),
        namespacedPackageId: namespaced,
        packageDigest,
        packageId,
        permissions: gate.permissions,
        source: candidateSource,
        trust: source.trust,
      };
    } catch (error) {
      releaseCandidateDir(candidateDir);
      throw error instanceof ExternalSourceError ? error : new ExternalSourceError('CANDIDATE_INVALID', 'Downloaded external candidate failed package validation.');
    }
  }
}

module.exports = { ExternalSourceClient };
