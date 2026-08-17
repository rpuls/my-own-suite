const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  APP_LOOPBACK_PORT_BASE,
  APP_LOOPBACK_PORT_SPAN,
  AppPackageServiceError,
  appPublicIdentity,
  appRouteForHomepage,
  capabilityMatches,
  createConfigRows,
  digestFor,
  exportEntries,
  fingerprintFor,
  healthTargetFor,
  homepageEntryForHomepage,
  homepageProjectionApplied,
  hostArchitectureOf,
  integrationConfigKey,
  integrationSlots,
  loopbackPortFor,
  materializeRuntimeCaddy,
  materializeRuntimeCompose,
  primaryProjectedRoute,
  privacyReviewPresentation,
  publicInstance,
  readSecretValue,
  renderDryRunProjections,
  renderInstanceProjections,
  requestContextForPackage,
  resolveCapabilityValue,
  resolveConfigTemplate,
  resolveTemplatesDeep,
  runtimeApplied,
  runtimeConnectionState,
  runtimeRouteApplied,
  secretFilePath,
} = require('./app-package-internals.cjs');
const { AppOperationLimiter } = require('./app-operation-limits.cjs');
const { AppUpdateService } = require('./app-update-service.cjs');
const {
  digestAppPackage,
  effectiveRouteHost,
  parseNamespacedPackageId,
  stableJson,
  validateArchitectureCompatibility,
  validatePrivacyBinding,
} = require('./package-contracts.cjs');
const {
  inspectAppPackages,
  publicPackageSummary,
  readAppPackageManifest,
} = require('./package-manifest.cjs');

class AppPackageService {
  constructor({
    agent = null,
    appsDir,
    catalogService = null,
    externalClient = null,
    limiter = new AppOperationLimiter(),
    now = () => new Date(),
    officialRepository = 'https://github.com/rpuls/my-own-suite',
    secretDir = null,
    store,
  }) {
    this.agent = agent;
    this.appsDir = appsDir;
    this.catalogService = catalogService;
    this.externalClient = externalClient;
    this.limiter = limiter;
    this.now = now;
    this.officialRepository = officialRepository;
    this.secretDir = secretDir || path.join(store.stateDir, 'app-secrets');
    this.store = store;
    // The update saga is its own service (see app-update-service.cjs). It needs
    // this instance for install-side work it must not own — runtime apply,
    // integrations, lifecycle — so it is built here with `this` rather than at
    // the composition root: only one of the two can exist first, and an update
    // service is useless without the packages it updates. The dependency runs
    // one way, so neither module imports the other.
    this.updates = new AppUpdateService({ apps: this });
  }

  // The update saga, delegated verbatim. AppUpdateService owns the sequencing;
  // these keep the one entry point every route, agent and test already calls.
  downloadUpdateCandidate(instance) { return this.updates.downloadUpdateCandidate(instance); }

  recoverInterruptedUpdates(requestContext = {}) { return this.updates.recoverInterruptedUpdates(requestContext); }

  commitPromotedPackageUpdate(instance, operation) { return this.updates.commitPromotedPackageUpdate(instance, operation); }

  recoverPackageUpdate(packageId, requestContext = {}) { return this.updates.recoverPackageUpdate(packageId, requestContext); }

  preparePackageUpdate(packageId) { return this.updates.preparePackageUpdate(packageId); }

  stagePackageUpdate(packageId, input = {}, requestContext = {}) { return this.updates.stagePackageUpdate(packageId, input, requestContext); }

  // A package's base images are pinned by digest, so one that names an
  // architecture this host is not cannot pull them and will fail in the middle
  // of `docker build`, after the download, the gate, and the snapshot have all
  // passed. Refusing up front turns that into an answer the owner can act on.
  //
  // An agent that cannot be asked, or is too old to answer, leaves the host
  // unknown, and an unknown host enforces nothing: this check exists to explain
  // a failure that was already coming, so it must never invent one.
  async assertArchitectureSupported(manifest, agentStatus = null) {
    const status = agentStatus || await Promise.resolve(this.agent?.status?.()).catch(() => null);
    const errors = validateArchitectureCompatibility(manifest, hostArchitectureOf(status));
    if (errors.length) {
      throw new AppPackageServiceError('APP_ARCHITECTURE_UNSUPPORTED', `This app cannot be installed on this server. ${errors.join(' ')}`, 409);
    }
  }

  // The MOS version an update candidate is checked against. Both candidate
  // sources carry it, so an update can still be compatibility-checked when only
  // one of them is configured; without either, nothing passes.
  get platformVersion() {
    return this.catalogService?.platformVersion || this.externalClient?.platformVersion || '0.0.0';
  }

  installedPackageFor(instance) {
    if (!instance || instance.snapshotState !== 'installed' || !instance.snapshotPath || !instance.packageDigest) {
      throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_UNAVAILABLE', 'This app does not have a verified installed package snapshot.', 409);
    }
    const appPackage = readAppPackageManifest(instance.snapshotPath);
    // An instance is managed under its installed id, which is the manifest id
    // for official packages and `x-<namespace>-<manifest id>` for external ones.
    // Compare against the manifest id the installed id resolves to, so the check
    // stays exact for both without letting a snapshot claim a different package.
    if (appPackage.manifest.id !== parseNamespacedPackageId(instance.packageId).packageId
        || digestAppPackage(instance.snapshotPath) !== instance.packageDigest) {
      throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_INVALID', 'The installed app package snapshot no longer matches its recorded identity.', 409);
    }
    return appPackage;
  }

