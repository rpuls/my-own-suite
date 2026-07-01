const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  inspectAppPackages,
  publicPackageSummary,
  readAppPackageManifest,
} = require('./package-manifest.cjs');

const APP_LOOPBACK_PORT_BASE = 18000;
const APP_LOOPBACK_PORT_SPAN = 1000;

class AppPackageServiceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
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

function loopbackPortFor(manifestOrPackageId) {
  const packageId = typeof manifestOrPackageId === 'string' ? manifestOrPackageId : manifestOrPackageId.id;
  const digest = crypto.createHash('sha256').update(packageId).digest();
  return APP_LOOPBACK_PORT_BASE + digest.readUInt16BE(0) % APP_LOOPBACK_PORT_SPAN;
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

function resolveConfigTemplate(value, configRows, { includeSecrets = false } = {}) {
  if (typeof value !== 'string') return value;
  const values = configValueMap(configRows, { includeSecrets });
  return value
    .replace(/\$\{config\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => (values.has(key) ? String(values.get(key)) : match))
    .replace(/\$\{secret\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => (values.has(key) ? String(values.get(key)) : match));
}

function renderEnvironment(environment, configRows, options = {}) {
  return Object.fromEntries(
    Object.entries(environment || {}).map(([key, value]) => [key, resolveConfigTemplate(value, configRows, options)]),
  );
}

function renderDryRunProjections(manifest, configRows = []) {
  const services = Object.entries(manifest.resources.services).map(([id, service]) => ({
    build: { context: `version-2/apps/${manifest.id}`, dockerfile: service.dockerfile },
    environment: renderEnvironment(service.env, configRows),
    id,
    internalPort: service.internalPort,
    loopbackPort: loopbackPortFor(manifest, id),
    volumes: service.volumes || [],
  }));
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
          reverseProxy: `127.0.0.1:${loopbackPortFor(manifest, route.service)}`,
        })),
      },
      kind: 'caddy',
    },
    {
      content: manifest.homepage,
      kind: 'homepage',
    },
    {
      content: {
        target: healthTargetFor(manifest, loopbackPortFor(manifest, manifest.routes[0]?.service)),
        type: manifest.health.type,
      },
      kind: 'health',
    },
  ];
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
    projections: projections.map((projection) => ({
      appliedDigest: projection.appliedDigest,
      content: projection.content,
      digest: projection.digest,
      kind: projection.kind,
      status: projection.status,
      updatedAt: projection.updatedAt,
    })),
    status: instance.status,
    updatedAt: instance.updatedAt,
  };
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

function runtimeApplied(projections) {
  return ['compose', 'caddy', 'health'].every((kind) => {
    const projection = projections.find((item) => item.kind === kind);
    return projection?.status === 'applied' && projection.appliedDigest === projection.digest;
  });
}

function homepageProjectionApplied(projections) {
  const projection = projections.find((item) => item.kind === 'homepage');
  return projection?.status === 'applied' && projection.appliedDigest === projection.digest;
}

