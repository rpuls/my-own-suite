const crypto = require('node:crypto');

const {
  describeRequestedPermissions,
  namespacedPackageId,
  validateConstrainedCapabilities,
  validateExternalIdentity,
  validatePlatformCompatibility,
  validateSourceIdentity,
} = require('./package-contracts.cjs');

// Owner-added package sources are always non-official and therefore never
// mos-reviewed. Trust is recorded independently of the package's own metadata
// (a package cannot promote its own trust). Signing verification that would
// justify `publisher-signed` is Phase 8; until then a source that supplies a
// signature is still only structurally accepted here.
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SOURCE_KINDS = new Set(['external-git', 'local']);
const SOURCE_TRUST = new Set(['publisher-signed', 'unverified']);
const SOURCE_STATUSES = new Set(['active', 'unavailable', 'key-rotated', 'compromised', 'removed']);
// New installs are only allowed from an active source. Every other status keeps
// existing installs manageable from their snapshots but blocks new installs.
const INSTALL_BLOCKING_STATUSES = new Set(['unavailable', 'key-rotated', 'compromised', 'removed']);
// A source that is confirmed compromised or removed is terminal; it must not be
// silently re-activated. Unavailability and key rotation are recoverable once
// the owner re-confirms the source.
const STATUS_TRANSITIONS = Object.freeze({
  active: new Set(['unavailable', 'key-rotated', 'compromised', 'removed']),
  compromised: new Set(['removed']),
  'key-rotated': new Set(['active', 'compromised', 'removed']),
  removed: new Set([]),
  unavailable: new Set(['active', 'key-rotated', 'compromised', 'removed']),
});

class ExternalSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// External sources must be uncredentialed HTTPS. `local`/`file` sources exist
// only for deterministic development and tests and are rejected unless the
// caller explicitly opts in.
function validateSourceUrl(repository, { allowLocalSources = false } = {}) {
  let url;
  try { url = new URL(String(repository)); } catch { return ['source repository must be a valid URL.']; }
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol === 'file:' || (url.protocol === 'http:' && localHost)) {
    return allowLocalSources ? [] : ['local and file sources are development-only.'];
  }
  const errors = [];
  if (url.protocol !== 'https:') errors.push('source repository must use HTTPS.');
  if (url.username || url.password) errors.push('source repository must not embed credentials.');
  if (url.hash) errors.push('source repository must not contain a fragment.');
  return errors;
}