  async migrateLegacyPackages() {
    const results = [];
    for (const instance of this.store.getAppInstances().filter((item) => item.snapshotState === 'legacy-unmigrated')) {
      const packageDir = path.join(this.appsDir, instance.packageId);
      let appPackage;
      try {
        appPackage = readAppPackageManifest(packageDir);
      } catch {
        this.store.markAppPackageRecoveryRequired({ at: this.now().toISOString(), instanceId: instance.id });
        results.push({ packageId: instance.packageId, status: 'needs-package-recovery' });
        continue;
      }
      const { manifest } = appPackage;
      if (manifest.version !== instance.packageVersion || digestFor(manifest) !== instance.manifestDigest) {
        this.store.markAppPackageRecoveryRequired({ at: this.now().toISOString(), instanceId: instance.id });
        results.push({ packageId: instance.packageId, status: 'needs-package-recovery' });
        continue;
      }

      // Digesting parses privacy-review.json, so invalid package contents must
      // degrade this one instance to recovery rather than abort the whole
      // migration — migrateLegacyPackages runs at startup, and an unfenced
      // throw here prevents Suite Manager from booting.
      let packageDigest;
      try {
        packageDigest = digestAppPackage(packageDir);
      } catch {
        this.store.markAppPackageRecoveryRequired({ at: this.now().toISOString(), instanceId: instance.id });
        results.push({ packageId: instance.packageId, status: 'needs-package-recovery' });
        continue;
      }
      const source = {
        kind: 'official-git',
        path: `apps/${manifest.id}`,
        repository: this.officialRepository,
        revision: packageDigest,
        trust: 'mos-reviewed',
      };
      let privacy = { posture: null, reviewedAt: null, status: 'review-required' };
      const privacyReviewPath = path.join(packageDir, 'privacy-review.json');
      if (fs.existsSync(privacyReviewPath)) {
        // A malformed review must degrade the one instance to recovery, exactly
        // like a malformed manifest above — an unguarded parse here aborts the
        // migration and prevents Suite Manager from booting at all.
        let review;
        try {
          review = JSON.parse(fs.readFileSync(privacyReviewPath, 'utf8'));
        } catch {
          this.store.markAppPackageRecoveryRequired({ at: this.now().toISOString(), instanceId: instance.id });
          results.push({ packageId: instance.packageId, status: 'needs-package-recovery' });
          continue;
        }
        // Same revision rule as installPackage: the legacy migration path has
        // no resolved git revision, so adopt the review's declared revision.
        if (typeof review?.scope?.source?.revision === 'string' && review.scope.source.revision.trim()) {
          source.revision = review.scope.source.revision;
        }
        const errors = validatePrivacyBinding(review, { manifest, packageDigest, source });
        if (errors.length) {
          this.store.markAppPackageRecoveryRequired({ at: this.now().toISOString(), instanceId: instance.id });
          results.push({ packageId: instance.packageId, status: 'needs-package-recovery' });
          continue;
        }
        privacy = { posture: review.posture, reviewedAt: review.reviewedAt, status: 'reviewed' };
      }
      try {
        const snapshot = await this.agent?.snapshotPackage({ instanceId: instance.id, packageDigest, packageId: manifest.id });
        if (!snapshot?.snapshotPath) throw new Error('snapshot unavailable');
        const installed = readAppPackageManifest(snapshot.snapshotPath);
        if (installed.manifest.id !== manifest.id || digestAppPackage(snapshot.snapshotPath) !== packageDigest) throw new Error('snapshot mismatch');
        this.store.migrateAppPackageIdentity({
          at: this.now().toISOString(),
          instanceId: instance.id,
          packageDigest,
          privacy,
          snapshotPath: snapshot.snapshotPath,
          source,
        });
        results.push({ packageId: instance.packageId, status: 'migrated' });
      } catch (error) {
        results.push({ errorCode: error.code || 'APP_PACKAGE_MIGRATION_RETRY_REQUIRED', packageId: instance.packageId, status: 'retry-required' });
      }
    }
    return results;
  }