class AppPackageService {
  constructor({ agent = null, appsDir, now = () => new Date(), secretDir = null, store }) {
    this.agent = agent;
    this.appsDir = appsDir;
    this.now = now;
    this.secretDir = secretDir || path.join(store.stateDir, 'app-secrets');
    this.store = store;
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

    const packageDir = path.join(this.appsDir, packageId);
    const { manifest } = readAppPackageManifest(packageDir);
    const result = await this.agent.apply({
      appHost: requestContext.appHost,
      caddy: caddyProjection.content,
      compose: materializeRuntimeCompose(composeProjection.content, configRows),
      health: healthProjection.content,
      instanceId: instance.id,
      packageId: instance.packageId,
      packageVersion: instance.packageVersion,
      publicUrl: requestContext.publicUrl,
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

  listPackages() {
    const instancesByPackage = new Map(this.store.getAppInstances().map((instance) => [instance.packageId, instance]));
    return inspectAppPackages(this.appsDir).map((summary) => {
      const instance = instancesByPackage.get(summary.id);
      const projections = instance ? this.store.getAppProjections(instance.id) : [];
      const config = instance ? this.store.getAppConfig(instance.id) : [];
      return {
        ...summary,
        installStatus: instance?.status || 'not-installed',
        instance: publicInstance(instance, projections, config),
      };
    });
  }

  iconPath(packageId) {
    const packageDir = path.join(this.appsDir, packageId);
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

  installPackage(packageId, input = {}) {
    const current = this.store.getAppInstanceByPackageId(packageId);
    if (current) {
      if (current.status === 'uninstalled') {
        throw new AppPackageServiceError('APP_PREVIOUSLY_UNINSTALLED', 'This app was uninstalled with its data preserved. Reinstall recovery is a future lifecycle action.', 409);
      }
      return publicInstance(current, this.store.getAppProjections(current.id), this.store.getAppConfig(current.id));
    }

    const packageDir = path.join(this.appsDir, packageId);
    if (!fs.existsSync(path.join(packageDir, 'manifest.json'))) {
      throw new AppPackageServiceError('APP_PACKAGE_NOT_FOUND', 'That app package is not available.', 404);
    }
    const { manifest } = readAppPackageManifest(packageDir);
    const at = this.now().toISOString();
    const manifestDigest = digestFor(manifest);
    const instance = {
      categorySnapshot: manifest.category,
      displayNameSnapshot: manifest.name,
      id: crypto.randomUUID(),
      manifestDigest,
      packageId: manifest.id,
      packageVersion: manifest.version,
    };
    const config = createConfigRows({ input, instanceId: instance.id, manifest, secretDir: this.secretDir });
    const projections = renderDryRunProjections(manifest, config);
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
      this.store.getAppInstanceByPackageId(packageId),
      this.store.getAppProjections(instance.id),
      this.store.getAppConfig(instance.id),
    );
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
    const result = await homepageService.add({
      entry: linkEntryForHomepage(instance, projections, requestContext),
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

  async disablePackage(packageId, homepageService) {
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
      throw new AppPackageServiceError('APP_INVALID_TRANSITION', 'This app cannot be disabled from its current state.', 409);
    }

    const homepage = await this.removePackageFromHomepage(instance, homepageService);
    const agent = await this.agent.remove({ packageId: instance.packageId });
    const at = this.now().toISOString();
    this.store.markAppDisabled({
      at,
      instanceId: instance.id,
      operationId: crypto.randomUUID(),
      request: { packageId: instance.packageId, preserveData: true, target: 'runtime-and-route' },
    });
    return {
      agent,
      homepage,
      instance: publicInstance(
        this.store.getAppInstanceByPackageId(packageId),
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
    };
  }

  async enablePackage(packageId, requestContext = {}) {
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance || instance.status === 'uninstalled') {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before enabling it.', 409);
    }
    if (instance.status === 'installed') {
      return this.applyPackageRuntime(packageId, requestContext);
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
      instance: publicInstance(
        this.store.getAppInstanceByPackageId(packageId),
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
    };
  }

  async uninstallPackagePreserveData(packageId, homepageService) {
    if (!this.agent) {
      throw new AppPackageServiceError('APP_AGENT_UNAVAILABLE', 'App runtime system agent is unavailable.', 503);
    }
    const instance = this.store.getAppInstanceByPackageId(packageId);
    if (!instance) {
      throw new AppPackageServiceError('APP_NOT_INSTALLED', 'Install this app before uninstalling it.', 409);
    }
    if (instance.status === 'uninstalled') {
      return {
        agent: { status: 'skipped', steps: [] },
        homepage: { skipped: true },
        instance: publicInstance(instance, this.store.getAppProjections(instance.id), this.store.getAppConfig(instance.id)),
      };
    }
    if (!['installed', 'disabled'].includes(instance.status)) {
      throw new AppPackageServiceError('APP_INVALID_TRANSITION', 'This app cannot be uninstalled from its current state.', 409);
    }

    const homepage = await this.removePackageFromHomepage(instance, homepageService);
    const agent = await this.agent.remove({ packageId: instance.packageId });
    const at = this.now().toISOString();
    this.store.markAppUninstalled({
      at,
      instanceId: instance.id,
      operationId: crypto.randomUUID(),
      request: { packageId: instance.packageId, preserveData: true, preserveSecrets: true, target: 'runtime-and-route' },
    });
    return {
      agent,
      homepage,
      instance: publicInstance(
        this.store.getAppInstanceByPackageId(packageId),
        this.store.getAppProjections(instance.id),
        this.store.getAppConfig(instance.id),
      ),
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
  linkEntryForHomepage,
  loopbackPortFor,
  materializeRuntimeCompose,
  renderDryRunProjections,
  resolveConfigTemplate,
  homepageProjectionApplied,
  runtimeApplied,
  stableJson,
};