function sourceId(repository, catalogPath) {
  const normalized = `${String(repository).trim().toLowerCase().replace(/\.git$/u, '').replace(/\/+$/u, '')}\n${String(catalogPath).trim().toLowerCase()}`;
  return `src-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

// Build a normalized, persistable source record from owner input. Source URL,
// revision, publisher, signature, and trust are stored separately from any
// package metadata the source later serves.
function buildSourceRecord(input, { allowLocalSources = false, now = () => new Date() } = {}) {
  const kind = input?.kind || 'external-git';
  if (!SOURCE_KINDS.has(kind)) throw new ExternalSourceError('SOURCE_KIND_INVALID', 'Unsupported source kind.');
  if (kind === 'local' && !allowLocalSources) throw new ExternalSourceError('SOURCE_KIND_INVALID', 'Local sources are development-only.');
  const repository = String(input?.repository || '').trim();
  if (!repository) throw new ExternalSourceError('SOURCE_URL_INVALID', 'A source repository URL is required.');
  const urlErrors = validateSourceUrl(repository, { allowLocalSources });
  if (urlErrors.length) throw new ExternalSourceError('SOURCE_URL_INVALID', urlErrors.join(' '));
  // External packages live in a `.mos/` folder at the repository root, so the
  // catalog path is fixed by convention rather than supplied by the owner.
  const catalogPath = String(input?.catalogPath || '.mos').trim();
  if (catalogPath.includes('..') || catalogPath.startsWith('/')) throw new ExternalSourceError('SOURCE_PATH_INVALID', 'Source catalog path must be repository-local.');
  const trust = input?.trust || 'unverified';
  if (!SOURCE_TRUST.has(trust)) throw new ExternalSourceError('SOURCE_TRUST_INVALID', 'External sources may only be publisher-signed or unverified.');
  const signature = input?.signature ? String(input.signature) : null;
  if (trust === 'publisher-signed' && !signature) throw new ExternalSourceError('SOURCE_SIGNATURE_MISSING', 'A publisher-signed source must provide a signature.');
  const at = now().toISOString();
  return {
    addedAt: at,
    catalogPath,
    id: sourceId(repository, catalogPath),
    kind,
    publisher: input?.publisher ? String(input.publisher) : null,
    repository,
    revision: null,
    signature,
    status: 'active',
    statusReason: null,
    trust,
    updatedAt: at,
  };
}

function sourceInstallable(record) {
  return record?.status === 'active';
}

// Bind the immutable revision resolved from the source. Kept out of
// buildSourceRecord so a stored record cannot claim a revision it never
// resolved to.
function withRevision(record, revision) {
  if (!COMMIT_PATTERN.test(String(revision))) throw new ExternalSourceError('SOURCE_REVISION_INVALID', 'Source revision must be an immutable commit.');
  return { ...record, revision };
}

function withStatus(record, status, reason = null) {
  if (!SOURCE_STATUSES.has(status)) throw new ExternalSourceError('SOURCE_STATUS_INVALID', 'Unsupported source status.');
  const allowed = STATUS_TRANSITIONS[record?.status] || new Set();
  if (status !== record?.status && !allowed.has(status)) {
    throw new ExternalSourceError('SOURCE_STATUS_TRANSITION_INVALID', `A ${record?.status} source cannot transition to ${status}.`);
  }
  return { ...record, status, statusReason: reason };
}

// Removing a source is metadata-only: it never uninstalls a snapshot. Installed
// instances whose source matches the removed record become source-orphaned but
// remain fully manageable from their preserved snapshots.
function removalPlan(record, instances = []) {
  const orphanedInstanceIds = (Array.isArray(instances) ? instances : [])
    .filter((instance) => instance?.sourceRepository === record?.repository && instance?.sourcePath?.startsWith(`${record?.catalogPath}/`))
    .map((instance) => instance.id);
  return { keepsSnapshots: true, orphanedInstanceIds, removedRecord: withStatus(record, 'removed', 'Removed by owner.') };
}

// Collision-safe instance identity for a package served by this source.
function instanceNamespaceId(record, packageId) {
  return namespacedPackageId({ kind: record?.kind, path: `${record?.catalogPath}/${packageId}`, repository: record?.repository, trust: record?.trust }, packageId);
}

// One fail-closed gate every external candidate must pass before build/apply:
// source identity, non-impersonation, the constrained capability profile, and
// platform compatibility. Returns the requested-permission surface for owner
// consent alongside any blocking errors.
function validateExternalCandidate({ manifest, officialPackageIds = [], platformVersion, source }) {
  const errors = [
    ...validateSourceIdentity(source, { officialRepository: null }),
    ...validateExternalIdentity(manifest, source, { officialPackageIds }),
    ...validateConstrainedCapabilities(manifest, { trust: source?.trust }),
    ...validatePlatformCompatibility(manifest, platformVersion),
  ];
  return { errors: [...new Set(errors)], permissions: describeRequestedPermissions(manifest) };
}

module.exports = {
  ExternalSourceError,
  INSTALL_BLOCKING_STATUSES,
  SOURCE_STATUSES,
  buildSourceRecord,
  instanceNamespaceId,
  removalPlan,
  sourceId,
  sourceInstallable,
  validateExternalCandidate,
  validateSourceUrl,
  withRevision,
  withStatus,
};
