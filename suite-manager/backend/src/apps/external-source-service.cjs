const fs = require('node:fs');
const path = require('node:path');

const { ExternalSourceClient } = require('./external-source-client.cjs');
const { ExternalSourceError, buildSourceRecord, removalPlan, sourceInstallable, withStatus } = require('./external-source-registry.cjs');
const { parseGitPackageUrl } = require('./git-archive-source.cjs');
const { publicPackageSummary } = require('./package-manifest.cjs');
const { SourceCatalogCache } = require('./source-catalog-cache.cjs');

// Icons the package may ship. A not-yet-installed external package has no served
// icon URL, so a small icon is inlined as a data URL for its card; larger or
// unknown icons fall back to the frontend placeholder.
const ICON_MIME = Object.freeze({
  '.avif': 'image/avif', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
});
// Deliberately modest, and the same limit for a live preview as for a cached card.
// Every inlined icon is stored in the source catalog cache, which a curated source
// can fill sixty-four packages at a time, and an owner who sees an icon on the
// preview card should see that same icon once the source is added rather than
// watch it fall back to a placeholder. An app icon that does not fit in this is
// not an icon.
const MAX_INLINE_ICON_BYTES = 48 * 1024;

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
// persisted source registry, the constrained download client, the cached package
// listing, and the pure registry rules together. Every source it produces is
// non-official and unverified; nothing here can grant MOS-reviewed trust.
//
// A source publishes one app package or many — an app project shipping its own
// app, or someone curating a catalog of them. They are the same thing here: a
// repository whose `.mos/` folder MOS reads, of which the single-package case is
// the one-entry case.
class ExternalSourceService {
  constructor({ allowLocalSources = false, appPackages = null, cache = null, client = null, now = () => new Date(), officialPackageIds = [], platformVersion = '0.0.0', store }) {
    this.allowLocalSources = allowLocalSources;
    this.appPackages = appPackages;
    this.now = now;
    this.officialPackageIds = officialPackageIds;
    this.platformVersion = platformVersion;
    this.store = store;
    this.cache = cache || new SourceCatalogCache({ now, stateDir: store.stateDir });
    this.client = client || new ExternalSourceClient({ officialPackageIds, platformVersion, stateDir: store.stateDir });
    this.sweeping = null;
  }

  // The source record for a repository, when it is one the owner still has.
  //
  // A removed source is history: it is hidden from the Settings list and offers
  // nothing on the Apps screen, so it must not answer "already added" to a paste of
  // the same URL, or block the install behind it. Every path that asks whether a
  // repository is already the owner's asks through here, so none of them can
  // disagree with what the owner is looking at.
  heldSource(id) {
    const record = this.store.getAppSource(id);
    return record && record.status !== 'removed' ? record : null;
  }

  // Clear a removed source's record so its repository can be registered again.
  // Adding it back is a new decision, with its own addedAt and its own resolved
  // revision, rather than a status walked backwards.
  releaseRemovedSource(id) {
    if (this.store.getAppSource(id) && !this.heldSource(id)) {
      this.store.deleteAppSource(id);
      this.cache.forget(id);
    }
  }

  listSources() {
    return this.store.listAppSources().map((record) => ({ ...publicSource(record), catalog: this.cache.status(record.id) }));
  }

  // Every package the owner's active sources publish, as cards the Apps list folds
  // in beside the reviewed catalog. This reads the cache and nothing else: opening
  // the Apps page never waits on a git host, and it keeps working with no route to
  // one. A source that has never been fetched contributes nothing yet, and its row
  // in Settings is where that is explained.
  //
  // A source that is not installable contributes nothing either. Its packages are
  // not offerable, and a card that looks installable but refuses at the last step
  // is worse than no card.
  catalogPackages() {
    const cards = [];
    for (const record of this.store.listAppSources()) {
      if (!sourceInstallable(record)) continue;
      for (const card of this.cache.get(record.id)?.packages || []) {
        cards.push({ ...card, source: { id: record.id, publisher: record.publisher, repository: record.repository } });
      }
    }
    return cards;
  }

