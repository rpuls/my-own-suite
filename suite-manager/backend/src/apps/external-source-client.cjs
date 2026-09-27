const fs = require('node:fs');
const path = require('node:path');

const { digestAppPackage } = require('./package-contracts.cjs');
const { MANIFEST_FILENAME, validateAppPackageManifest } = require('./package-manifest.cjs');
const { AppOperationLimiter } = require('./app-operation-limits.cjs');
const { createCandidateDir, releaseCandidateDir } = require('./candidate-storage.cjs');
const { COMMIT_PATTERN, DEFAULT_LIMITS, downloadMosPackage, parseGitPackageUrl, resolveCommit } = require('./git-archive-source.cjs');
const { ExternalSourceError, instanceNamespaceId, sourceInstallable, validateExternalCandidate, withRevision } = require('./external-source-registry.cjs');

// The catalog path for an external source is fixed by the `.mos/` convention. It
// stays the same for every package a source publishes, because it identifies the
// *source*: that is what ties a repository's installed apps back to one registry
// record instead of one record per package.
const EXTERNAL_PACKAGE_DIR = '.mos';

// Downloads an owner-added external source and runs everything it publishes
// through the constrained external-candidate gate before any build/apply can
// consume it. A source is identified by its repository alone: MOS resolves the
// repo to an immutable commit, fetches a provider-neutral archive, extracts only
// `.mos/`, and learns each package's id from its own extracted manifest. The
// resulting candidates are never mos-reviewed and must pass the constrained
// capability profile and non-impersonation checks to be installable.
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

  // Bounded per repository, because a pasted URL is owner-supplied and every
  // listing, preview, install, and update check downloads a fresh archive from it.
  // Both entry points below run through here so a source that misbehaves is
  // counted the same way whichever one provoked it.
  async runBounded(source, work) {
    if (!sourceInstallable(source)) throw new ExternalSourceError('SOURCE_NOT_INSTALLABLE', 'New installs are only allowed from an active source.');
    if (!COMMIT_PATTERN.test(String(source?.revision || ''))) throw new ExternalSourceError('SOURCE_REVISION_INVALID', 'Resolve the source revision before downloading a candidate.');
    try {
      return await this.limiter.runDownload(source.repository, work);
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

  // Everything a resolved source publishes, each package described and validated
  // on its own. The caller owns `cleanup` and must run it once it has finished
  // reading the package directories, exactly as it does for a single candidate.
  async listPackages(source) {
    return this.runBounded(source, () => this.performDownload(source));
  }

  // Download the `.mos/` folder from a resolved external source into an isolated
  // temporary directory and fail closed through the constrained external-candidate
  // gate. A returned candidate is always non-official, carries its resolved
  // unverified trust, and has a source-namespaced instance id so it can never
  // impersonate or collide with an official package.
  async downloadCandidate(source, { packageId = null } = {}) {
    return this.runBounded(source, () => this.selectCandidate(source, packageId));
  }

  // Resolve exactly one installable candidate. The package must be named whenever
  // the source publishes more than one: choosing on the owner's behalf would make
  // an install's identity depend on directory order.
  async selectCandidate(source, packageId) {
    const download = await this.performDownload(source);
    try {
      const wanted = packageId
        ? download.packages.find((entry) => entry.namespacedPackageId === packageId)
        : (download.packages.length === 1 ? download.packages[0] : null);
      if (!wanted) {
        throw packageId
          ? new ExternalSourceError('SOURCE_PACKAGE_NOT_FOUND', 'This source does not publish that app package.')
          : new ExternalSourceError('SOURCE_PACKAGE_REQUIRED', 'This source publishes more than one app package; name the one to install.');
      }
      if (wanted.errors.length) {
        throw new ExternalSourceError('CANDIDATE_REJECTED', `External candidate failed validation: ${wanted.errors.join(' ')}`);
      }
      return { ...wanted, cleanup: download.cleanup };
    } catch (error) {
      download.cleanup();
      throw error;
    }
  }

  async performDownload(source) {
    const coordinates = parseGitPackageUrl(source.repository);
    // Download into the same host-owned candidate root the official update flow
    // uses, because the app agent only accepts snapshot sources confined to it.
    // A package in a multi-package source is a subdirectory of that dir, which is
    // still confined, so the agent needs to know nothing about the layout.
    const candidateDir = createCandidateDir(this.stateDir, 'ext-');
    try {
      const found = await downloadMosPackage(this.fetch, { ...coordinates, sha: source.revision }, candidateDir, this.limits);
      return {
        candidateDir,
        cleanup: () => releaseCandidateDir(candidateDir),
        packages: found.map((entry) => this.readPackage(source, entry)),
      };
    } catch (error) {
      releaseCandidateDir(candidateDir);
      throw error instanceof ExternalSourceError ? error : new ExternalSourceError('CANDIDATE_INVALID', 'Downloaded external candidate failed package validation.');
    }
  }

  // Describe and validate one extracted package folder. A package that fails is
  // described *with* its errors rather than dropped, because a listing that
  // silently omits a broken package tells its publisher nothing and tells the
  // owner the app was never published at all. Only `selectCandidate` turns those
  // errors into a refusal, so one bad package never costs a source its catalog.
  readPackage(source, { dir, folder }) {
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    const broken = (message) => ({
      errors: [message], folder, manifest: null, manifestPath, namespacedPackageId: null,
      packageDigest: null, packageDir: dir, packageId: folder || null, permissions: [],
      source: null, trust: source.trust,
    });
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch { return broken('the package manifest is not readable JSON.'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return broken('the package manifest is not an object.');
    const candidateSource = { kind: 'external-git', path: EXTERNAL_PACKAGE_DIR, repository: source.repository, revision: source.revision, trust: source.trust };
    // The constrained gate and the generic manifest contract are reported
    // together so a publisher sees every problem at once instead of peeling them
    // one error class at a time.
    const gate = validateExternalCandidate({ manifest, officialPackageIds: this.officialPackageIds, platformVersion: this.platformVersion, source: candidateSource });
    const errors = [...gate.errors, ...validateAppPackageManifest(manifest, { packageDir: dir })];
    // A catalog folder is its package's id. Without this rule a repository could
    // publish two folders whose manifests claim one id, and which of them an
    // install resolved to would depend on directory order.
    if (folder && folder !== manifest.id) {
      errors.push(`a .mos catalog folder must be named for the package id its manifest declares; "${folder}" holds "${manifest.id}".`);
    }
    // The collision-safe id every MOS-side identity (instance row, containers,
    // volumes, routes, build context) uses for this package. Without it the
    // package could not be isolated from an official id, so fail closed.
    const namespacedPackageId = instanceNamespaceId(source, manifest.id);
    if (!namespacedPackageId) errors.push('the package id cannot be namespaced for this source.');
    let packageDigest = null;
    // Only meaningful for a package that already validated: digesting walks every
    // file and refuses undeclared ones, which is a validation error the loop
    // above has already reported in plain language.
    if (!errors.length) {
      try { packageDigest = digestAppPackage(dir, { manifest }); }
      catch (error) { errors.push(String(error?.message || 'the package contents could not be digested.')); }
    }
    return {
      errors,
      folder,
      manifest,
      manifestPath,
      namespacedPackageId,
      packageDigest,
      packageDir: dir,
      packageId: manifest.id,
      permissions: gate.permissions,
      source: candidateSource,
      trust: source.trust,
    };
  }
}

module.exports = { ExternalSourceClient };
