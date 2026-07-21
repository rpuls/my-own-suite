const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  AppPackageServiceError,
  createConfigRows,
  digestFor,
  homepageEntryForHomepage,
  homepageProjectionApplied,
  hostArchitectureOf,
  isRecord,
  materializeRuntimeCaddy,
  materializeRuntimeCompose,
  publicInstance,
  readSecretValue,
  renderInstanceProjections,
  setupFields,
} = require('./app-package-internals.cjs');
const { compareAppPackages } = require('./app-update-comparison.cjs');
const { digestAppPackage, parseNamespacedPackageId, validatePrivacyBinding } = require('./package-contracts.cjs');
const { instanceSourceId, sourceInstallable } = require('./external-source-registry.cjs');
const { readAppPackageManifest } = require('./package-manifest.cjs');

// What an interrupted update saga left behind, decided from the last stage it
// durably recorded. Every stage from `candidate-built` onward is past the point
// of no return: the runtime swap happens between the `candidate-built` and
// `candidate-healthy` writes, so a crash anywhere in that window may have left
// the candidate serving with the old containers gone. Restoring the recorded
// runtime is safe either way — re-applying a runtime that is already running
// changes nothing — while calling it retry-safe was a lie half the time. Only
// `snapshot-promoted` proves the swap finished, and that is a commit, not a
// rollback.
const ROLLBACK_REQUIRED_STAGES = Object.freeze(['candidate-built', 'candidate-healthy', 'homepage-reconciled']);

function updateRecoveryStateForStage(stage) {
  if (stage === 'snapshot-promoted') return 'commit-required';
  return ROLLBACK_REQUIRED_STAGES.includes(stage) ? 'rollback-required' : 'retry-safe';
}

function updateRuntimeRequest({ config, expectedInstalledDigest, instance, manifest, packageDigest, projections, requestContext, sourceRevision }) {
  const compose = projections.find((item) => item.kind === 'compose');
  const caddy = projections.find((item) => item.kind === 'caddy');
  const health = projections.find((item) => item.kind === 'health');
  if (!compose || !caddy || !health) throw new AppPackageServiceError('APP_RUNTIME_PROJECTION_MISSING', 'The app update is missing runtime projections.', 409);
  return {
    appHost: requestContext.appHost,
    caddy: materializeRuntimeCaddy(caddy.content, config),
    compose: materializeRuntimeCompose(compose.content, config),
    ...(expectedInstalledDigest ? { expectedInstalledDigest } : {}),
    health: health.content,
    instanceId: instance.id,
    packageDigest,
    packageId: instance.packageId,
    packageVersion: manifest.version,
    publicUrl: requestContext.publicUrl,
    sourceRevision,
  };
}

// The app update saga: prepare, stage, build, activate, promote or roll back,
// commit — and the recovery of every window in between, whether an owner asks
// for it or a restart finds it.
//
// It is deliberately its own service. An update is the one operation that must
// reason about two packages at once and can leave a host mid-transaction, and
// mixing that state machine into the install/lifecycle orchestrator is what let
// it grow to the point where nobody could see the sequencing whole.
//
// Sequencing lives HERE, never behind the agent boundary: the agent performs
// individually verifiable steps, and this decides their order, what proves each
// one, and what happens when one fails.
//
// It owns no collaborators of its own. Install, lifecycle, runtime apply,
// integrations and Homepage stay in AppPackageService, and this calls back into
// that instance (`apps`) for them, so neither module imports the other.
class AppUpdateService {
  constructor({ apps }) {
    this.apps = apps;
  }

  // Collaborators are read through `apps` rather than captured at construction.
  // An update service that held its own copies would be a second place they
  // could be configured, and the two would silently disagree the moment either
  // was pointed somewhere else — the update saga is the last code that should
  // be talking to a different agent or store than the rest of the app service.
  get agent() { return this.apps.agent; }

  get catalogService() { return this.apps.catalogService; }

  get externalClient() { return this.apps.externalClient; }

  get limiter() { return this.apps.limiter; }

  get now() { return this.apps.now; }

  get platformVersion() { return this.apps.platformVersion; }

  get secretDir() { return this.apps.secretDir; }

  get store() { return this.apps.store; }

