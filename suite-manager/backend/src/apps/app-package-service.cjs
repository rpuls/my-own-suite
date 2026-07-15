const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  inspectAppPackages,
  publicPackageSummary,
  readAppPackageManifest,
} = require('./package-manifest.cjs');
const {
  SUPPORTED_ARCHITECTURES,
  digestAppPackage,
  parseNamespacedPackageId,
  validateArchitectureCompatibility,
  validatePrivacyBinding,
} = require('./package-contracts.cjs');
const { sourceId, sourceInstallable } = require('./external-source-registry.cjs');
const { AppOperationLimiter } = require('./app-operation-limits.cjs');
const { compareAppPackages } = require('./app-update-comparison.cjs');

const APP_LOOPBACK_PORT_BASE = 18000;
const APP_LOOPBACK_PORT_SPAN = 1000;

class AppPackageServiceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// What the app agent says this host is, or null when it is too old to say, could
// not be asked, or does not recognise its own host. Validated rather than
// trusted: this value decides whether packages are refused, so an agent that
// answers with something MOS has no vocabulary for is treated as having said
// nothing, which enforces no declaration at all.
function hostArchitectureOf(agentStatus) {
  const reported = agentStatus?.hostArchitecture;
  return SUPPORTED_ARCHITECTURES.includes(reported) ? reported : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestFor(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function fingerprintFor(value) {
  return digestFor(String(value));
}

function loopbackPortFor(manifestOrPackageId, serviceId = null) {
  const packageId = typeof manifestOrPackageId === 'string' ? manifestOrPackageId : manifestOrPackageId.id;
  const digest = crypto.createHash('sha256').update(`${packageId}:${serviceId || packageId}`).digest();
  return APP_LOOPBACK_PORT_BASE + digest.readUInt16BE(0) % APP_LOOPBACK_PORT_SPAN;
}

function serviceForHealth(manifest) {
  const parsed = new URL(manifest.health.url);
  const serviceIds = new Set(Object.keys(manifest.resources.services || {}));
  return serviceIds.has(parsed.hostname) ? parsed.hostname : manifest.routes[0]?.service;
}

function healthTargetFor(manifest, port) {
  const parsed = new URL(manifest.health.url);
  return `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function setupFields(manifest) {
  return Array.isArray(manifest.setup?.fields) ? manifest.setup.fields : [];
}

function generateValue(field) {
  if (!isRecord(field.generated)) return undefined;
  const bytes = field.generated.bytes;
  const value = crypto.randomBytes(bytes);
  if (field.generated.encoding === 'hex') return value.toString('hex');
  return value.toString('base64url');
}

function configValueMap(configRows, { includeSecrets = false } = {}) {
  const map = new Map();
  for (const row of configRows || []) {
    if (row.secret) {
      if (includeSecrets && typeof row.rawValue === 'string') {
        map.set(row.key, row.rawValue);
      }
      continue;
    }
    if (row.value !== undefined) map.set(row.key, row.value);
  }
  return map;
}

function resolveConfigTemplate(value, configRows, { app = {}, includeSecrets = false } = {}) {
  if (typeof value !== 'string') return value;
  const values = configValueMap(configRows, { includeSecrets });
  return value
    .replace(/\$\{app\.publicUrl\}/gu, () => (typeof app.publicUrl === 'string' ? app.publicUrl : '${app.publicUrl}'))
    .replace(/\$\{app\.host\}/gu, () => (typeof app.host === 'string' ? app.host : '${app.host}'))
    .replace(/\$\{app\.scheme\}/gu, () => (typeof app.scheme === 'string' ? app.scheme : '${app.scheme}'))
    .replace(/\$\{config\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => (values.has(key) ? String(values.get(key)) : match))
    .replace(/\$\{secret\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => (values.has(key) ? String(values.get(key)) : match));
}

function renderEnvironment(environment, configRows, options = {}) {
  return Object.fromEntries(
    Object.entries(environment || {}).map(([key, value]) => [key, resolveConfigTemplate(value, configRows, options)]),
  );
}

function resolveTemplatesDeep(value, configRows, options = {}) {
  if (typeof value === 'string') return resolveConfigTemplate(value, configRows, options);
  if (Array.isArray(value)) return value.map((item) => resolveTemplatesDeep(item, configRows, options));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveTemplatesDeep(child, configRows, options)]));
  }
  return value;
}

// `packageId` is the identity MOS installed the package under, which is the
// manifest id for official packages and a source-namespaced id for external
// ones. Every derived runtime name (build context, loopback ports, and through
// the agent the container/volume/network names) keys off it, so two packages
// that ship the same manifest id from different sources stay isolated.
function renderDryRunProjections(manifest, configRows = [], { packageId = manifest.id } = {}) {
  const services = Object.entries(manifest.resources.services).map(([id, service]) => ({
    build: { context: `apps/${packageId}`, dockerfile: service.dockerfile },
    environment: renderEnvironment(service.env, configRows),
    id,
    internalPort: service.internalPort,
    loopbackPort: loopbackPortFor(packageId, id),
    volumes: service.volumes || [],
  }));
  const servicePorts = new Map(services.map((service) => [service.id, service.loopbackPort]));
  const healthService = serviceForHealth(manifest);
  const volumes = [...new Set(services.flatMap((service) => service.volumes.map((volume) => volume.split(':')[0])))].sort();
  const projections = [
    {
      content: {
        services,
        volumes,
      },
      kind: 'compose',
    },
    {
      content: {
        routes: manifest.routes.map((route) => ({
          host: route.host,
          ...(isRecord(route.internalIcalBridge) ? { internalIcalBridge: resolveTemplatesDeep(route.internalIcalBridge, configRows) } : {}),
          reverseProxy: `127.0.0.1:${servicePorts.get(route.service)}`,
          service: route.service,
        })),
      },
      kind: 'caddy',
    },
    {
      content: {
        target: healthTargetFor(manifest, servicePorts.get(healthService)),
        type: manifest.health.type,
      },
      kind: 'health',
    },
  ];
  if (isRecord(manifest.homepage)) {
    projections.splice(2, 0, {
      content: manifest.homepage,
      kind: 'homepage',
    });
  }
  return projections.map((projection) => ({
    ...projection,
    contentJson: stableJson(projection.content),
    digest: digestFor(projection.content),
  }));
}

function publicConfig(configRows = []) {
  return configRows.map((row) => ({
    fingerprint: row.fingerprint || null,
    generated: row.source === 'generated',
    key: row.key,
    redactedLabel: row.redactedLabel || null,
    secret: row.secret === true,
    source: row.source,
    updatedAt: row.updatedAt,
    ...(row.secret ? {} : { value: row.value }),
  }));
}

function publicInstance(instance, projections = [], configRows = []) {
  if (!instance) return null;
  return {
    config: publicConfig(configRows),
    enabled: instance.enabled,
    id: instance.id,
    installedAt: instance.installedAt,
    manifestDigest: instance.manifestDigest,
    packageId: instance.packageId,
    packageVersion: instance.packageVersion,
    guideState: instance.guideState || null,
    projections: projections.map((projection) => ({
      appliedDigest: projection.appliedDigest,
      content: projection.content,
      digest: projection.digest,
      kind: projection.kind,
      status: projection.status,
      updatedAt: projection.updatedAt,
    })),
    status: instance.status,
    updateRecovery: instance.updateRecoveryState && instance.updateRecoveryState !== 'none' ? {
      errorCode: instance.updateRecoveryError,
      state: instance.updateRecoveryState,
    } : null,
    updatedAt: instance.updatedAt,
  };
}

function reviewProvenance(review) {
  const provenance = review?.provenance || {};
  return {
    humanReviewed: provenance.humanReviewed === true,
    method: provenance.method || null,
    model: provenance.model || null,
    sourceRevision: review?.scope?.source?.revision || null,
  };
}

function privacyReviewPresentation(packageDir, { id, version }) {
  const reviewPath = path.join(packageDir, 'privacy-review.json');
  if (!fs.existsSync(reviewPath)) return null;
  try {
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    if (review?.schemaVersion !== 1 || review.appId !== id || review.scope?.packageVersion !== version) return null;
    return { dimensions: review.dimensions || null, posture: review.posture, provenance: reviewProvenance(review), reviewedAt: review.reviewedAt, status: 'reviewed' };
  } catch {
    return null;
  }
}

function resolveInsideSecretDir(secretDir, target) {
  const root = path.resolve(secretDir);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppPackageServiceError(
      'APP_SECRET_UNAVAILABLE',
      'A required app secret is unavailable. Restore the app secret before applying this runtime.',
      409,
    );
  }
  return resolved;
}

function secretFilePath(secretDir, instanceId, key) {
  return resolveInsideSecretDir(secretDir, path.join(secretDir, instanceId, `${key}.secret`));
}

function writeSecretFile(secretDir, instanceId, key, value) {
  const dir = path.join(secretDir, instanceId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = secretFilePath(secretDir, instanceId, key);
  fs.writeFileSync(target, value, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(target, 0o600);
  } catch {}
  return target;
}

function readSecretValue(secretDir, secretRef) {
  try {
    const resolved = resolveInsideSecretDir(secretDir, secretRef);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error('APP_SECRET_NOT_FILE');
    }
    return fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    if (error instanceof AppPackageServiceError) throw error;
    throw new AppPackageServiceError(
      'APP_SECRET_UNAVAILABLE',
      'A required app secret is unavailable. Restore the app secret before applying this runtime.',
      409,
    );
  }
}

function createConfigRows({ input = {}, instanceId, manifest, secretDir }) {
  const supplied = isRecord(input.config) ? input.config : isRecord(input) ? input : {};
  const rows = [];
  for (const field of setupFields(manifest)) {
    const hasUserValue = Object.hasOwn(supplied, field.id) && supplied[field.id] !== undefined && supplied[field.id] !== null && supplied[field.id] !== '';
    const generated = generateValue(field);
    const value = hasUserValue ? supplied[field.id] : generated ?? field.default;
    if ((value === undefined || value === null || value === '') && field.required === true) {
      throw new AppPackageServiceError('APP_SETUP_REQUIRED', `${field.label || field.id} is required.`, 400);
    }
    if (value === undefined || value === null || value === '') continue;
    if (field.secret === true) {
      const rawValue = String(value);
      rows.push({
        fingerprint: fingerprintFor(rawValue),
        key: field.id,
        rawValue,
        redactedLabel: field.redactedLabel || field.label || 'Secret value',
        secret: true,
        secretRef: writeSecretFile(secretDir, instanceId, field.id, rawValue),
        source: generated !== undefined && !hasUserValue ? 'generated' : 'user',
      });
    } else {
      rows.push({
        key: field.id,
        secret: false,
        source: generated !== undefined && !hasUserValue ? 'generated' : hasUserValue ? 'user' : 'default',
        value,
        valueJson: stableJson(value),
      });
    }
  }
  return rows;
}

function materializeRuntimeCompose(compose, configRows) {
  return {
    ...compose,
    services: compose.services.map((service) => ({
      ...service,
      environment: renderEnvironment(service.environment, configRows, { includeSecrets: true }),
    })),
  };
}

function materializeRuntimeCaddy(caddy, configRows) {
  return resolveTemplatesDeep(caddy, configRows, { includeSecrets: true });
}

function appRouteForHomepage(projections) {
  const caddy = projections.find((projection) => projection.kind === 'caddy')?.content;
  const route = Array.isArray(caddy?.routes) ? caddy.routes[0] : null;
  if (!route || typeof route.host !== 'string' || !route.host) {
    throw new AppPackageServiceError('APP_HOMEPAGE_PROJECTION_INVALID', 'This app does not have enough route data for a Homepage entry.', 409);
  }
  return route;
}

function linkEntryForHomepage(instance, projections, requestContext = {}) {
  const homepage = projections.find((projection) => projection.kind === 'homepage')?.content;
  const route = appRouteForHomepage(projections);
  const baseHost = String(requestContext.baseHost || '').trim().toLowerCase();
  const scheme = requestContext.scheme === 'https' ? 'https' : 'http';

  if (!homepage || !baseHost) {
    throw new AppPackageServiceError('APP_HOMEPAGE_PROJECTION_INVALID', 'This app does not have enough projection data for a Homepage entry.', 409);
  }

  return {
    description: homepage.description || instance.displayNameSnapshot,
    group: homepage.group || instance.categorySnapshot,
    icon: homepage.icon || instance.packageId,
    name: homepage.name || instance.displayNameSnapshot,
    url: `${scheme}://${route.host}.${baseHost}/`,
  };
}

function homepageEntryForHomepage(instance, projections, configRows, requestContext = {}) {
  const base = linkEntryForHomepage(instance, projections, requestContext);
  const homepage = projections.find((projection) => projection.kind === 'homepage')?.content;
  if (!isRecord(homepage?.widget)) return base;
  return {
    ...base,
    widget: resolveTemplatesDeep(homepage.widget, configRows, {
      app: { publicUrl: base.url },
      includeSecrets: true,
    }),
  };
}

function runtimeApplied(projections) {
  return ['compose', 'caddy', 'health'].every((kind) => {
    const projection = projections.find((item) => item.kind === kind);
    return projection?.status === 'applied' && projection.appliedDigest === projection.digest;
  });
}

function runtimeRouteApplied(projections) {
  return ['compose', 'caddy'].every((kind) => {
    const projection = projections.find((item) => item.kind === kind);
    return projection?.status === 'applied' && projection.appliedDigest === projection.digest;
  });
}

function homepageProjectionApplied(projections) {
  const projection = projections.find((item) => item.kind === 'homepage');
  return projection?.status === 'applied' && projection.appliedDigest === projection.digest;
}

function capabilityMatches(exported, matcher) {
  if (!isRecord(exported) || !isRecord(matcher)) return false;
  if (exported.type !== matcher.type) return false;
  if (matcher.protocol !== undefined && matcher.protocol !== exported.protocol) return false;
  if (Number.isInteger(matcher.interfaceVersion) && Number.isInteger(exported.interfaceVersion) && matcher.interfaceVersion !== exported.interfaceVersion) return false;
  return true;
}

function integrationSlots(manifest) {
  return Object.entries(isRecord(manifest.integrations) ? manifest.integrations : {});
}

function exportEntries(manifest) {
  return Object.entries(isRecord(manifest.exports) ? manifest.exports : {});
}

function integrationConfigKey(slotId, envKey) {
  const pascal = String(envKey).toLowerCase().replace(/_([a-z0-9])/gu, (_match, letter) => letter.toUpperCase());
  return `integration${slotId.slice(0, 1).toUpperCase()}${slotId.slice(1)}${pascal.slice(0, 1).toUpperCase()}${pascal.slice(1)}`;
}

function templateSecretRef(value) {
  const match = typeof value === 'string' ? value.match(/^\$\{secret\.([a-z][A-Za-z0-9]*)\}$/u) : null;
  return match ? match[1] : null;
}

function providerSecretRows(providerConfig) {
  return new Map((providerConfig || []).filter((row) => row.secretRef).map((row) => [row.key, row]));
}

function resolveCapabilityValue(value, { consumerExport, providerCapability, providerConfig, providerPublicUrl }) {
  if (typeof value !== 'string') return value;
  const secretRows = providerSecretRows(providerConfig);
  return value
    .replace(/\$\{app\.publicUrl\}/gu, providerPublicUrl.publicUrl)
    .replace(/\$\{app\.host\}/gu, providerPublicUrl.appHost)
    .replace(/\$\{app\.scheme\}/gu, providerPublicUrl.scheme)
    .replace(/\$\{export\.([a-z][A-Za-z0-9]*)\.([a-zA-Z][A-Za-z0-9]*)\}/gu, (match, exportId, key) => {
      if (!consumerExport || exportId !== consumerExport.id) return match;
      return typeof consumerExport.capability[key] === 'string' ? consumerExport.capability[key] : match;
    })
    .replace(/\$\{import\.([a-z][A-Za-z0-9]*)\.([a-zA-Z][A-Za-z0-9]*)\}/gu, (match, _slot, key) => {
      const raw = providerCapability[key];
      if (typeof raw !== 'string') return match;
      return resolveCapabilityValue(raw, { consumerExport, providerCapability, providerConfig, providerPublicUrl });
    })
    .replace(/\$\{import\.([a-z][A-Za-z0-9]*)\.secrets\.([a-z][A-Za-z0-9]*)\}/gu, (match, _slot, secretId) => {
      const secretTemplate = providerCapability.secrets?.[secretId]?.ref;
      const key = templateSecretRef(secretTemplate);
      const row = key ? secretRows.get(key) : null;
      return row ? `__secret_ref__:${row.secretRef}` : match;
    });
}

function cloneProjectionWithIntegrationEnv(projections, targetService, values) {
  return projections.map((projection) => {
    if (projection.kind !== 'compose') {
      return {
        content: projection.content,
        contentJson: stableJson(projection.content),
        digest: digestFor(projection.content),
        kind: projection.kind,
      };
    }
    const content = {
      ...projection.content,
      services: projection.content.services.map((service) => (
        service.id === targetService
          ? { ...service, environment: { ...(service.environment || {}), ...values } }
          : service
      )),
    };
    return {
      content,
      contentJson: stableJson(content),
      digest: digestFor(content),
      kind: projection.kind,
    };
  });
}

function runtimeConnectionState(app) {
  if (!app.instance) return 'available';
  if (app.instance.status === 'uninstalled') return 'available';
  if (app.instance.status === 'disabled' || app.instance.enabled === false) return 'disabled';
  if (runtimeApplied(app.instance.projections || [])) return 'running';
  if (app.instance.status === 'installed') return 'installed';
  return app.instance.status || 'available';
}

function requestContextForPackage(packageId, requestContext = {}) {
  if (typeof requestContext.publicUrlFor === 'function') return requestContext.publicUrlFor(packageId);
  return requestContext;
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
  }

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
    const source = this.store.getAppSource(sourceId(instance.sourceRepository, instance.sourcePath));
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

      const packageDigest = digestAppPackage(packageDir);
      const source = {
        kind: 'official-git',
        path: `apps/${manifest.id}`,
        repository: this.officialRepository,
        revision: packageDigest,
        trust: 'mos-reviewed',
      };
      let privacy = { posture: 'review-required', reviewedAt: null, status: 'review-required' };
      const privacyReviewPath = path.join(packageDir, 'privacy-review.json');
      if (fs.existsSync(privacyReviewPath)) {
        const review = JSON.parse(fs.readFileSync(privacyReviewPath, 'utf8'));
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

  recoverInterruptedUpdates() {
    return this.store.recoverInterruptedAppUpdates({ at: this.now().toISOString() });
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
    const result = await this.agent.apply({
      appHost: requestContext.appHost,
      caddy: materializeRuntimeCaddy(caddyProjection.content, configRows),
      compose: materializeRuntimeCompose(composeProjection.content, configRows),
      health: healthProjection.content,
      instanceId: instance.id,
      packageDigest: instance.packageDigest,
      packageId: instance.packageId,
      packageVersion: instance.packageVersion,
      publicUrl: requestContext.publicUrl,
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
    const envPatch = {};
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
        envPatch[envKey] = `\${secret.${configKey}}`;
      } else {
        rows.push({
          instanceId: consumer.id,
          key: configKey,
          source: 'system',
          value: resolved,
          valueJson: stableJson(resolved),
        });
        envPatch[envKey] = `\${config.${configKey}}`;
      }
    }

    const currentProjections = this.store.getAppProjections(consumer.id);
    const nextProjections = cloneProjectionWithIntegrationEnv(currentProjections, target.service, envPatch);
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

  async restartPackageRuntime(packageId, requestContext = {}) {
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
        || { dimensions: null, posture: 'review-required', reviewedAt: null, status: 'review-required' };
    }
    const stored = {
      dimensions: null,
      posture: instance.privacyPosture || 'review-required',
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
      const summary = instance?.snapshotState === 'installed'
        ? publicPackageSummary(this.installedPackageFor(instance).manifest)
        : instance
          ? publicPackageSummary({
            category: instance.categorySnapshot,
            id: instance.packageId,
            name: instance.displayNameSnapshot,
            summary: 'Installed package metadata requires recovery before this app can be managed.',
            version: instance.packageVersion,
          }, ['The installed package snapshot is unavailable.'])
          : candidatesByPackage.get(packageId);
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
    const packageDigest = digestAppPackage(packageDir);
    const source = {
      kind: 'official-git',
      path: `apps/${manifest.id}`,
      repository: this.officialRepository,
      revision: packageDigest,
      trust: 'mos-reviewed',
    };
    let privacy = { posture: 'review-required', reviewedAt: null, status: 'review-required' };
    const privacyReviewPath = path.join(packageDir, 'privacy-review.json');
    if (fs.existsSync(privacyReviewPath)) {
      const review = JSON.parse(fs.readFileSync(privacyReviewPath, 'utf8'));
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
    const { manifest: installedManifest } = readAppPackageManifest(instance.snapshotPath);
    if (installedManifest.id !== manifest.id || digestAppPackage(instance.snapshotPath) !== packageDigest) {
      throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_INVALID', 'The installed app package snapshot does not match the validated source package.', 502);
    }
    const config = createConfigRows({ input, instanceId: instance.id, manifest: installedManifest, secretDir: this.secretDir });
    const projections = renderDryRunProjections(installedManifest, config);
    try {
      this.store.installAppInstance({
        at,
        config,
        instance,
        operationId: crypto.randomUUID(),
        projections,
        request: {
          config: config.map((item) => ({ generated: item.source === 'generated', key: item.key, secret: item.secret === true, source: item.source })),
          dryRunOnly: true,
          packageId: manifest.id,
          packageVersion: manifest.version,
        },
      });
    } catch (error) {
      fs.rmSync(path.join(this.secretDir, instance.id), { recursive: true, force: true });
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
    const requested = new Set((manifest.routes || []).map((route) => route.host));
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
      privacy: { posture: 'review-required', reviewedAt: null, status: 'review-required' },
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
    const { manifest: installedManifest } = readAppPackageManifest(instance.snapshotPath);
    if (installedManifest.id !== manifest.id || digestAppPackage(instance.snapshotPath) !== candidate.packageDigest) {
      throw new AppPackageServiceError('APP_PACKAGE_SNAPSHOT_INVALID', 'The installed app package snapshot does not match the validated source package.', 502);
    }
    const config = createConfigRows({ input, instanceId: instance.id, manifest: installedManifest, secretDir: this.secretDir });
    const projections = renderDryRunProjections(installedManifest, config, { packageId });
    try {
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
          packageVersion: manifest.version,
          source: { kind: instance.source.kind, repository: instance.source.repository, revision: instance.source.revision, trust: instance.source.trust },
        },
      });
    } catch (error) {
      fs.rmSync(path.join(this.secretDir, instance.id), { recursive: true, force: true });
      throw error;
    }

    return publicInstance(
      this.withGuideState(this.store.getAppInstanceByPackageId(packageId)),
      this.store.getAppProjections(instance.id),
      this.store.getAppConfig(instance.id),
    );
  }

  async preparePackageUpdate(packageId) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status === 'uninstalled') throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before preparing an update.', 409);
    const installedPackage = this.installedPackageFor(instance);
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
    if (typeof input.confirmationToken !== 'string' || !/^[a-f0-9]{64}$/u.test(input.confirmationToken)) {
      throw new AppPackageServiceError('APP_UPDATE_CONFIRMATION_INVALID', 'Prepare and confirm this exact app update before staging it.', 400);
    }
    if (!this.agent?.stagePackageUpdate || !this.agent?.buildPackageUpdate) {
      throw new AppPackageServiceError('APP_UPDATE_STAGING_UNAVAILABLE', 'App update staging is unavailable.', 503);
    }
    const installedPackage = this.installedPackageFor(instance);
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
      if (candidate.source?.trust !== 'mos-reviewed') this.assertRouteHostsAvailable(candidate.manifest, instance.packageId);
      if (!agentStatus.capabilities?.includes('apps.package.update.stage') || !agentStatus.capabilities?.includes('apps.package.update.build') || agentStatus.contractVersion < 3) {
        throw new AppPackageServiceError('APP_UPDATE_STAGING_UNAVAILABLE', 'The installed app agent cannot stage and build package updates.', 503);
      }
      operationId = crypto.randomUUID();
      const at = this.now().toISOString();
      try {
        this.store.beginAppUpdate({
          at,
          candidateDigest: candidate.packageDigest,
          expectedInstalledDigest: instance.packageDigest,
          instanceId: instance.id,
          operationId,
          request: { packageId, packageVersion: candidate.manifest.version },
        });
      } catch (error) {
        if (error.message === 'APP_UPDATE_ALREADY_RUNNING') throw new AppPackageServiceError('APP_UPDATE_ALREADY_RUNNING', 'An update operation is already active for this app.', 409);
        throw error;
      }
      const staged = await this.agent.stagePackageUpdate({
        candidateDigest: candidate.packageDigest,
        candidatePath: candidate.packageDir,
        expectedInstalledDigest: instance.packageDigest,
        instanceId: instance.id,
        packageId,
      });
      this.store.advanceAppUpdate({ at: this.now().toISOString(), instanceId: instance.id, operationId, stage: 'candidate-staged' });
      lastDurableStage = 'candidate-staged';
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
        const review = JSON.parse(fs.readFileSync(candidateReviewPath, 'utf8'));
        const errors = validatePrivacyBinding(review, { manifest: candidate.manifest, packageDigest: candidate.packageDigest, source: candidate.source });
        if (errors.length) throw new AppPackageServiceError('APP_PRIVACY_REVIEW_INVALID', `The candidate privacy review is invalid: ${errors.join(' ')}`, 409);
        candidatePrivacy = { posture: review.posture, reviewedAt: review.reviewedAt, status: 'reviewed' };
      }
      const candidateProjections = renderDryRunProjections(candidate.manifest, candidateConfig, { packageId: instance.packageId });
      const composeProjection = candidateProjections.find((projection) => projection.kind === 'compose');
      const caddyProjection = candidateProjections.find((projection) => projection.kind === 'caddy');
      const healthProjection = candidateProjections.find((projection) => projection.kind === 'health');
      if (!composeProjection || !caddyProjection || !healthProjection) {
        throw new AppPackageServiceError('APP_RUNTIME_PROJECTION_MISSING', 'The update candidate is missing runtime projections.', 409);
      }
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
      let operation = this.store.advanceAppUpdate({ at: this.now().toISOString(), instanceId: instance.id, operationId, stage: 'candidate-built' });
      lastDurableStage = 'candidate-built';
      const canApply = agentStatus.contractVersion >= 6
        && agentStatus.capabilities?.includes('apps.package.update.activate')
        && agentStatus.capabilities?.includes('apps.package.update.rollback')
        && agentStatus.capabilities?.includes('apps.package.update.promote')
        && this.agent.activatePackageUpdate && this.agent.rollbackPackageUpdate && this.agent.promotePackageUpdate;
      if (!canApply) {
        this.discardCollectedSecrets(instance.id, addedConfig);
        return { built, comparison, operation, staged };
      }

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
      operation = this.store.advanceAppUpdate({ at: this.now().toISOString(), instanceId: instance.id, operationId, stage: 'candidate-healthy' });
      lastDurableStage = 'candidate-healthy';

      const integrations = await this.reconcilePackageIntegrations(packageId, requestContext);
      if (integrations.some((item) => item.status === 'failed')) {
        throw new AppPackageServiceError('APP_UPDATE_INTEGRATION_FAILED', 'The candidate is healthy, but a cross-app integration could not be restored. Recovery is required.', 502);
      }
      operation = this.store.advanceAppUpdate({ at: this.now().toISOString(), instanceId: instance.id, operationId, stage: 'integrations-reconciled' });
      lastDurableStage = 'integrations-reconciled';
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
        operation = this.store.advanceAppUpdate({ at: this.now().toISOString(), instanceId: instance.id, operationId, stage: 'homepage-reconciled' });
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
      operation = this.store.advanceAppUpdate({ at: this.now().toISOString(), instanceId: instance.id, operationId, stage: 'snapshot-promoted' });
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
      return { activated, built, comparison, homepage, integrations, operation, promoted, staged };
    } catch (error) {
      this.discardCollectedSecrets(instance.id, addedConfig);
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
      if (homepageRollback) {
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
      if (operationId) {
        const recoveryState = snapshotPromoted
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
      if (error instanceof AppPackageServiceError) throw error;
      throw new AppPackageServiceError(error.code || 'APP_UPDATE_STAGE_FAILED', error.message || 'The app update could not be staged.', error.statusCode || 502);
    } finally { candidate?.cleanup?.(); }
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
    const result = await homepageService.add({
      entry: homepageEntryForHomepage(instance, projections, configRows, requestContext),
      expectedRevision: current.revision,
      requestId: instance.id,
    }, false);

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

  async reconcilePublicUrls(homepageService, requestContext = {}) {
    const runtime = [];
    const homepageEntries = [];
    const homepageEntryFailures = [];
    for (const instance of this.store.getAppInstances()) {
      if (instance.status !== 'installed') continue;
      const packageContext = requestContextForPackage(instance.packageId, requestContext);
      const projections = this.store.getAppProjections(instance.id);
      if (homepageProjectionApplied(projections)) {
        try {
          const configRows = this.store.getAppConfig(instance.id).map((row) => (
            row.secretRef ? { ...row, rawValue: readSecretValue(this.secretDir, row.secretRef) } : row
          ));
          const entry = homepageEntryForHomepage(instance, projections, configRows, packageContext);
          homepageEntries.push({
            href: entry.url,
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

  async disablePackage(packageId, _homepageService) {
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

  async enablePackage(packageId, requestContext = {}) {
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

  async uninstallPackage(packageId, homepageService) {
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
  linkEntryForHomepage,
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