  // The host label an installed app answers on, for callers that hold only a
  // package id and need to build its public URL. Null when the package is not
  // installed or has no projected route: there is no address to report, and
  // inventing one from the id is what this whole derivation exists to prevent.
  publicRouteHostFor(packageId) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status === 'uninstalled') return null;
    return primaryProjectedRoute(this.store.getAppProjections(instance.id))?.host || null;
  }

  // The package a dashboard tile belongs to, for the tile redirect, which holds
  // only the entry id the tile was written with. Null for anything that is not a
  // live installed instance, so an id from a stale, hand-edited or invented tile
  // resolves to no address rather than to a guess.
  installedPackageIdForInstance(instanceId) {
    const id = String(instanceId || '');
    const instance = this.store.getAppInstances().find((candidate) => candidate.id === id);
    return instance && instance.status === 'installed' ? instance.packageId : null;
  }

  async applyPackageRuntime(packageId, requestContext = {}, options = {}) {
    if (!this.agent) {
      throw new AppPackageServiceError('APP_AGENT_UNAVAILABLE', 'App runtime system agent is unavailable.', 503);
    }
    const instance = this.store.getAppInstanceByPackageId(packageId);
    const allowedStatuses = options.allowDisabled ? ['installed', 'disabled'] : ['installed'];
    if (!instance || !allowedStatuses.includes(instance.status)) {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before applying its runtime.', 409);
    }

    const projections = this.store.getAppProjections(instance.id);
    const configRows = this.store.getAppConfig(instance.id).map((row) => (
      row.secretRef ? { ...row, rawValue: readSecretValue(this.secretDir, row.secretRef) } : row
    ));
    const composeProjection = projections.find((projection) => projection.kind === 'compose');
    const caddyProjection = projections.find((projection) => projection.kind === 'caddy');
    const healthProjection = projections.find((projection) => projection.kind === 'health');
    if (!composeProjection || !caddyProjection || !healthProjection) {
      throw new AppPackageServiceError('APP_RUNTIME_PROJECTION_MISSING', 'This app is missing runtime projections.', 409);
    }

    const { manifest } = this.installedPackageFor(instance);
    // Derived here rather than taken from the caller. The caller only knows the
    // package id, and an app's web address comes from its projected route host;
    // deriving from the projection is what keeps appHost in agreement with the
    // sites the agent renders, for every caller (request, boot reconcile, HTTPS
    // re-apply, restore) at once.
    const { appHost, publicUrl } = appPublicIdentity(projections, requestContextForPackage(packageId, requestContext));
    const result = await this.agent.apply({
      appHost,
      caddy: materializeRuntimeCaddy(caddyProjection.content, configRows),
      compose: materializeRuntimeCompose(composeProjection.content, configRows),
      health: healthProjection.content,
      instanceId: instance.id,
      packageDigest: instance.packageDigest,
      packageId: instance.packageId,
      packageVersion: instance.packageVersion,
      publicUrl,
      sourceRevision: instance.sourceRevision,
    });

    const at = this.now().toISOString();
    const operationId = crypto.randomUUID();
    this.store.applyAppProjections({
      at,
      instanceId: instance.id,
      kinds: ['compose', 'caddy', 'health'],
      operationId,
      request: {
        packageId: manifest.id,
        projectionDigests: {
          caddy: caddyProjection.digest,
          compose: composeProjection.digest,
          health: healthProjection.digest,
        },
        target: 'runtime',
      },
    });

    return {
      agent: result,
      instance: publicInstance(
        this.store.getAppInstanceByPackageId(packageId),
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
    };
  }

  async connectPackages({ consumerPackageId, providerCapabilityId, providerPackageId, requestContext = {}, slotId }) {
    const consumer = this.store.getAppInstanceByPackageId(consumerPackageId);
    const provider = this.store.getAppInstanceByPackageId(providerPackageId);
    if (!consumer || consumer.status !== 'installed' || !provider || provider.status !== 'installed') {
      throw new AppPackageServiceError('APP_INTEGRATION_APPS_NOT_READY', 'Install both apps before connecting them.', 409);
    }
    if (!runtimeApplied(this.store.getAppProjections(consumer.id)) || !runtimeApplied(this.store.getAppProjections(provider.id))) {
      throw new AppPackageServiceError('APP_INTEGRATION_RUNTIME_NOT_READY', 'Both app runtimes must be running before this integration can be applied.', 409);
    }

    const consumerPackage = this.installedPackageFor(consumer);
    const providerPackage = this.installedPackageFor(provider);
    const [, slot] = integrationSlots(consumerPackage.manifest).find(([id]) => id === slotId) || [];
    const [capabilityId, providerCapability] = exportEntries(providerPackage.manifest).find(([id]) => id === providerCapabilityId) || [];
    if (!slot || !providerCapability || !slot.accepts.some((matcher) => capabilityMatches(providerCapability, matcher))) {
      throw new AppPackageServiceError('APP_INTEGRATION_NOT_COMPATIBLE', 'These app packages do not declare a compatible integration.', 409);
    }
    if (slot.apply?.kind !== 'service-env') {
      throw new AppPackageServiceError('APP_INTEGRATION_APPLY_UNSUPPORTED', 'This integration apply type is not supported yet.', 409);
    }
    const target = consumerPackage.manifest.configTargets?.[slot.apply.target];
    if (!target || target.kind !== 'service-env') {
      throw new AppPackageServiceError('APP_INTEGRATION_TARGET_INVALID', 'This integration target is not declared by the app package.', 409);
    }

    const publicUrlFor = typeof requestContext.publicUrlFor === 'function'
      ? requestContext.publicUrlFor
      : () => requestContext;
    const providerConfig = this.store.getAppConfig(provider.id);
    const consumerExportEntry = exportEntries(consumerPackage.manifest)[0];
    const consumerExport = consumerExportEntry ? { id: consumerExportEntry[0], capability: consumerExportEntry[1] } : null;
    const providerPublicUrl = publicUrlFor(providerPackageId);
    const rows = [];
    for (const [envKey, template] of Object.entries(slot.apply.values || {})) {
      if (!target.allowedKeys.includes(envKey)) {
        throw new AppPackageServiceError('APP_INTEGRATION_TARGET_INVALID', 'The app package did not allow this integration setting.', 409);
      }
      const resolved = resolveCapabilityValue(template, {
        consumerExport,
        providerCapability,
        providerConfig,
        providerPublicUrl,
      });
      const configKey = integrationConfigKey(slotId, envKey);
      if (typeof resolved === 'string' && resolved.startsWith('__secret_ref__:')) {
        const secretRef = resolved.slice('__secret_ref__:'.length);
        rows.push({
          fingerprint: fingerprintFor(secretRef),
          instanceId: consumer.id,
          key: configKey,
          redactedLabel: `${providerPackage.manifest.name} integration secret`,
          secretRef,
          source: 'system',
        });
      } else {
        rows.push({
          instanceId: consumer.id,
          key: configKey,
          source: 'system',
          value: resolved,
          valueJson: stableJson(resolved),
        });
      }
    }

    // Rendered fresh rather than patched over whatever is stored: the stored
    // projections stay a pure function of manifest + config + relationships,
    // which is what lets an app update re-render them without losing this
    // connection. The relationship row is written below in the same
    // transaction; rendering sees it as already present.
    const rowKeys = new Set(rows.map((row) => row.key));
    const nextConfig = [...this.store.getAppConfig(consumer.id).filter((row) => !rowKeys.has(row.key)), ...rows];
    const nextProjections = renderInstanceProjections(consumerPackage.manifest, nextConfig, {
      instanceId: consumer.id,
      integrations: [
        ...this.store.getAppIntegrations(),
        { consumerInstanceId: consumer.id, consumerIntegrationSlot: slotId, status: 'applying' },
      ],
      packageId: consumer.packageId,
    });
    const composeDigest = nextProjections.find((projection) => projection.kind === 'compose')?.digest || null;
    const consumedExportDigest = digestFor({ capabilityId, providerCapability, publicUrl: providerPublicUrl.publicUrl });
    const at = this.now().toISOString();
    this.store.transaction(() => {
      this.store.upsertAppConfigRows({ at, rows });
      this.store.replaceAppProjections({ at, instanceId: consumer.id, projections: nextProjections });
      this.store.beginAppIntegration({
        at,
        consumerInstanceId: consumer.id,
        consumerIntegrationSlot: slotId,
        consumedExportDigest,
        desiredProjectionDigest: composeDigest,
        id: crypto.randomUUID(),
        providerCapabilityId: capabilityId,
        providerInstanceId: provider.id,
      });
    });

    try {
      const applied = await this.applyPackageRuntime(consumerPackageId, publicUrlFor(consumerPackageId));
      const providerServices = Object.keys(providerPackage.manifest.resources?.services || {});
      const network = await this.agent.connectNetwork({
        consumerPackageId,
        providerPackageId,
        providerServiceCount: providerServices.length,
        providerServices,
      });
      this.store.completeAppIntegration({
        at: this.now().toISOString(),
        consumerInstanceId: consumer.id,
        consumerIntegrationSlot: slotId,
        lastAppliedProjectionDigest: composeDigest,
        providerCapabilityId: capabilityId,
        providerInstanceId: provider.id,
      });
      return {
        integration: this.store.getAppIntegrations().find((item) => (
          item.consumerInstanceId === consumer.id
          && item.providerInstanceId === provider.id
          && item.providerCapabilityId === capabilityId
          && item.consumerIntegrationSlot === slotId
        )),
        instance: applied.instance,
        network,
      };
    } catch (error) {
      this.store.failAppIntegration({
        at: this.now().toISOString(),
        consumerInstanceId: consumer.id,
        consumerIntegrationSlot: slotId,
        errorCode: error.code || 'APP_INTEGRATION_APPLY_FAILED',
        providerCapabilityId: capabilityId,
        providerInstanceId: provider.id,
      });
      throw error;
    }
  }

  async reapplyIntegrationRelationship(relationship, requestContext = {}) {
    const provider = this.store.getAppInstances().find((item) => item.id === relationship.providerInstanceId);
    const consumer = this.store.getAppInstances().find((item) => item.id === relationship.consumerInstanceId);
    if (!provider || !consumer || provider.status === 'uninstalled' || consumer.status === 'uninstalled') {
      this.store.markAppIntegrationStatus({
        at: this.now().toISOString(),
        errorCode: 'APP_INTEGRATION_APP_UNINSTALLED',
        id: relationship.id,
        status: 'removed',
      });
      return { relationshipId: relationship.id, status: 'removed' };
    }
    if (provider.status === 'disabled' || provider.enabled === false) {
      this.store.markAppIntegrationStatus({
        at: this.now().toISOString(),
        errorCode: 'APP_INTEGRATION_PROVIDER_DISABLED',
        id: relationship.id,
        status: 'degraded',
      });
      return { relationshipId: relationship.id, status: 'degraded' };
    }
    if (consumer.status === 'disabled' || consumer.enabled === false) {
      this.store.markAppIntegrationStatus({
        at: this.now().toISOString(),
        errorCode: 'APP_INTEGRATION_CONSUMER_DISABLED',
        id: relationship.id,
        status: 'degraded',
      });
      return { relationshipId: relationship.id, status: 'degraded' };
    }
    if (!runtimeApplied(this.store.getAppProjections(provider.id)) || !runtimeApplied(this.store.getAppProjections(consumer.id))) {
      this.store.markAppIntegrationStatus({
        at: this.now().toISOString(),
        errorCode: 'APP_INTEGRATION_RUNTIME_NOT_READY',
        id: relationship.id,
        status: 'degraded',
      });
      return { relationshipId: relationship.id, status: 'degraded' };
    }

    try {
      await this.applyPackageRuntime(consumer.packageId, requestContextForPackage(consumer.packageId, requestContext));
      const providerPackage = this.installedPackageFor(provider);
      const providerServices = Object.keys(providerPackage.manifest.resources?.services || {});
      const network = await this.agent.connectNetwork({
        consumerPackageId: consumer.packageId,
        providerPackageId: provider.packageId,
        providerServiceCount: providerServices.length,
        providerServices,
      });
      this.store.completeAppIntegration({
        at: this.now().toISOString(),
        consumerInstanceId: consumer.id,
        consumerIntegrationSlot: relationship.consumerIntegrationSlot,
        lastAppliedProjectionDigest: this.store.getAppProjections(consumer.id).find((projection) => projection.kind === 'compose')?.digest || relationship.desiredProjectionDigest,
        providerCapabilityId: relationship.providerCapabilityId,
        providerInstanceId: provider.id,
      });
      return { network, relationshipId: relationship.id, status: 'active' };
    } catch (error) {
      this.store.markAppIntegrationStatus({
        at: this.now().toISOString(),
        errorCode: error.code || 'APP_INTEGRATION_REAPPLY_FAILED',
        id: relationship.id,
        status: 'failed',
      });
      return { relationshipId: relationship.id, status: 'failed' };
    }
  }

  async reconcilePackageIntegrations(packageId, requestContext = {}) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance) return [];
    const relationships = this.store.getAppIntegrations()
      .filter((item) => item.status !== 'removed' && (item.providerInstanceId === instance.id || item.consumerInstanceId === instance.id));
    const results = [];
    for (const relationship of relationships) {
      results.push(await this.reapplyIntegrationRelationship(relationship, requestContext));
    }
    return results;
  }

  async refreshPackageRuntimeStatus(packageId) {
    if (!this.agent) {
      throw new AppPackageServiceError('APP_AGENT_UNAVAILABLE', 'App runtime system agent is unavailable.', 503);
    }
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status !== 'installed') {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before checking its runtime.', 409);
    }

    const projections = this.store.getAppProjections(instance.id);
    const healthProjection = projections.find((projection) => projection.kind === 'health');
    if (!healthProjection) {
      throw new AppPackageServiceError('APP_RUNTIME_PROJECTION_MISSING', 'This app is missing runtime projections.', 409);
    }

    const at = this.now().toISOString();
    const operationId = crypto.randomUUID();
    const request = {
      packageId: instance.packageId,
      projectionDigest: healthProjection.digest,
      target: 'health',
    };

    try {
      const result = await this.agent.checkHealth({
        health: healthProjection.content,
        packageId: instance.packageId,
      });
      this.store.recordAppHealthCheck({
        at,
        healthy: true,
        instanceId: instance.id,
        operationId,
        request,
      });
      return {
        agent: result,
        instance: publicInstance(
          this.store.getAppInstanceByPackageId(packageId),
          this.store.getAppProjections(instance.id),
          this.store.getAppConfig(instance.id),
        ),
      };
    } catch (error) {
      this.store.recordAppHealthCheck({
        at,
        errorCode: error.code || 'APP_HEALTH_CHECK_FAILED',
        healthy: false,
        instanceId: instance.id,
        operationId,
        request,
      });
      throw new AppPackageServiceError(
        'APP_HEALTH_FAILED',
        'The app runtime health check failed.',
        502,
      );
    }
  }

  // Lifecycle operations hold the same per-app key as the update transaction.
  // A restart that lands in an update's activate→commit window re-applies the
  // old stored projections over the candidate runtime, and an uninstall deletes
  // the instance row out from under the transaction — the key makes those
  // orderings impossible instead of merely unlikely.
  async restartPackageRuntime(packageId, requestContext = {}) {
    return this.limiter.runExclusive(packageId, () => this.performRestartPackageRuntime(packageId, requestContext));
  }

  async performRestartPackageRuntime(packageId, requestContext = {}) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status !== 'installed') {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Start this app before restarting it.', 409);
    }
    const projections = this.store.getAppProjections(instance.id);
    if (!runtimeRouteApplied(projections)) {
      throw new AppPackageServiceError('APP_RUNTIME_NOT_APPLIED', 'Start this app before restarting it.', 409);
    }

    const applied = await this.applyPackageRuntime(packageId, requestContext);
    return {
      ...applied,
      integrations: await this.reconcilePackageIntegrations(packageId, requestContext),
    };
  }

  packagePrivacyFor(instance, packageId, candidateVersion) {
    // Presentation for the Apps UI: installed apps read the review stored in
    // their installed snapshot; not-yet-installed apps read the current repo
    // candidate. Full privacy binding validation still gates install/update.
    if (!instance) {
      return (candidateVersion && privacyReviewPresentation(path.join(this.appsDir, packageId), { id: packageId, version: candidateVersion }))
        || { dimensions: null, posture: null, reviewedAt: null, status: 'review-required' };
    }
    const stored = {
      dimensions: null,
      posture: instance.privacyPosture || null,
      reviewedAt: instance.privacyReviewedAt || null,
      status: instance.privacyStatus || 'review-required',
    };
    if (instance.snapshotState !== 'installed' || !instance.snapshotPath) return stored;
    // Only a MOS-reviewed source may present a package-shipped review as a
    // review. An external package can ship a `privacy-review.json` claiming any
    // posture it likes, so its stored review-required status stands instead.
    if (instance.sourceTrust !== 'mos-reviewed') return stored;
    return privacyReviewPresentation(instance.snapshotPath, { id: instance.packageId, version: instance.packageVersion }) || stored;
  }

  // Current official advisories for the version an owner actually runs (or the
  // catalog candidate for not-yet-installed apps). Kept separate from the
  // installed assessment so a corrected advisory changes what the owner sees
  // without pretending the installed runtime or its stored review changed.
  packageAdvisoriesFor(instance, packageId, candidateVersion) {
    const version = instance?.packageVersion || candidateVersion;
    if (!version) return [];
    return this.catalogService?.advisoriesFor(packageId, version) || [];
  }

  // How an installed package compares to what its source offers. An external app
  // is not in the reviewed catalog and cached catalog metadata can say nothing
  // about it: only its own repository knows whether a newer package exists, and
  // finding out costs a network round trip. Report that honestly instead of
  // "not in catalog", which reads as a fault, and let the owner check on demand
  // through the ordinary update preview.
  packageUpdateStatusFor(instance, packageId) {
    if (instance?.sourceKind === 'external-git') {
      return {
        available: null,
        installed: { packageDigest: instance.packageDigest, packageVersion: instance.packageVersion },
        status: 'external-source',
      };
    }
    return this.catalogService?.updateFor(packageId, instance) || null;
  }

  listPackages() {
    const instancesByPackage = new Map(this.store.getAppInstances().map((instance) => [instance.packageId, instance]));
    const integrations = this.store.getAppIntegrations();
    const candidatesByPackage = new Map(inspectAppPackages(this.appsDir).map((summary) => [summary.id, summary]));
    const packageIds = new Set([...candidatesByPackage.keys(), ...instancesByPackage.keys()]);
    const packages = [...packageIds].sort().map((packageId) => {
      const storedInstance = instancesByPackage.get(packageId);
      const instance = storedInstance?.status === 'uninstalled' ? null : storedInstance;
      // One instance whose snapshot no longer matches its record (a pending
      // update commit, a corrupted snapshot) must degrade to its own recovery
      // card, never take the whole app list down with it.
      let installedSummary = null;
      if (instance?.snapshotState === 'installed') {
        try { installedSummary = publicPackageSummary(this.installedPackageFor(instance).manifest); } catch {}
      }
      const summary = installedSummary
        || (instance
          ? publicPackageSummary({
            category: instance.categorySnapshot,
            id: instance.packageId,
            name: instance.displayNameSnapshot,
            summary: 'Installed package metadata requires recovery before this app can be managed.',
            version: instance.packageVersion,
          }, ['The installed package snapshot is unavailable.'])
          : candidatesByPackage.get(packageId));
      const projections = instance ? this.store.getAppProjections(instance.id) : [];
      const config = instance ? this.store.getAppConfig(instance.id) : [];
      const guideState = instance ? this.store.getAppGuideState(instance.id) : null;
      return {
        ...summary,
        advisories: this.packageAdvisoriesFor(instance, packageId, candidatesByPackage.get(packageId)?.version),
        catalogUpdate: this.packageUpdateStatusFor(instance, packageId),
        external: instance?.sourceKind === 'external-git',
        // The installed identity wins over the id the manifest claims: an
        // external package is managed under its source-namespaced id, and every
        // API path the UI calls back on must address it by that id.
        id: packageId,
        installStatus: instance?.status || 'not-installed',
        instance: publicInstance(instance ? { ...instance, guideState } : null, projections, config),
        // Trust comes from the recorded source, never from package metadata, so
        // an installed external app keeps visible unverified status.
        mosReviewed: (instance?.sourceTrust || 'mos-reviewed') === 'mos-reviewed',
        privacy: this.packagePrivacyFor(instance, packageId, candidatesByPackage.get(packageId)?.version),
        trust: instance?.sourceTrust || 'mos-reviewed',
      };
    });
    return this.withCompatibility(packages, integrations);
  }

  withCompatibility(packages, integrations = []) {
    return packages.map((app) => {
      const connections = [];
      for (const slot of app.capabilities.integrations || []) {
        for (const provider of packages) {
          if (provider.id === app.id) continue;
          for (const exported of provider.capabilities.exports || []) {
            if (!slot.accepts.some((matcher) => capabilityMatches(exported, matcher))) continue;
            const relationship = integrations.find((item) => (
              item.consumerInstanceId === app.instance?.id
              && item.providerInstanceId === provider.instance?.id
              && item.consumerIntegrationSlot === slot.id
              && item.providerCapabilityId === exported.id
            ));
            connections.push({
              actionLabel: relationship?.status === 'active' ? 'Reconnect' : `Connect ${provider.name}`,
              capabilityId: exported.id,
              consumerPackageId: app.id,
              provider: {
                id: provider.id,
                installStatus: provider.installStatus,
                name: provider.name,
                runtimeState: runtimeConnectionState(provider),
              },
              ready: app.instance?.status === 'installed' && runtimeConnectionState(app) === 'running' && runtimeConnectionState(provider) === 'running',
              relationship: relationship ? {
                id: relationship.id,
                lastErrorCode: relationship.lastErrorCode,
                status: relationship.status,
                updatedAt: relationship.updatedAt,
              } : null,
              slotId: slot.id,
              title: slot.title,
            });
          }
        }
      }
      const missingUsefulPeers = (app.capabilities.usefulness.requiresOneOf || [])
        .filter((type) => !packages.some((candidate) => candidate.id !== app.id && (candidate.capabilities.exports || []).some((capability) => capability.type === type)))
        .map((type) => ({ type, message: app.capabilities.usefulness.emptyState || `Install a compatible ${type} app to use this package well.` }));
      return { ...app, compatibility: { connections, missingUsefulPeers } };
    });
  }

  iconPath(packageId) {
    const storedInstance = this.store.getAppInstanceByPackageId(packageId);
    const instance = storedInstance?.status === 'uninstalled' ? null : storedInstance;
    if (instance && instance.snapshotState !== 'installed') {
      throw new AppPackageServiceError('APP_ICON_NOT_FOUND', 'This app icon is unavailable until its installed package is recovered.', 404);
    }
    const packageDir = instance ? this.installedPackageFor(instance).packageDir : path.join(this.appsDir, packageId);
    if (!fs.existsSync(path.join(packageDir, 'manifest.json'))) {
      throw new AppPackageServiceError('APP_PACKAGE_NOT_FOUND', 'That app package is not available.', 404);
    }
    const { manifest } = readAppPackageManifest(packageDir);
    if (!manifest.icon) {
      throw new AppPackageServiceError('APP_ICON_NOT_FOUND', 'That app package does not declare an icon.', 404);
    }
    const normalized = path.posix.normalize(String(manifest.icon).replace(/\\/gu, '/'));
    if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
      throw new AppPackageServiceError('APP_ICON_NOT_FOUND', 'That app package icon is not available.', 404);
    }
    const iconPath = path.resolve(packageDir, normalized);
    const relative = path.relative(path.resolve(packageDir), iconPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(iconPath) || !fs.statSync(iconPath).isFile()) {
      throw new AppPackageServiceError('APP_ICON_NOT_FOUND', 'That app package icon is not available.', 404);
    }
    return iconPath;
  }

  // Resolves one catalog screenshot to its file inside the package the owner is
  // actually looking at (the installed snapshot when the app is installed, the
  // shipped catalog package otherwise). The index addresses the same filtered
  // screenshot list publicCatalog() projects, so the URLs the summary hands out
  // always land on the file the manifest declared at that position.
  screenshotPath(packageId, index) {
    const storedInstance = this.store.getAppInstanceByPackageId(packageId);
    const instance = storedInstance?.status === 'uninstalled' ? null : storedInstance;
    if (instance && instance.snapshotState !== 'installed') {
      throw new AppPackageServiceError('APP_SCREENSHOT_NOT_FOUND', 'This app screenshot is unavailable until its installed package is recovered.', 404);
    }
    const packageDir = instance ? this.installedPackageFor(instance).packageDir : path.join(this.appsDir, packageId);
    if (!fs.existsSync(path.join(packageDir, 'manifest.json'))) {
      throw new AppPackageServiceError('APP_PACKAGE_NOT_FOUND', 'That app package is not available.', 404);
    }
    const { manifest } = readAppPackageManifest(packageDir);
    const screenshots = (Array.isArray(manifest.catalog?.screenshots) ? manifest.catalog.screenshots : [])
      .filter((screenshot) => screenshot && typeof screenshot === 'object' && typeof screenshot.src === 'string' && screenshot.src.trim());
    const src = screenshots[index]?.src;
    if (!src || /^https?:\/\//iu.test(src)) {
      throw new AppPackageServiceError('APP_SCREENSHOT_NOT_FOUND', 'That app package screenshot is not available.', 404);
    }
    const normalized = path.posix.normalize(String(src).replace(/\\/gu, '/'));
    if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
      throw new AppPackageServiceError('APP_SCREENSHOT_NOT_FOUND', 'That app package screenshot is not available.', 404);
    }
    const screenshotPath = path.resolve(packageDir, normalized);
    const relative = path.relative(path.resolve(packageDir), screenshotPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(screenshotPath) || !fs.statSync(screenshotPath).isFile()) {
      throw new AppPackageServiceError('APP_SCREENSHOT_NOT_FOUND', 'That app package screenshot is not available.', 404);
    }
    return screenshotPath;
  }

  async installPackage(packageId, input = {}) {
    const current = this.store.getAppInstanceByPackageId(packageId);
    if (current) {
      if (current.status === 'uninstalled') {
        fs.rmSync(path.join(this.secretDir, current.id), { recursive: true, force: true });
        this.store.deleteAppInstance({ instanceId: current.id });
      } else {
        return publicInstance(this.withGuideState(current), this.store.getAppProjections(current.id), this.store.getAppConfig(current.id));
      }
    }

    const packageDir = path.join(this.appsDir, packageId);
    if (!fs.existsSync(path.join(packageDir, 'manifest.json'))) {
      throw new AppPackageServiceError('APP_PACKAGE_NOT_FOUND', 'That app package is not available.', 404);
    }
    const { manifest } = readAppPackageManifest(packageDir);
    if (!this.agent?.snapshotPackage) {
      throw new AppPackageServiceError('APP_AGENT_UNAVAILABLE', 'App package snapshot system agent is unavailable.', 503);
    }
    await this.assertArchitectureSupported(manifest);
    const at = this.now().toISOString();
    const manifestDigest = digestFor(manifest);
    // Digesting parses privacy-review.json and validates package contents, so
    // a malformed file must surface as a classified conflict, not an
    // unclassified 500 from a raw parse error.
    let packageDigest;
    try {
      packageDigest = digestAppPackage(packageDir);
    } catch (error) {
      throw new AppPackageServiceError('APP_PACKAGE_INVALID', `The app package contents are not valid: ${error.message}`, 409);
    }
    const source = {
      kind: 'official-git',
      path: `apps/${manifest.id}`,
      repository: this.officialRepository,
      revision: packageDigest,
      trust: 'mos-reviewed',
    };
    let privacy = { posture: null, reviewedAt: null, status: 'review-required' };
    const privacyReviewPath = path.join(packageDir, 'privacy-review.json');
    if (fs.existsSync(privacyReviewPath)) {
      let review;
      try {
        review = JSON.parse(fs.readFileSync(privacyReviewPath, 'utf8'));
      } catch {
        throw new AppPackageServiceError('APP_PRIVACY_REVIEW_INVALID', 'The app privacy review is not valid JSON.', 409);
      }
      // The direct repo install path has no resolved git revision of its own
      // (packageDigest above is a stand-in). A review's declared revision is
      // part of the hashed package contents, so it can never equal the
      // package digest; adopt the commit the review was authored against,
      // matching scripts/app-privacy-check.cjs. Every other binding field is
      // still validated below.
      if (typeof review?.scope?.source?.revision === 'string' && review.scope.source.revision.trim()) {
        source.revision = review.scope.source.revision;
      }
      const errors = validatePrivacyBinding(review, { manifest, packageDigest, source });
      if (errors.length) {
        throw new AppPackageServiceError('APP_PRIVACY_REVIEW_INVALID', `The app privacy review is not valid: ${errors.join(' ')}`, 409);
      }
      privacy = { posture: review.posture, reviewedAt: review.reviewedAt, status: 'reviewed' };
    }
    const instance = {
      categorySnapshot: manifest.category,
      displayNameSnapshot: manifest.name,
      id: crypto.randomUUID(),
      manifestDigest,
      packageDigest,
      packageId: manifest.id,
      packageVersion: manifest.version,
      privacy,
      source,
    };
    const snapshot = await this.agent.snapshotPackage({
      instanceId: instance.id,
      packageDigest,
      packageId: manifest.id,
    });
    if (!snapshot?.snapshotPath) {
      throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_INVALID', 'The app package snapshot agent did not return an installed snapshot path.', 502);
    }
    instance.snapshotPath = snapshot.snapshotPath;
    instance.snapshotState = 'installed';
    return this.completeInstall({
      at,
      // No instance row references this successfully created snapshot yet, so
      // ask the owning root agent to discard it before surfacing the failure.
      discardSnapshot: typeof this.agent.remove === 'function'
        ? () => this.agent.remove({
          installedSourceRevision: source.revision,
          instanceId: instance.id,
          packageId: manifest.id,
          services: [],
          volumes: [],
        })
        : null,
      input,
      instance,
      manifestId: manifest.id,
      packageId,
    });
  }

  // The tail every install shares once its snapshot exists on disk. Official and
  // external packages reach this point by different routes — different agent
  // calls, different identities, different trust — but from the snapshot onward
  // they are one pipeline: prove the snapshot is the package that was validated,
  // turn owner input into config rows, project the runtime, record the instance.
  // Kept in one place because a divergence here is a package installed against
  // an identity nothing checked, and the two callers would drift silently.
  //
  // `discardSnapshot` is the caller's way to disown a snapshot the store never
  // came to reference: nothing points at it, so the agent that created it is
  // asked to drop it before the failure surfaces.
  async completeInstall({ at, discardSnapshot = null, input, instance, manifestId, packageId, requestSource = null }) {
    try {
      const { manifest: installedManifest } = readAppPackageManifest(instance.snapshotPath);
      if (installedManifest.id !== manifestId || digestAppPackage(instance.snapshotPath) !== instance.packageDigest) {
        throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_INVALID', 'The installed app package snapshot does not match the validated source package.', 502);
      }
      const config = createConfigRows({ input, instanceId: instance.id, manifest: installedManifest, secretDir: this.secretDir });
      const projections = renderDryRunProjections(installedManifest, config, { packageId });
      this.store.installAppInstance({
        at,
        config,
        instance,
        operationId: crypto.randomUUID(),
        projections,
        request: {
          config: config.map((item) => ({ generated: item.source === 'generated', key: item.key, secret: item.secret === true, source: item.source })),
          dryRunOnly: true,
          packageId,
          packageVersion: instance.packageVersion,
          ...(requestSource ? { source: requestSource } : {}),
        },
      });
    } catch (error) {
      fs.rmSync(path.join(this.secretDir, instance.id), { recursive: true, force: true });
      await discardSnapshot?.().catch(() => {});
      throw error;
    }
    return publicInstance(
      this.withGuideState(this.store.getAppInstanceByPackageId(packageId)),
      this.store.getAppProjections(instance.id),
      this.store.getAppConfig(instance.id),
    );
  }

  // Secret files for values an update collected are written before the update can
  // commit them. When it does not commit, nothing references them, so they are
  // removed instead of being left on disk.
  discardCollectedSecrets(instanceId, configRows = []) {
    for (const row of configRows) {
      if (row.secretRef) fs.rmSync(secretFilePath(this.secretDir, instanceId, row.key), { force: true });
    }
  }

  // Route hosts are global to the MOS installation: two installed apps cannot
  // both serve `notes.<host>`. Refuse up front rather than let a package take a
  // web address another installed app already answers on.
  assertRouteHostsAvailable(manifest, packageId) {
    // Compared as effective hosts, which is what the stored projections hold and
    // what Caddy serves. Comparing the manifest's raw host against a projected
    // one would compare `notes` to `ext-notes` and find no clash, so two
    // external packages claiming the same address would both install and only
    // collide later, in the proxy.
    const requested = new Set((manifest.routes || []).map((route) => effectiveRouteHost(route.host, packageId)));
    for (const other of this.store.getAppInstances()) {
      if (other.packageId === packageId || other.status === 'uninstalled') continue;
      const caddy = this.store.getAppProjections(other.id).find((projection) => projection.kind === 'caddy')?.content;
      for (const route of Array.isArray(caddy?.routes) ? caddy.routes : []) {
        if (requested.has(route.host)) {
          throw new AppPackageServiceError('APP_ROUTE_HOST_TAKEN', `Another installed app already serves the web address "${route.host}".`, 409);
        }
      }
    }
  }

  // Install a downloaded external package that already passed the constrained
  // external-candidate gate. Deliberately separate from installPackage: the
  // package has no repository folder, so it is snapshotted from the confined
  // candidate root; its identity is the source-namespaced id rather than the id
  // it claims; and its trust and privacy status come from the recorded source,
  // never from package metadata. Everything from the snapshot onward is the same
  // pipeline official packages use.
  async installExternalPackage({ candidate, input = {} }) {
    const packageId = candidate?.namespacedPackageId;
    const manifest = candidate?.manifest;
    if (!packageId || !manifest || !candidate.packageDir || !candidate.packageDigest || candidate.source?.trust === 'mos-reviewed') {
      throw new AppPackageServiceError('APP_EXTERNAL_CANDIDATE_INVALID', 'This external app package cannot be installed.', 409);
    }
    const current = this.store.getAppInstanceByPackageId(packageId);
    if (current) {
      if (current.status === 'uninstalled') {
        fs.rmSync(path.join(this.secretDir, current.id), { recursive: true, force: true });
        this.store.deleteAppInstance({ instanceId: current.id });
      } else {
        return publicInstance(this.withGuideState(current), this.store.getAppProjections(current.id), this.store.getAppConfig(current.id));
      }
    }
    if (!this.agent?.snapshotExternalPackage) {
      throw new AppPackageServiceError('APP_AGENT_UNAVAILABLE', 'App package snapshot system agent is unavailable.', 503);
    }
    const agentStatus = await this.agent.status().catch(() => ({ capabilities: [] }));
    if (!agentStatus.capabilities?.includes('apps.package.snapshot.external')) {
      throw new AppPackageServiceError('APP_EXTERNAL_INSTALL_UNAVAILABLE', 'The installed app agent cannot snapshot external app packages.', 503);
    }
    await this.assertArchitectureSupported(manifest, agentStatus);
    this.assertRouteHostsAvailable(manifest, packageId);

    const at = this.now().toISOString();
    const instance = {
      categorySnapshot: manifest.category,
      displayNameSnapshot: manifest.name,
      id: crypto.randomUUID(),
      manifestDigest: digestFor(manifest),
      packageDigest: candidate.packageDigest,
      packageId,
      packageVersion: manifest.version,
      // MOS has not reviewed this package. A `privacy-review.json` the package
      // ships is not a MOS review, so the instance records review-required and
      // the Apps UI keeps showing it as unverified.
      privacy: { posture: null, reviewedAt: null, status: 'review-required' },
      source: candidate.source,
    };
    const snapshot = await this.agent.snapshotExternalPackage({
      candidateDigest: candidate.packageDigest,
      candidatePath: candidate.packageDir,
      instanceId: instance.id,
      packageId,
    });
    if (!snapshot?.snapshotPath) {
      throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_INVALID', 'The app package snapshot agent did not return an installed snapshot path.', 502);
    }
    instance.snapshotPath = snapshot.snapshotPath;
    instance.snapshotState = 'installed';
    return this.completeInstall({
      at,
      input,
      instance,
      manifestId: manifest.id,
      packageId,
      requestSource: { kind: instance.source.kind, repository: instance.source.repository, revision: instance.source.revision, trust: instance.source.trust },
    });
  }

  withGuideState(instance) {
    if (!instance) return null;
    return { ...instance, guideState: this.store.getAppGuideState(instance.id) };
  }

  setPackageGuideStatus(packageId, status) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || !['installed', 'disabled'].includes(instance.status)) {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before updating its setup guide.', 409);
    }
    const guideState = this.store.setAppGuideStatus({
      at: this.now().toISOString(),
      instanceId: instance.id,
      status,
    });
    return {
      guideState,
      instance: publicInstance(
        { ...this.store.getAppInstanceByPackageId(packageId), guideState },
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
    };
  }

  async addPackageToHomepage(packageId, homepageService, requestContext = {}) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status !== 'installed') {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before adding it to Homepage.', 409);
    }

    const projections = this.store.getAppProjections(instance.id);
    const homepageProjection = projections.find((projection) => projection.kind === 'homepage');
    if (!homepageProjection) {
      throw new AppPackageServiceError('APP_HOMEPAGE_PROJECTION_MISSING', 'This app does not expose a Homepage projection.', 409);
    }
    if (!runtimeApplied(projections)) {
      throw new AppPackageServiceError('APP_RUNTIME_NOT_APPLIED', 'Apply this app runtime before adding it to Homepage.', 409);
    }

    const current = await homepageService.read({ file: 'services.template.yaml' });
    const configRows = this.store.getAppConfig(instance.id).map((row) => (
      row.secretRef ? { ...row, rawValue: readSecretValue(this.secretDir, row.secretRef) } : row
    ));
    const result = await homepageService.addManagedApp({
      entry: homepageEntryForHomepage(instance, projections, configRows, requestContext),
      expectedRevision: current.revision,
      requestId: instance.id,
    });

    const at = this.now().toISOString();
    this.store.applyAppProjection({
      at,
      instanceId: instance.id,
      kind: 'homepage',
      operationId: crypto.randomUUID(),
      request: {
        packageId: instance.packageId,
        projectionDigest: homepageProjection.digest,
        target: 'homepage',
      },
    });

    return {
      homepage: result,
      instance: publicInstance(
        this.store.getAppInstanceByPackageId(packageId),
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
    };
  }

  // Startup migration for tiles written before hrefs became relative, which still
  // hold the absolute address of whichever door installed the app. It needs only
  // the ids, because `reconcileManagedUrls` derives every href from the id and
  // this is not an address change — widget endpoints are already correct.
  // Idempotent, so it is a no-op from the second boot onward.
  async reconcileDashboardLinks(homepageService) {
    const entries = this.store.getAppInstances()
      .filter((instance) => instance.status === 'installed' && homepageProjectionApplied(this.store.getAppProjections(instance.id)))
      .map((instance) => ({ id: instance.id }));
    if (!entries.length) return { changed: false, status: 'skipped' };
    try {
      return { changed: (await homepageService.reconcileUrls({ entries })).changed === true, status: 'applied' };
    } catch (error) {
      return { changed: false, errorCode: error.code || 'HOMEPAGE_DASHBOARD_LINK_RECONCILE_FAILED', status: 'failed' };
    }
  }

  async reconcilePublicUrls(homepageService, requestContext = {}) {
    const runtime = [];
    const homepageEntries = [];
    const homepageEntryFailures = [];
    for (const instance of this.store.getAppInstances()) {
      if (instance.status !== 'installed') continue;
      const projections = this.store.getAppProjections(instance.id);
      if (homepageProjectionApplied(projections)) {
        try {
          const configRows = this.store.getAppConfig(instance.id).map((row) => (
            row.secretRef ? { ...row, rawValue: readSecretValue(this.secretDir, row.secretRef) } : row
          ));
          // The tile's own href is derived from its id and needs nothing from
          // here. This still resolves the entry because a widget's endpoints are
          // absolute and have to be re-derived against the new address.
          const entry = homepageEntryForHomepage(instance, projections, configRows, requestContextForPackage(instance.packageId, requestContext));
          homepageEntries.push({
            id: instance.id,
            ...(entry.widget === undefined ? {} : { widget: entry.widget }),
          });
        } catch (error) {
          homepageEntryFailures.push({
            errorCode: error.code || 'APP_HOMEPAGE_ENTRY_RECONCILE_FAILED',
            id: instance.id,
            packageId: instance.packageId,
            status: 'failed',
          });
        }
      }
    }

    let homepage;
    try {
      homepage = await homepageService.reconcileUrls({ entries: homepageEntries });
    } catch (error) {
      homepage = {
        errorCode: error.code || 'HOMEPAGE_PUBLIC_URL_RECONCILE_FAILED',
        status: 'failed',
      };
    }

    for (const instance of this.store.getAppInstances()) {
      if (instance.status !== 'installed') continue;
      const packageContext = requestContextForPackage(instance.packageId, requestContext);
      try {
        const result = await this.applyPackageRuntime(instance.packageId, packageContext);
        runtime.push({
          appHost: result.appHost || packageContext.appHost,
          packageId: instance.packageId,
          publicUrl: result.publicUrl || packageContext.publicUrl,
          status: result.status || 'applied',
        });
      } catch (error) {
        runtime.push({
          appHost: packageContext.appHost,
          errorCode: error.code || 'APP_RUNTIME_PUBLIC_URL_REAPPLY_FAILED',
          packageId: instance.packageId,
          publicUrl: packageContext.publicUrl,
          status: 'failed',
        });
      }
    }

    const homepageFailed = homepage?.status === 'failed' || homepageEntryFailures.length > 0;
    const runtimeFailed = runtime.some((item) => item.status === 'failed');
    const status = homepageFailed || runtimeFailed ? 'partial' : 'applied';

    return {
      homepage,
      homepageEntryFailures,
      runtime,
      status,
    };
  }

  async removePackageFromHomepage(instance, homepageService) {
    const projections = this.store.getAppProjections(instance.id);
    if (!homepageProjectionApplied(projections)) {
      return { skipped: true };
    }
    const current = await homepageService.read({ file: 'services.template.yaml' });
    return homepageService.removeLink({
      expectedRevision: current.revision,
      id: instance.id,
    });
  }

  // Serialized against updates under the same per-app key (see
  // restartPackageRuntime). stopPackageRuntime delegates here, so it must not
  // take the key itself.
  async disablePackage(packageId, homepageService) {
    return this.limiter.runExclusive(packageId, () => this.performDisablePackage(packageId, homepageService));
  }

  async performDisablePackage(packageId, _homepageService) {
    if (!this.agent) {
      throw new AppPackageServiceError('APP_AGENT_UNAVAILABLE', 'App runtime system agent is unavailable.', 503);
    }
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status === 'uninstalled') {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before disabling it.', 409);
    }
    if (instance.status === 'disabled') {
      return {
        agent: { status: 'skipped', steps: [] },
        homepage: { skipped: true },
        instance: publicInstance(instance, this.store.getAppProjections(instance.id), this.store.getAppConfig(instance.id)),
      };
    }
    if (instance.status !== 'installed') {
      throw new AppPackageServiceError('APP_INVALID_TRANSITION', 'This app cannot be stopped from its current state.', 409);
    }

    const projections = this.store.getAppProjections(instance.id);
    const services = projections.find((projection) => projection.kind === 'compose')?.content?.services || [];
    const agent = await this.agent.stop({ packageId: instance.packageId, services: services.map((service) => service.id) });
    const at = this.now().toISOString();
    this.store.markAppDisabled({
      at,
      instanceId: instance.id,
      operationId: crypto.randomUUID(),
      request: { packageId: instance.packageId, preserveData: true, target: 'runtime' },
    });
    this.store.markAppIntegrationsForInstance({
      at,
      errorCode: 'APP_INTEGRATION_APP_DISABLED',
      instanceId: instance.id,
      status: 'degraded',
    });
    return {
      agent,
      homepage: { skipped: true },
      instance: publicInstance(
        this.store.getAppInstanceByPackageId(packageId),
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
    };
  }

  async stopPackageRuntime(packageId) {
    return this.disablePackage(packageId, null);
  }

  // Serialized against updates under the same per-app key (see
  // restartPackageRuntime).
  async enablePackage(packageId, requestContext = {}) {
    return this.limiter.runExclusive(packageId, () => this.performEnablePackage(packageId, requestContext));
  }

  async performEnablePackage(packageId, requestContext = {}) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status === 'uninstalled') {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before enabling it.', 409);
    }
    if (instance.status === 'installed') {
      const applied = await this.applyPackageRuntime(packageId, requestContext);
      return {
        ...applied,
        integrations: await this.reconcilePackageIntegrations(packageId, requestContext),
      };
    }
    if (instance.status !== 'disabled') {
      throw new AppPackageServiceError('APP_INVALID_TRANSITION', 'This app cannot be enabled from its current state.', 409);
    }
    const applied = await this.applyPackageRuntime(packageId, requestContext, { allowDisabled: true });
    this.store.markAppEnabled({
      at: this.now().toISOString(),
      instanceId: instance.id,
      operationId: crypto.randomUUID(),
      request: { packageId: instance.packageId, target: 'runtime' },
    });
    return {
      ...applied,
      integrations: await this.reconcilePackageIntegrations(packageId, requestContext),
      instance: publicInstance(
        this.store.getAppInstanceByPackageId(packageId),
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
    };
  }

  // Serialized against updates under the same per-app key (see
  // restartPackageRuntime).
  async uninstallPackage(packageId, homepageService) {
    return this.limiter.runExclusive(packageId, () => this.performUninstallPackage(packageId, homepageService));
  }

  async performUninstallPackage(packageId, homepageService) {
    if (!this.agent) {
      throw new AppPackageServiceError('APP_AGENT_UNAVAILABLE', 'App runtime system agent is unavailable.', 503);
    }
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance) {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before uninstalling it.', 409);
    }
    if (!['installed', 'disabled'].includes(instance.status)) {
      throw new AppPackageServiceError('APP_INVALID_TRANSITION', 'This app cannot be uninstalled from its current state.', 409);
    }

    const projections = this.store.getAppProjections(instance.id);
    const composeProjection = projections.find((projection) => projection.kind === 'compose');
    const services = composeProjection?.content?.services || [];
    const volumes = composeProjection?.content?.volumes || [];
    const homepage = await this.removePackageFromHomepage(instance, homepageService);
    // An agent that cannot be asked what it supports is treated as one that
    // supports nothing here, because uninstalling is worth more than reclaiming.
    const agentStatus = await Promise.resolve(this.agent.status?.()).catch(() => null) || { capabilities: [] };
    // Deleting the instance row below drops the last reference to this app's
    // snapshot directory and to the revision naming its images, so an agent that
    // can reclaim them has to be told before that happens. Sent only to an agent
    // that asked for it: an older one rejects unknown removal fields outright,
    // and an uninstall it used to handle must not start failing.
    const agent = await this.agent.remove({
      ...(agentStatus.capabilities?.includes('apps.package.remove.reclaim')
        ? { instanceId: instance.id, ...(instance.sourceRevision ? { installedSourceRevision: instance.sourceRevision } : {}) }
        : {}),
      packageId: instance.packageId,
      services: services.map((service) => service.id),
      volumes,
    });
    fs.rmSync(path.join(this.secretDir, instance.id), { recursive: true, force: true });
    this.store.markAppIntegrationsForInstance({
      at: this.now().toISOString(),
      errorCode: 'APP_INTEGRATION_APP_UNINSTALLED',
      instanceId: instance.id,
      status: 'removed',
    });
    this.store.deleteAppInstance({ instanceId: instance.id });
    return {
      agent,
      homepage,
      instance: null,
    };
  }

  packageSummaryFor(manifest, validationErrors = []) {
    return publicPackageSummary(manifest, validationErrors);
  }
}

module.exports = {
  APP_LOOPBACK_PORT_BASE,
  APP_LOOPBACK_PORT_SPAN,
  AppPackageServiceError,
  AppPackageService,
  appRouteForHomepage,
  digestFor,
  healthTargetFor,
  homepageEntryForHomepage,
  loopbackPortFor,
  materializeRuntimeCaddy,
  materializeRuntimeCompose,
  renderDryRunProjections,
  resolveConfigTemplate,
  resolveTemplatesDeep,
  homepageProjectionApplied,
  runtimeApplied,
  stableJson,
};