  // Where an update candidate comes from is decided by the source the instance
  // was installed from, never by the caller. Official instances take the reviewed
  // catalog; an external instance re-downloads from its own recorded source,
  // through the same constrained gate its install passed. Everything after this
  // point is the one update transaction.
  //
  // The revision is re-resolved on every call and nothing is persisted here, so a
  // preview stays side-effect-free and an apply always acts on the source as it
  // is right now rather than on a revision cached at preview time.
  async downloadUpdateCandidate(instance) {
    if (instance.sourceKind !== 'external-git') {
      if (!this.catalogService?.downloadCandidate) {
        throw new AppPackageServiceError('APP_CANDIDATE_UNAVAILABLE', 'The verified app catalog cannot prepare this update.', 503);
      }
      return this.catalogService.downloadCandidate(instance.packageId);
    }
    if (!this.externalClient?.downloadCandidate) {
      throw new AppPackageServiceError('APP_CANDIDATE_UNAVAILABLE', 'External package sources are unavailable.', 503);
    }
    const source = this.store.getAppSource(instanceSourceId(instance));
    if (!source) {
      throw new AppPackageServiceError('APP_SOURCE_UNAVAILABLE', 'The package source for this app is no longer registered, so it cannot be updated. The installed version keeps running.', 409);
    }
    if (!sourceInstallable(source)) {
      throw new AppPackageServiceError('APP_SOURCE_NOT_INSTALLABLE', 'This app package source is not active, so updates from it are blocked. The installed version keeps running.', 409);
    }
    const candidate = await this.externalClient.downloadCandidate(await this.externalClient.resolveRevision(source));
    // The repository must still publish the same package. If it now publishes a
    // different one, that is not an update to this app, whatever the repository
    // calls it. The app agent would refuse the identity anyway; refusing here
    // keeps a repository takeover from ever reaching an update operation.
    if (candidate.namespacedPackageId !== instance.packageId) {
      candidate.cleanup?.();
      throw new AppPackageServiceError('APP_SOURCE_PACKAGE_CHANGED', 'This repository no longer publishes the app package that was installed from it, so it cannot be updated. The installed version keeps running.', 409);
    }
    return candidate;
  }

  async recoverInterruptedUpdates(requestContext = {}) {
    const at = this.now().toISOString();
    const results = this.store.interruptedAppUpdates().map((operation) => {
      const recoveryState = updateRecoveryStateForStage(operation.stage);
      this.store.failAppUpdate({
        at,
        errorCode: 'APP_UPDATE_INTERRUPTED',
        instanceId: operation.instanceId,
        operationId: operation.id,
        recoveryState,
        stage: `${operation.stage || 'unknown'}-interrupted`,
      });
      return { ...operation, recoveryState, status: 'recovery-required' };
    });
    // Finish every pending commit before anything can list or touch the wedged
    // instance. The disk decides: an installed snapshot that carries the
    // candidate's digest proves the promotion happened, whatever stage the
    // crashed process managed to write — including a crash between the agent's
    // promote returning and the `snapshot-promoted` write, which the
    // stage-based labeling above can only call rollback-required.
    for (const instance of this.store.getAppInstances()) {
      if (instance.status === 'uninstalled') continue;
      if (!['commit-required', 'rollback-required'].includes(instance.updateRecoveryState)) continue;
      const operation = this.store.latestAppUpdateOperation(instance.id);
      if (!operation || operation.status !== 'failed') continue;
      let promoted = false;
      try { promoted = digestAppPackage(instance.snapshotPath) === operation.candidateDigest; } catch {}
      if (!promoted) {
        // rollback-required with the old snapshot still installed is labeled
        // truthfully; restoring the runtime restarts containers, so it stays an
        // owner action instead of something a reboot does on its own.
        if (instance.updateRecoveryState === 'rollback-required') continue;
        results.push({ errorCode: 'APP_PACKAGE_SNAPSHOT_INVALID', instanceId: instance.id, recoveryState: 'commit-required', status: 'commit-blocked' });
        continue;
      }
      try {
        this.commitPromotedPackageUpdate(instance, operation);
        // A commit only writes bookkeeping, so a promoted update whose provider
        // an app is integrated with would otherwise stay recorded against the
        // superseded package: the consumer keeps running the runtime the old
        // provider produced, and nothing re-applies it. The owner-clicked
        // recovery and the ordinary update path both reconcile here, so a
        // recovery that a restart performs instead must too, or whether an
        // integration survives an update comes down to who noticed it first.
        // Best-effort like those paths: the commit is already durable, and a
        // provider that cannot be reconciled is recorded as degraded rather
        // than undoing it.
        let integrations = [];
        try { integrations = await this.apps.reconcilePackageIntegrations(instance.packageId, requestContext); } catch {}
        results.push({ instanceId: instance.id, integrations, recoveryState: 'none', status: 'committed' });
      } catch (error) {
        results.push({ errorCode: error.code || 'APP_UPDATE_COMMIT_FAILED', instanceId: instance.id, recoveryState: instance.updateRecoveryState, status: 'commit-blocked' });
      }
    }
    return results;
  }