  // Bring one source's cached package list up to date.
  //
  // `force` is the owner asking directly, and it is the only thing that ignores
  // both the check interval and the failure back-off. That matters: the warning on
  // a failing row is exactly what prompts the click, so making the click wait out
  // the back-off would strand the owner in front of the problem they came to fix.
  //
  // Never throws. A source that cannot be reached records why and keeps serving
  // the packages it last published, because a host MOS cannot reach today has not
  // retracted what it published yesterday.
  async refreshSource(id, { force = false } = {}) {
    const record = this.requireSource(id);
    if (!sourceInstallable(record)) return this.cache.status(id);
    if (!force && !this.cache.due(id)) return this.cache.status(id);
    try {
      const resolved = await this.client.resolveRevision(record);
      if (resolved.revision !== record.revision) {
        this.store.updateAppSourceRevision({ at: this.now().toISOString(), id, revision: resolved.revision });
      }
      // The probe above is the cheap half, two API calls. The archive download is
      // the expensive half and is skipped entirely while the source is still at the
      // commit whose packages are already cached — which is the normal case, since
      // most sources are not pushed to between checks.
      const cached = this.cache.get(id);
      if (cached?.revision === resolved.revision && cached.packages.length) {
        this.cache.markUnchanged(id);
        return this.cache.status(id);
      }
      const listing = await this.client.listPackages(resolved);
      try {
        this.cache.put(id, { packages: listing.packages.map((entry) => this.packageCard(entry, resolved)), revision: resolved.revision });
      } finally {
        listing.cleanup();
      }
      return this.cache.status(id);
    } catch (error) {
      this.cache.markFailed(id, { code: error?.code, message: error?.message, retryAt: error?.retryAt || null });
      return this.cache.status(id);
    }
  }

