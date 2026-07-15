const fs = require('node:fs');
const path = require('node:path');

const { ExternalSourceClient } = require('./external-source-client.cjs');
const { ExternalSourceError, buildSourceRecord, removalPlan, sourceInstallable, withStatus } = require('./external-source-registry.cjs');
const { parseGitPackageUrl } = require('./git-archive-source.cjs');
const { publicPackageSummary } = require('./package-manifest.cjs');

// Icons the package may ship. A not-yet-installed external package has no served
// icon URL, so a small icon is inlined as a data URL for the preview card; larger
// or unknown icons fall back to the frontend placeholder.
const ICON_MIME = Object.freeze({
  '.avif': 'image/avif', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
});
const MAX_INLINE_ICON_BYTES = 512 * 1024;

// Owner-facing view of a source record. Trust and review status are always
// reported explicitly so an owner can never mistake an added source for an
// official, MOS-reviewed one. The stored signature is reduced to a boolean; the
// repository URL is already validated uncredentialed at add time.
function publicSource(record) {
  return {
    addedAt: record.addedAt,
    catalogPath: record.catalogPath,
    id: record.id,
    kind: record.kind,
    mosReviewed: false,
    official: false,
    publisher: record.publisher || null,
    repository: record.repository,
    revision: record.revision || null,
    signed: Boolean(record.signature),
    status: record.status,
    statusReason: record.statusReason || null,
    trust: record.trust,
    updatedAt: record.updatedAt,
  };
}

// Backend orchestration for the owner-only external package source flow. Ties the
// persisted source registry, the constrained download client, and the pure
// registry rules together. Every source it produces is non-official and
// unverified/publisher-signed; nothing here can grant MOS-reviewed trust.
class ExternalSourceService {
  constructor({ allowLocalSources = false, client = null, now = () => new Date(), officialPackageIds = [], platformVersion = '0.0.0', store }) {
    this.allowLocalSources = allowLocalSources;
    this.now = now;
    this.officialPackageIds = officialPackageIds;
    this.platformVersion = platformVersion;
    this.store = store;
    this.client = client || new ExternalSourceClient({ officialPackageIds, platformVersion, stateDir: store.stateDir });
  }

  listSources() {
    return this.store.listAppSources().map(publicSource);
  }

  // Resolve a pasted repository URL into a preview card without persisting
  // anything: parse the repo URL, resolve its immutable commit, download the
  // `.mos/` package through the constrained gate, and return an app card plus the
  // requested permissions and the source coordinates an install would use. The
  // card is always marked external and unverified and never carries MOS-reviewed
  // trust; the package id is learned from the downloaded manifest.
  async resolveUrl(input) {
    const parsed = parseGitPackageUrl(input);
    const record = buildSourceRecord(
      { repository: parsed.repository, trust: 'unverified' },
      { allowLocalSources: this.allowLocalSources, now: this.now },
    );
    const resolved = await this.client.resolveRevision(record, parsed.ref);
    const candidate = await this.client.downloadCandidate(resolved);
    try {
      return {
        card: {
          ...publicPackageSummary(candidate.manifest),
          external: true,
          iconDataUrl: this.iconDataUrl(candidate),
          iconUrl: '',
          installStatus: 'external-available',
          mosReviewed: false,
          trust: candidate.trust,
        },
        instanceId: candidate.instanceId,
        packageDigest: candidate.packageDigest,
        permissions: candidate.permissions,
        source: {
          catalogPath: resolved.catalogPath,
          kind: 'external-git',
          packageId: candidate.packageId,
          repository: resolved.repository,
          revision: resolved.revision,
          trust: candidate.trust,
        },
      };
    } finally {
      candidate.cleanup?.();
    }
  }

  // Inline a small package icon from the downloaded candidate so the preview card
  // shows the package's own icon. The icon path is already validated inside the
  // package folder by the manifest reader; anything missing, oversized, or of an
  // unknown type falls back to null (frontend placeholder + external badge).
  iconDataUrl(candidate) {
    const icon = candidate?.manifest?.icon;
    if (!icon || !candidate.packageDir) return null;
    try {
      const iconPath = path.join(candidate.packageDir, ...String(icon).split('/'));
      const stat = fs.statSync(iconPath);
      const mime = ICON_MIME[path.extname(iconPath).toLowerCase()];
      if (!stat.isFile() || stat.size > MAX_INLINE_ICON_BYTES || !mime) return null;
      return `data:${mime};base64,${fs.readFileSync(iconPath).toString('base64')}`;
    } catch {
      return null;
    }
  }

  // Register a new external package source. The URL must be uncredentialed HTTPS
  // (local/file only in development); trust is recorded independently of any
  // package claim; and the source branch is resolved to an immutable commit
  // before the record is persisted, so later downloads are always revision-bound.
  async addSource(input = {}, { ref = 'main' } = {}) {
    const record = buildSourceRecord(input, { allowLocalSources: this.allowLocalSources, now: this.now });
    if (this.store.getAppSource(record.id)) {
      throw new ExternalSourceError('SOURCE_ALREADY_ADDED', 'That package source is already added.');
    }
    const resolved = await this.client.resolveRevision(record, ref);
    return publicSource(this.store.insertAppSource(resolved));
  }

  // Transition a source's status (unavailable, key-rotated, compromised). The
  // registry enforces which transitions are allowed and keeps compromise and
  // removal terminal. Status changes never touch installed instances.
  setSourceStatus(id, status, reason = null) {
    const record = this.requireSource(id);
    const next = withStatus(record, status, reason);
    return publicSource(this.store.updateAppSourceStatus({ at: this.now().toISOString(), id, status: next.status, statusReason: next.statusReason }));
  }

  // Remove a source. Metadata-only: it marks the source removed and reports which
  // installed instances become source-orphaned, but never uninstalls a snapshot
  // or mutates any instance/projection/config/secret row. Orphaned apps stay
  // fully manageable from their preserved installed snapshots.
  removeSource(id) {
    const record = this.requireSource(id);
    const plan = removalPlan(record, this.store.getAppInstances());
    this.store.updateAppSourceStatus({ at: this.now().toISOString(), id, status: 'removed', statusReason: plan.removedRecord.statusReason });
    return {
      keepsSnapshots: plan.keepsSnapshots,
      orphanedInstanceIds: plan.orphanedInstanceIds,
      source: publicSource(this.store.getAppSource(id)),
    };
  }

  // Preview what a persisted source's package would request before any install.
  // Downloads the candidate through the constrained gate and returns its
  // requested-permission surface and trust so the owner can consent with the full
  // risk visible. Persists nothing and runs nothing.
  async previewCandidate(id) {
    const record = this.requireSource(id);
    if (!sourceInstallable(record)) {
      throw new ExternalSourceError('SOURCE_NOT_INSTALLABLE', 'This source is not active, so new installs are blocked.');
    }
    const candidate = await this.client.downloadCandidate(record);
    try {
      return {
        instanceId: candidate.instanceId,
        mosReviewed: false,
        packageId: candidate.packageId,
        packageVersion: candidate.manifest.version,
        permissions: candidate.permissions,
        trust: candidate.trust,
      };
    } finally {
      candidate.cleanup?.();
    }
  }

  requireSource(id) {
    const record = this.store.getAppSource(id);
    if (!record) throw new ExternalSourceError('SOURCE_NOT_FOUND', 'That package source is not registered.');
    return record;
  }
}

module.exports = { ExternalSourceService, publicSource };