  // Durably commit an update whose snapshot promotion already happened. Pure
  // bookkeeping by design — the candidate is installed on disk and its
  // containers are serving; nothing here touches the runtime, which is what
  // makes it safe to run unattended at startup. Every input is re-proved
  // against the disk before anything is written.
  commitPromotedPackageUpdate(instance, operation = this.store.latestAppUpdateOperation(instance.id)) {
    if (!operation || operation.status !== 'failed' || !operation.candidateDigest) {
      throw new AppPackageServiceError('APP_UPDATE_COMMIT_UNAVAILABLE', 'No interrupted app update is waiting to be committed for this app.', 409);
    }
    const recovery = operation.request?.recovery;
    if (!recovery?.manifestDigest || !recovery.candidateSource || !recovery.privacy) {
      throw new AppPackageServiceError('APP_UPDATE_COMMIT_UNAVAILABLE', 'The interrupted app update did not record what a commit needs, so it cannot be finished.', 409);
    }
    let manifest;
    let diskDigest;
    try {
      ({ manifest } = readAppPackageManifest(instance.snapshotPath));
      diskDigest = digestAppPackage(instance.snapshotPath);
    } catch {
      throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_INVALID', 'The installed app package snapshot cannot be read, so the interrupted update cannot be committed.', 409);
    }
    if (diskDigest !== operation.candidateDigest
        || manifest.id !== parseNamespacedPackageId(instance.packageId).packageId
        || digestFor(manifest) !== recovery.manifestDigest) {
      throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_INVALID', 'The installed snapshot is not the promoted update candidate, so the interrupted update cannot be committed.', 409);
    }
    const heldKeys = new Set(this.store.getAppConfig(instance.id).map((row) => row.key));
    const addedConfig = (recovery.addedConfig || [])
      .filter((row) => !heldKeys.has(row.key))
      .map((row) => ({
        ...row,
        secret: Boolean(row.secretRef),
        value: row.valueJson === null || row.valueJson === undefined ? undefined : JSON.parse(row.valueJson),
      }));
    const projections = renderInstanceProjections(manifest, [...this.store.getAppConfig(instance.id), ...addedConfig], {
      instanceId: instance.id,
      integrations: this.store.getAppIntegrations(),
      packageId: instance.packageId,
    });
    const homepageApplied = homepageProjectionApplied(this.store.getAppProjections(instance.id));
    return this.store.completeAppUpdate({
      at: this.now().toISOString(),
      config: addedConfig,
      fromRecovery: true,
      homepageApplied,
      instance: {
        categorySnapshot: recovery.categorySnapshot,
        displayNameSnapshot: recovery.displayNameSnapshot,
        manifestDigest: recovery.manifestDigest,
        packageDigest: diskDigest,
        packageVersion: manifest.version,
        privacy: recovery.privacy,
        source: recovery.candidateSource,
      },
      instanceId: instance.id,
      operationId: operation.id,
      projections,
      snapshotPath: instance.snapshotPath,
    });
  }

  // The owner-facing recovery action behind the "needs attention" notice. It
  // resolves whichever state the failed update actually left: a promoted
  // snapshot gets its commit finished, an un-promoted one gets the recorded
  // runtime restored through the agent's rollback. Held under the app's
  // operation key like every other mutation of the instance.
  async recoverPackageUpdate(packageId, requestContext = {}) {
    return this.limiter.runExclusive(packageId, () => this.performRecoverPackageUpdate(packageId, requestContext));
  }