  // Freshness pass over the sources that are due, started when the owner opens the
  // Apps page and deliberately not awaited by anything that renders: the page draws
  // from the cache, and a source found to have moved shows up on the next load.
  //
  // Sequential and capped by the cache's sweep policy, so fifteen added sources
  // cost a handful of API calls per pass rather than thirty at once.
  sweep() {
    if (this.sweeping) return this.sweeping;
    const installable = this.store.listAppSources().filter(sourceInstallable).map((record) => record.id);
    const due = this.cache.dueSourceIds(installable);
    if (!due.length) return null;
    this.sweeping = (async () => {
      for (const id of due) await this.refreshSource(id).catch(() => {});
    })().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  // The Apps-list card for one package a source publishes.
  //
  // A package that failed validation is carried with its reasons rather than
  // dropped. Omitting it would tell the owner the source never offered the app and
  // tell its publisher nothing at all; carried, both can see that it is published
  // and why MOS will not install it.
  packageCard(entry, source) {
    const installable = entry.errors.length === 0;
    const summary = installable ? publicPackageSummary(entry.manifest) : publicPackageSummary({
      category: entry.manifest?.category,
      id: entry.packageId || entry.folder || '',
      name: entry.manifest?.name || entry.folder || 'Unnamed package',
      summary: 'This app package cannot be installed until its publisher fixes it.',
      version: entry.manifest?.version,
    }, entry.errors);
    return {
      ...summary,
      // MOS publishes no advisories against a package it has not reviewed, and a
      // source that is not the catalog cannot offer an update to something that is
      // not installed. Both are stated rather than omitted so the Apps list can
      // treat an offered external package exactly like any other card.
      advisories: [],
      catalogUpdate: { available: null, installed: null, status: 'external-source' },
      external: true,
      iconDataUrl: installable ? this.iconDataUrl(entry) : null,
      instance: null,
      // The id every API path addresses this package by. It is the source-namespaced
      // id, never the bare id the manifest claims, because that is the identity the
      // instance row, containers, volumes, and routes all take.
      id: entry.namespacedPackageId,
      iconUrl: '',
      installStatus: installable ? 'external-available' : 'external-unavailable',
      mosReviewed: false,
      packageDigest: entry.packageDigest,
      packageErrors: entry.errors,
      packageId: entry.packageId,
      permissions: entry.permissions,
      // A package MOS has not reviewed has no posture. A `privacy-review.json` the
      // package ships is not a MOS review, which is why nothing the package claims
      // about itself is read here.
      //
      // `not-assessed`, not `review-required`: the second means a review MOS owes
      // and has not written, which is a queue the Apps UI is right to describe as
      // pending. MOS assesses the packages it publishes, so nothing it can say
      // about this app is ever coming, and the status has to carry that difference
      // or every surface downstream re-invents it from `external`.
      privacy: { dimensions: null, posture: null, reviewedAt: null, status: 'not-assessed' },
      trust: source.trust,
    };
  }

  // Resolve a pasted repository URL into preview cards without persisting anything:
  // parse the repo URL, resolve its immutable commit, download the `.mos/` folder
  // through the constrained gate, and return one card per package it publishes
  // alongside the source coordinates an install would use. Cards are always marked
  // external and unverified and never carry MOS-reviewed trust; each package id is
  // learned from that package's own manifest.
  async resolveUrl(input) {
    const parsed = parseGitPackageUrl(input);
    const record = buildSourceRecord(
      { repository: parsed.repository, trust: 'unverified' },
      { allowLocalSources: this.allowLocalSources, now: this.now },
    );
    const resolved = await this.client.resolveRevision(record, parsed.ref);
    const listing = await this.client.listPackages(resolved);
    try {
      return {
        // Present already, so the owner can see they are re-adding something rather
        // than be told at the end that it was already added.
        added: Boolean(this.heldSource(resolved.id)),
        packages: listing.packages.map((entry) => this.packageCard(entry, resolved)),
        source: {
          catalogPath: resolved.catalogPath,
          id: resolved.id,
          kind: 'external-git',
          repository: resolved.repository,
          revision: resolved.revision,
          trust: resolved.trust,
        },
      };
    } finally {
      listing.cleanup();
    }
  }

  // Install one package a repository publishes. This and `addSource` are the only
  // external flows that persist anything, and both are explicit owner actions on a
  // URL the owner just reviewed.
  //
  // Resolution, download, and the constrained gate all re-run here instead of
  // trusting the earlier preview, so an install can only ever apply a package that
  // passed validation moments ago at a commit resolved right now. The source record
  // is persisted first so the install is attributable, and trust stays unverified
  // regardless of anything the package claims.
  //
  // `packageId` is required whenever the source publishes more than one package —
  // the client refuses to choose, because an install whose identity depended on
  // directory order would be a different app on the next push.
  async installUrl(input, { config = {}, packageId = null } = {}) {
    if (!this.appPackages?.installExternalPackage) {
      throw new ExternalSourceError('SOURCE_INSTALL_UNAVAILABLE', 'Installing external packages is unavailable.');
    }
    const parsed = parseGitPackageUrl(input);
    const record = buildSourceRecord(
      { repository: parsed.repository, trust: 'unverified' },
      { allowLocalSources: this.allowLocalSources, now: this.now },
    );
    this.releaseRemovedSource(record.id);
    const existing = this.heldSource(record.id);
    if (existing && !sourceInstallable(existing)) {
      throw new ExternalSourceError('SOURCE_NOT_INSTALLABLE', 'This source is not active, so new installs are blocked.');
    }
    const resolved = await this.client.resolveRevision(existing || record, parsed.ref);
    const candidate = await this.client.downloadCandidate(resolved, { packageId });
    try {
      const stored = existing
        ? this.store.updateAppSourceRevision({ at: this.now().toISOString(), id: resolved.id, revision: resolved.revision })
        : this.store.insertAppSource(resolved);
      return {
        instance: await this.appPackages.installExternalPackage({ candidate, input: config }),
        mosReviewed: false,
        packageId: candidate.namespacedPackageId,
        permissions: candidate.permissions,
        source: publicSource(stored),
        trust: candidate.trust,
      };
    } finally {
      candidate.cleanup?.();
    }
  }

  // Inline a small package icon from a downloaded candidate so its card shows the
  // package's own icon. The icon path is already validated inside the package folder
  // by the manifest reader; anything missing, oversized, or of an unknown type falls
  // back to null (frontend placeholder + external badge).
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

  // Register a new external package source without installing anything. The URL must
  // be uncredentialed HTTPS (local/file only in development); trust is recorded
  // independently of any package claim; and the source branch is resolved to an
  // immutable commit before the record is persisted, so later downloads are always
  // revision-bound.
  //
  // The package listing is fetched as part of adding, so a source the owner has just
  // added shows its apps immediately instead of waiting for the first sweep. A
  // listing that fails does not fail the add: the source is registered, its row
  // carries the reason, and Refresh is there to try again.
  async addSource(input = {}, { ref = 'main' } = {}) {
    const record = buildSourceRecord(input, { allowLocalSources: this.allowLocalSources, now: this.now });
    this.releaseRemovedSource(record.id);
    if (this.heldSource(record.id)) {
      throw new ExternalSourceError('SOURCE_ALREADY_ADDED', 'That package source is already added.');
    }
    const resolved = await this.client.resolveRevision(record, ref);
    const stored = this.store.insertAppSource(resolved);
    await this.refreshSource(stored.id, { force: true });
    return { ...publicSource(this.store.getAppSource(stored.id)), catalog: this.cache.status(stored.id) };
  }

  // Transition a source's status (unavailable, compromised). The
  // registry enforces which transitions are allowed and keeps compromise and
  // removal terminal. Status changes never touch installed instances.
  setSourceStatus(id, status, reason = null) {
    const record = this.requireSource(id);
    const next = withStatus(record, status, reason);
    const stored = this.store.updateAppSourceStatus({ at: this.now().toISOString(), id, status: next.status, statusReason: next.statusReason });
    return { ...publicSource(stored), catalog: this.cache.status(id) };
  }

  // Remove a source. Metadata-only as far as installed apps are concerned: it marks
  // the source removed and reports which installed instances become source-orphaned,
  // but never uninstalls a snapshot or mutates any instance/projection/config/secret
  // row. Orphaned apps stay fully manageable from their preserved installed
  // snapshots. The cached package list is dropped, because it only ever described
  // what the source offered to install.
  removeSource(id) {
    const record = this.requireSource(id);
    const plan = removalPlan(record, this.store.getAppInstances());
    this.store.updateAppSourceStatus({ at: this.now().toISOString(), id, status: 'removed', statusReason: plan.removedRecord.statusReason });
    this.cache.forget(id);
    return {
      keepsSnapshots: plan.keepsSnapshots,
      orphanedInstanceIds: plan.orphanedInstanceIds,
      source: publicSource(this.store.getAppSource(id)),
    };
  }

  // Preview what one of a persisted source's packages would request before any
  // install. Downloads the candidate through the constrained gate and returns its
  // requested-permission surface and trust so the owner can consent with the full
  // risk visible. Persists nothing and runs nothing.
  async previewCandidate(id, { packageId = null } = {}) {
    const record = this.requireSource(id);
    if (!sourceInstallable(record)) {
      throw new ExternalSourceError('SOURCE_NOT_INSTALLABLE', 'This source is not active, so new installs are blocked.');
    }
    const candidate = await this.client.downloadCandidate(record, { packageId });
    try {
      return {
        mosReviewed: false,
        namespacedPackageId: candidate.namespacedPackageId,
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