  async performRecoverPackageUpdate(packageId, requestContext = {}) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status === 'uninstalled') {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before recovering it.', 409);
    }
    if (!['commit-required', 'rollback-required'].includes(instance.updateRecoveryState)) {
      throw new AppPackageServiceError('APP_UPDATE_RECOVERY_NOT_REQUIRED', 'This app has no update recovery to perform. If its last update stopped before changing anything, simply run the update again.', 409);
    }
    const operation = this.store.latestAppUpdateOperation(instance.id);
    if (!operation || operation.status !== 'failed') {
      throw new AppPackageServiceError('APP_UPDATE_RECOVERY_UNAVAILABLE', 'The interrupted app update could not be found, so it cannot be recovered.', 409);
    }
    let promoted = false;
    try { promoted = digestAppPackage(instance.snapshotPath) === operation.candidateDigest; } catch {}

    if (promoted) {
      const committed = this.commitPromotedPackageUpdate(instance, operation);
      let integrations = [];
      try { integrations = await this.apps.reconcilePackageIntegrations(packageId, requestContext); } catch {}
      return {
        action: 'committed',
        instance: publicInstance(
          this.apps.withGuideState(this.store.getAppInstanceByPackageId(packageId)),
          this.store.getAppProjections(instance.id),
          this.store.getAppConfig(instance.id),
        ),
        integrations,
        operation: committed,
      };
    }

    // The snapshot on disk is still the recorded one, so recovery means putting
    // the recorded runtime back in charge. The candidate runtime the agent must
    // tear down is rebuilt from what the update stashed for exactly this:
    // secret-free candidate projections plus the collected config rows.
    const recovery = operation.request?.recovery;
    if (!Array.isArray(recovery?.candidateProjections) || !recovery.candidateProjections.length) {
      throw new AppPackageServiceError('APP_UPDATE_RECOVERY_UNAVAILABLE', 'The interrupted app update did not record what a runtime restore needs.', 409);
    }
    if (!this.agent?.rollbackPackageUpdate) {
      throw new AppPackageServiceError('APP_AGENT_UNAVAILABLE', 'App runtime system agent is unavailable.', 503);
    }
    const installedPackage = this.apps.installedPackageFor(instance);
    const configRows = this.store.getAppConfig(instance.id).map((row) => (
      row.secretRef ? { ...row, rawValue: readSecretValue(this.secretDir, row.secretRef) } : row
    ));
    const heldKeys = new Set(configRows.map((row) => row.key));
    // A missing collected secret is tolerated: the rollback only needs the
    // candidate's service identities to tear it down, never its secret values.
    const addedConfig = (recovery.addedConfig || []).filter((row) => !heldKeys.has(row.key)).map((row) => {
      const base = {
        ...row,
        secret: Boolean(row.secretRef),
        value: row.valueJson === null || row.valueJson === undefined ? undefined : JSON.parse(row.valueJson),
      };
      if (!row.secretRef) return base;
      try { return { ...base, rawValue: readSecretValue(this.secretDir, row.secretRef) }; } catch { return base; }
    });
    const installedProjections = this.store.getAppProjections(instance.id);
    const installedRuntime = updateRuntimeRequest({
      config: configRows,
      instance,
      manifest: installedPackage.manifest,
      packageDigest: instance.packageDigest,
      projections: installedProjections,
      requestContext,
      sourceRevision: instance.sourceRevision,
    });
    const candidateRuntime = updateRuntimeRequest({
      config: [...configRows, ...addedConfig],
      expectedInstalledDigest: instance.packageDigest,
      instance,
      manifest: { version: operation.request.packageVersion },
      packageDigest: operation.candidateDigest,
      projections: recovery.candidateProjections.map((projection) => ({ ...projection, content: JSON.parse(projection.contentJson) })),
      requestContext,
      sourceRevision: recovery.candidateSource?.revision,
    });
    await this.agent.rollbackPackageUpdate({ candidate: candidateRuntime, installed: installedRuntime });
    this.apps.discardCollectedSecrets(instance.id, addedConfig);

    let homepage = { skipped: true };
    if (operation.stage?.startsWith('homepage-reconciled') && homepageProjectionApplied(installedProjections) && requestContext.homepageService) {
      try {
        const current = await requestContext.homepageService.read({ file: 'services.template.yaml' });
        homepage = await requestContext.homepageService.add({
          entry: homepageEntryForHomepage(instance, installedProjections, configRows, requestContext),
          expectedRevision: current.revision,
          requestId: instance.id,
        }, false);
      } catch (error) {
        homepage = { errorCode: error.code || 'APP_UPDATE_HOMEPAGE_ROLLBACK_FAILED', status: 'failed' };
      }
    }
    this.store.clearAppUpdateRecovery({ at: this.now().toISOString(), instanceId: instance.id });
    let integrations = [];
    try { integrations = await this.apps.reconcilePackageIntegrations(packageId, requestContext); } catch {}
    return {
      action: 'rolled-back',
      homepage,
      instance: publicInstance(
        this.apps.withGuideState(this.store.getAppInstanceByPackageId(packageId)),
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
      integrations,
    };
  }

  async preparePackageUpdate(packageId) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status === 'uninstalled') throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before preparing an update.', 409);
    const installedPackage = this.apps.installedPackageFor(instance);
    let candidate;
    try {
      candidate = await this.downloadUpdateCandidate(instance);
      const agentStatus = await this.agent?.status().catch(() => ({ capabilities: [] })) || { capabilities: [] };
      return compareAppPackages({
        agentCapabilities: Array.isArray(agentStatus.capabilities) ? agentStatus.capabilities : [],
        agentContractVersion: Number.isInteger(agentStatus.contractVersion) ? agentStatus.contractVersion : 0,
        candidate,
        hostArchitecture: hostArchitectureOf(agentStatus),
        installed: { ...installedPackage, packageDigest: instance.packageDigest, source: {
          kind: instance.sourceKind,
          path: instance.sourcePath,
          repository: instance.sourceRepository,
          revision: instance.sourceRevision,
          trust: instance.sourceTrust,
        } },
        platformVersion: this.platformVersion,
      });
    } catch (error) {
      if (error instanceof AppPackageServiceError) throw error;
      throw new AppPackageServiceError(error.code || 'APP_CANDIDATE_INVALID', error.message || 'The app update candidate is invalid.', 409);
    } finally { candidate?.cleanup?.(); }
  }

  // The whole update transaction is held under the app's key, not just its
  // durable part: the download, build, and runtime swap all happen before the
  // store has a record it could refuse a second update against.
  async stagePackageUpdate(packageId, input = {}, requestContext = {}) {
    return this.limiter.runExclusive(packageId, () => this.performStageUpdate(packageId, input, requestContext));
  }

  async performStageUpdate(packageId, input = {}, requestContext = {}) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status === 'uninstalled') throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before staging an update.', 409);
    // Activation starts the candidate's containers, so updating a disabled app
    // would end with containers running while the store says disabled.
    if (instance.status !== 'installed') {
      throw new AppPackageServiceError('APP_UPDATE_APP_DISABLED', 'Start this app before updating it. Updating a stopped app would start it.', 409);
    }
    // rollback-required and commit-required mean the runtime or snapshot no
    // longer matches what the store records, and beginning a new update would
    // start by wiping that flag and verifying against the stale record.
    // retry-safe deliberately passes: retrying the update is its recovery.
    if (['commit-required', 'rollback-required'].includes(instance.updateRecoveryState)) {
      throw new AppPackageServiceError('APP_UPDATE_RECOVERY_REQUIRED', 'This app needs recovery from its last update before a new update can start.', 409);
    }
    if (typeof input.confirmationToken !== 'string' || !/^[a-f0-9]{64}$/u.test(input.confirmationToken)) {
      throw new AppPackageServiceError('APP_UPDATE_CONFIRMATION_INVALID', 'Prepare and confirm this exact app update before staging it.', 400);
    }
    if (!this.agent?.stagePackageUpdate || !this.agent?.buildPackageUpdate || !this.agent?.activatePackageUpdate || !this.agent?.rollbackPackageUpdate || !this.agent?.promotePackageUpdate) {
      throw new AppPackageServiceError('APP_UPDATE_STAGING_UNAVAILABLE', 'App update staging is unavailable.', 503);
    }
    const installedPackage = this.apps.installedPackageFor(instance);
    let candidate;
    let operationId = null;
    let lastDurableStage = null;
    let homepageRollback = null;
    let activatedRuntimes = null;
    let snapshotPromoted = false;
    let addedConfig = [];
    try {
      candidate = await this.downloadUpdateCandidate(instance);
      const agentStatus = await this.agent.status();
      const comparison = compareAppPackages({
        agentCapabilities: Array.isArray(agentStatus.capabilities) ? agentStatus.capabilities : [],
        agentContractVersion: Number.isInteger(agentStatus.contractVersion) ? agentStatus.contractVersion : 0,
        candidate,
        hostArchitecture: hostArchitectureOf(agentStatus),
        installed: { ...installedPackage, packageDigest: instance.packageDigest, source: {
          kind: instance.sourceKind,
          path: instance.sourcePath,
          repository: instance.sourceRepository,
          revision: instance.sourceRevision,
          trust: instance.sourceTrust,
        } },
        platformVersion: this.platformVersion,
      });
      if (comparison.confirmationToken !== input.confirmationToken) {
        throw new AppPackageServiceError('APP_UPDATE_IDENTITY_CHANGED', 'The installed app or update candidate changed after preview. Review the update again.', 409);
      }
      if (comparison.compatibility === 'unsupported') {
        throw new AppPackageServiceError('APP_UPDATE_UNSUPPORTED', 'This update is not compatible with the current MOS installation.', 409);
      }
      // Only a newer package is an ordinary update. Serving an older one is how a
      // compromised or force-pushed source walks an app back to a version whose
      // holes are already published, and because the source is re-resolved on
      // every apply, nothing but this refuses it. Recovering from a bad update is
      // a different act with a different risk, so it takes an explicit decision
      // rather than the same button that installs an update.
      if (comparison.updateStatus === 'current') {
        throw new AppPackageServiceError('APP_UPDATE_NOT_AVAILABLE', 'This app already runs the package its source offers, so there is nothing to update.', 409);
      }
      if (comparison.updateStatus === 'installed-newer' && input.allowDowngrade !== true) {
        throw new AppPackageServiceError(
          'APP_UPDATE_DOWNGRADE_BLOCKED',
          `The source offers version ${comparison.candidate.packageVersion}, which is older than the installed version ${comparison.installed.packageVersion}. Confirm an explicit downgrade to install it anyway.`,
          409,
        );
      }
      // A candidate MOS has not reviewed may not quietly widen what it reaches
      // for. Its route hosts are re-checked against every other installed app, the
      // same way its install was, so an update cannot take over a web address
      // another app already answers on.
      if (candidate.source?.trust !== 'mos-reviewed') this.apps.assertRouteHostsAvailable(candidate.manifest, instance.packageId);
      // An update is one transaction through promote. An agent that could stage
      // and build but not activate/rollback/promote used to be accepted and then
      // abandoned mid-transaction, leaving the operation row running forever and
      // every later update refused until restart. Under the repo's managed-update
      // rule that tier cannot legitimately exist, so it is refused here — before
      // any durable operation record is created — instead of half-served.
      const requiredUpdateCapabilities = ['apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'];
      if (agentStatus.contractVersion < 6 || requiredUpdateCapabilities.some((capability) => !agentStatus.capabilities?.includes(capability))) {
        throw new AppPackageServiceError('APP_UPDATE_STAGING_UNAVAILABLE', 'The installed app agent cannot apply package updates end to end. Update MOS so its app agent is current, then retry this app update.', 503);
      }
      const installedConfigRows = this.store.getAppConfig(instance.id).map((row) => (
        row.secretRef ? { ...row, rawValue: readSecretValue(this.secretDir, row.secretRef) } : row
      ));
      // Setup values the candidate newly requires are collected in the update
      // dialog and become config rows here. Only fields the instance does not
      // already hold are created, so an update never rotates a generated secret or
      // overwrites a value the owner set.
      const heldKeys = new Set(installedConfigRows.map((row) => row.key));
      addedConfig = createConfigRows({
        input: { config: isRecord(input.config) ? input.config : {} },
        instanceId: instance.id,
        manifest: { ...candidate.manifest, setup: { ...candidate.manifest.setup, fields: setupFields(candidate.manifest).filter((field) => !heldKeys.has(field.id)) } },
        secretDir: this.secretDir,
      });
      const candidateConfig = [...installedConfigRows, ...addedConfig];
      let candidatePrivacy = { posture: 'review-required', reviewedAt: null, status: 'review-required' };
      const candidateReviewPath = path.join(candidate.packageDir, 'privacy-review.json');
      // A package-shipped review counts as a review only from a MOS-reviewed
      // source. An external candidate can ship a `privacy-review.json` claiming
      // any posture it likes, so it stays review-required however it updates.
      if (candidate.source?.trust === 'mos-reviewed' && fs.existsSync(candidateReviewPath)) {
        // Fenced like every other read of a package-shipped review: a candidate
        // is remote content, and a malformed file must fail the update as a
        // classified conflict rather than an unclassified 500. Digesting the
        // candidate happens to parse this file first today, which would make an
        // unfenced parse here safe by accident and broken by any reordering.
        let review;
        try {
          review = JSON.parse(fs.readFileSync(candidateReviewPath, 'utf8'));
        } catch {
          throw new AppPackageServiceError('APP_PRIVACY_REVIEW_INVALID', 'The candidate privacy review is not valid JSON.', 409);
        }
        const errors = validatePrivacyBinding(review, { manifest: candidate.manifest, packageDigest: candidate.packageDigest, source: candidate.source });
        if (errors.length) throw new AppPackageServiceError('APP_PRIVACY_REVIEW_INVALID', `The candidate privacy review is invalid: ${errors.join(' ')}`, 409);
        candidatePrivacy = { posture: review.posture, reviewedAt: review.reviewedAt, status: 'reviewed' };
      }
      const candidateProjections = renderInstanceProjections(candidate.manifest, candidateConfig, {
        instanceId: instance.id,
        integrations: this.store.getAppIntegrations(),
        packageId: instance.packageId,
      });
      const composeProjection = candidateProjections.find((projection) => projection.kind === 'compose');
      const caddyProjection = candidateProjections.find((projection) => projection.kind === 'caddy');
      const healthProjection = candidateProjections.find((projection) => projection.kind === 'health');
      if (!composeProjection || !caddyProjection || !healthProjection) {
        throw new AppPackageServiceError('APP_RUNTIME_PROJECTION_MISSING', 'The update candidate is missing runtime projections.', 409);
      }
      const at = this.now().toISOString();
      const newOperationId = crypto.randomUUID();
      try {
        this.store.beginAppUpdate({
          at,
          candidateDigest: candidate.packageDigest,
          expectedInstalledDigest: instance.packageDigest,
          instanceId: instance.id,
          operationId: newOperationId,
          // `recovery` is everything a later process needs to finish this update
          // when this one dies after the point of no return: commit inputs the
          // candidate download no longer exists to provide, the secret-free
          // candidate projections a recovery rollback rebuilds the runtime
          // request from, and the collected config rows (values for plain
          // fields, file references for secrets — never secret material).
          request: {
            packageId,
            packageVersion: candidate.manifest.version,
            recovery: {
              addedConfig: addedConfig.map((row) => ({
                fingerprint: row.fingerprint ?? null,
                key: row.key,
                redactedLabel: row.redactedLabel ?? null,
                secretRef: row.secretRef ?? null,
                source: row.source,
                valueJson: row.valueJson ?? null,
              })),
              candidateProjections: candidateProjections.map((projection) => ({
                contentJson: projection.contentJson,
                digest: projection.digest,
                kind: projection.kind,
              })),
              candidateSource: candidate.source,
              categorySnapshot: candidate.manifest.category,
              displayNameSnapshot: candidate.manifest.name,
              manifestDigest: digestFor(candidate.manifest),
              privacy: candidatePrivacy,
            },
          },
        });
      } catch (error) {
        if (error.message === 'APP_UPDATE_ALREADY_RUNNING') throw new AppPackageServiceError('APP_UPDATE_ALREADY_RUNNING', 'An update operation is already active for this app.', 409);
        throw error;
      }
      operationId = newOperationId;
      const staged = await this.agent.stagePackageUpdate({
        candidateDigest: candidate.packageDigest,
        candidatePath: candidate.packageDir,
        expectedInstalledDigest: instance.packageDigest,
        instanceId: instance.id,
        packageId,
      });
      this.store.advanceAppUpdate({ instanceId: instance.id, operationId, stage: 'candidate-staged' });
      lastDurableStage = 'candidate-staged';
      const built = await this.agent.buildPackageUpdate({
        appHost: requestContext.appHost,
        caddy: materializeRuntimeCaddy(caddyProjection.content, candidateConfig),
        compose: materializeRuntimeCompose(composeProjection.content, candidateConfig),
        expectedInstalledDigest: instance.packageDigest,
        health: healthProjection.content,
        instanceId: instance.id,
        packageDigest: candidate.packageDigest,
        packageId,
        packageVersion: candidate.manifest.version,
        publicUrl: requestContext.publicUrl,
        sourceRevision: candidate.source.revision,
      });
      let operation = this.store.advanceAppUpdate({ instanceId: instance.id, operationId, stage: 'candidate-built' });
      lastDurableStage = 'candidate-built';

      // The runtime that has to come back if this update fails is the installed
      // one, so it is rebuilt from the values it actually runs with rather than
      // from the candidate's.
      const installedConfig = installedConfigRows;
      const installedProjections = this.store.getAppProjections(instance.id);
      const homepageWasApplied = homepageProjectionApplied(installedProjections);
      const installedRuntime = updateRuntimeRequest({
        config: installedConfig,
        instance,
        manifest: installedPackage.manifest,
        packageDigest: instance.packageDigest,
        projections: installedProjections,
        requestContext,
        sourceRevision: instance.sourceRevision,
      });
      const candidateRuntime = updateRuntimeRequest({
        config: candidateConfig,
        expectedInstalledDigest: instance.packageDigest,
        instance,
        manifest: candidate.manifest,
        packageDigest: candidate.packageDigest,
        projections: candidateProjections,
        requestContext,
        sourceRevision: candidate.source.revision,
      });
      const activated = await this.agent.activatePackageUpdate({ candidate: candidateRuntime, installed: installedRuntime });
      activatedRuntimes = { candidate: candidateRuntime, installed: installedRuntime };
      operation = this.store.advanceAppUpdate({ instanceId: instance.id, operationId, stage: 'candidate-healthy' });
      lastDurableStage = 'candidate-healthy';

      let homepage = { skipped: true };
      if (homepageWasApplied) {
        if (!requestContext.homepageService) {
          throw new AppPackageServiceError('APP_UPDATE_HOMEPAGE_UNAVAILABLE', 'The candidate is healthy, but its existing Homepage entry cannot be reconciled. Recovery is required.', 503);
        }
        const current = await requestContext.homepageService.read({ file: 'services.template.yaml' });
        const candidateInstance = {
          ...instance,
          categorySnapshot: candidate.manifest.category,
          displayNameSnapshot: candidate.manifest.name,
          packageVersion: candidate.manifest.version,
        };
        homepageRollback = {
          entry: homepageEntryForHomepage(instance, installedProjections, installedConfig, requestContext),
          homepageService: requestContext.homepageService,
        };
        homepage = await requestContext.homepageService.add({
          entry: homepageEntryForHomepage(candidateInstance, candidateProjections, candidateConfig, requestContext),
          expectedRevision: current.revision,
          requestId: instance.id,
        }, false);
        operation = this.store.advanceAppUpdate({ instanceId: instance.id, operationId, stage: 'homepage-reconciled' });
        lastDurableStage = 'homepage-reconciled';
      }
      const rollbackSafe = candidate.manifest.update?.rollback === 'safe';
      // The revision names the images the outgoing package was built into, which
      // is the only thing standing between an updated app and a copy of every
      // image it has ever run. It is sent only to an agent that asked for it: an
      // older agent rejects unknown promotion fields outright, and refusing a
      // promotion at this point would strand an update whose candidate is
      // already serving traffic.
      const promoted = await this.agent.promotePackageUpdate({
        candidateDigest: candidate.packageDigest,
        expectedInstalledDigest: instance.packageDigest,
        ...(agentStatus.capabilities?.includes('apps.package.update.reclaim') && instance.sourceRevision
          ? { installedSourceRevision: instance.sourceRevision }
          : {}),
        instanceId: instance.id,
        packageId,
        rollbackSafe,
      });
      snapshotPromoted = true;
      operation = this.store.advanceAppUpdate({ instanceId: instance.id, operationId, stage: 'snapshot-promoted' });
      lastDurableStage = 'snapshot-promoted';
      operation = this.store.completeAppUpdate({
        at: this.now().toISOString(),
        config: addedConfig,
        instance: {
          categorySnapshot: candidate.manifest.category,
          displayNameSnapshot: candidate.manifest.name,
          manifestDigest: digestFor(candidate.manifest),
          packageDigest: candidate.packageDigest,
          packageVersion: candidate.manifest.version,
          privacy: candidatePrivacy,
          source: candidate.source,
        },
        instanceId: instance.id,
        operationId,
        projections: candidateProjections,
        snapshotPath: promoted.snapshotPath,
        homepageApplied: homepageWasApplied,
      });
      homepageRollback = null;
      // Reconciled after the commit on purpose: reapplying a consumer re-applies
      // its stored projections, and only after completeAppUpdate do those
      // describe the runtime that is actually serving. Run before the commit,
      // this call painted the outgoing compose back over the just-activated
      // candidate. A relationship that fails here is reported on its
      // integration row and in this result; it never un-happens the committed
      // update, so failures must not reach the catch below.
      let integrations = [];
      try {
        integrations = await this.apps.reconcilePackageIntegrations(packageId, requestContext);
      } catch (reconcileError) {
        integrations = [{ errorCode: reconcileError.code || 'APP_INTEGRATION_REAPPLY_FAILED', status: 'failed' }];
      }
      return { activated, built, comparison, homepage, integrations, operation, promoted, staged };
    } catch (error) {
      if (activatedRuntimes && !snapshotPromoted) {
        try {
          await this.agent.rollbackPackageUpdate(activatedRuntimes);
        } catch (rollbackError) {
          error = new AppPackageServiceError(
            'APP_UPDATE_ROLLBACK_FAILED',
            'The app update failed and the previous runtime could not be restored. Recovery is required.',
            502,
          );
          error.cause = rollbackError;
        }
      }
      // Once the snapshot is promoted the candidate is the installed package;
      // restoring the pre-update Homepage entry would advertise a runtime that
      // no longer exists. The pending commit keeps the candidate's entry.
      if (homepageRollback && !snapshotPromoted) {
        try {
          const current = await homepageRollback.homepageService.read({ file: 'services.template.yaml' });
          await homepageRollback.homepageService.add({
            entry: homepageRollback.entry,
            expectedRevision: current.revision,
            requestId: instance.id,
          }, false);
        } catch (rollbackError) {
          error = new AppPackageServiceError(
            'APP_UPDATE_HOMEPAGE_ROLLBACK_FAILED',
            'The app update failed and its previous Homepage entry could not be restored. Recovery is required.',
            502,
          );
          error.cause = rollbackError;
        }
      }
      let recoveryState = 'none';
      if (operationId) {
        recoveryState = snapshotPromoted
          ? 'commit-required'
          : String(error.code || '').endsWith('ROLLBACK_FAILED')
            ? 'rollback-required'
            : 'none';
        this.store.failAppUpdate({
          at: this.now().toISOString(),
          errorCode: error.code || 'APP_UPDATE_STAGE_FAILED',
          instanceId: instance.id,
          operationId,
          recoveryState,
          stage: lastDurableStage ? `${lastDurableStage}-failed` : 'candidate-stage-failed',
        });
      }
      // Collected secret files are deleted only when nothing can still need
      // them: a promoted-but-uncommitted candidate runs against them right now,
      // and a pending rollback rebuilds the candidate runtime it must tear down
      // from them. Recovery discards them itself once it resolves the state.
      if (recoveryState === 'none') this.apps.discardCollectedSecrets(instance.id, addedConfig);
      if (error instanceof AppPackageServiceError) throw error;
      throw new AppPackageServiceError(error.code || 'APP_UPDATE_STAGE_FAILED', error.message || 'The app update could not be staged.', error.statusCode || 502);
    } finally { candidate?.cleanup?.(); }
  }
}

module.exports = { AppUpdateService };
