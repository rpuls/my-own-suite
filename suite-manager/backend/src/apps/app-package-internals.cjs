// Shared internals of the app package services.
//
// Install (AppPackageService) and update (AppUpdateService) are separate
// domains that nonetheless render the same instance: the same config rows and
// secrets, the same runtime projections, the same Homepage entries, the same
// public shapes. Those live here so neither service imports the other and
// neither grows its own copy — a projection that differs between installing an
// app and updating it is an app whose runtime changes meaning under it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  SUPPORTED_ARCHITECTURES,
  effectiveRouteHost,
  stableJson,
} = require('./package-contracts.cjs');

const APP_LOOPBACK_PORT_BASE = 18000;
const APP_LOOPBACK_PORT_SPAN = 1000;

// A POSIX environment variable name. Deliberately wider than the manifest's own
// upper-case-only rule: owner environment exists for what upstream projects
// actually document, and a handful of them ship lower-case names.
const OWNER_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// The key an owner env secret is stored under in the instance's secret
// directory. Namespaced so it cannot collide with a config row's key, whose
// grammar has no dots, and so the uninstall cleanup that removes the whole
// instance directory keeps covering it.
function ownerEnvSecretKey(service, name) {
  return `env.${service}.${name}`;
}

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
  // The validator only admits kind "random" today; refusing anything else here
  // keeps a future kind from silently producing random bytes on a MOS release
  // that predates it.
  if (field.generated.kind !== 'random') {
    throw new AppPackageServiceError('APP_SETUP_INVALID', `Unsupported generated value kind: ${String(field.generated.kind)}.`, 400);
  }
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

// `ownerEnv` is a projection-only namespace: MOS writes ${ownerEnv.NAME} into
// stored projections and resolves it here at materialize time, exactly as
// integration env does with ${config.*}/${secret.*}. It is deliberately absent
// from KNOWN_NAMESPACES in manifest-semantics.cjs, so an authored manifest that
// references it still fails validation — package authors must never see it.
//
// Resolved last, and in a single pass over the original string, so an owner's
// value is inserted as literal text and can never be re-read as a template.
// `smtp` is the owner's shared outbound email relay, a Map of ${smtp.*} values.
// Like `secret` and `ownerEnv` it is resolved only when supplied — the store-time
// render passes none, so ${smtp.*} stays a literal reference in the stored
// projection and the digest, and the real host and password appear only in the
// materialized runtime handed to the agent. An unconfigured relay (null map)
// leaves the reference untouched, exactly as an unset owner-env name does.
function resolveConfigTemplate(value, configRows, { app = {}, includeSecrets = false, ownerEnv = null, smtp = null } = {}) {
  if (typeof value !== 'string') return value;
  const values = configValueMap(configRows, { includeSecrets });
  return value
    .replace(/\$\{app\.publicUrl\}/gu, () => (typeof app.publicUrl === 'string' ? app.publicUrl : '${app.publicUrl}'))
    .replace(/\$\{app\.host\}/gu, () => (typeof app.host === 'string' ? app.host : '${app.host}'))
    .replace(/\$\{app\.scheme\}/gu, () => (typeof app.scheme === 'string' ? app.scheme : '${app.scheme}'))
    .replace(/\$\{config\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => (values.has(key) ? String(values.get(key)) : match))
    .replace(/\$\{secret\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => (values.has(key) ? String(values.get(key)) : match))
    .replace(/\$\{smtp\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => (smtp?.has(key) ? String(smtp.get(key)) : match))
    .replace(/\$\{ownerEnv\.([A-Za-z_][A-Za-z0-9_]*)\}/gu, (match, name) => (ownerEnv?.has(name) ? String(ownerEnv.get(name)) : match));
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
        // The projected host is the app's real web address: the agent renders
        // every Caddy site from it, and appHost is derived from it. External
        // packages are placed under the reserved `ext-` prefix here, at the one
        // point a host enters the runtime, so every consumer downstream sees the
        // address that is actually served without having to know the rule.
        routes: manifest.routes.map((route) => ({
          host: effectiveRouteHost(route.host, packageId),
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

// Every value these rows could leak into free text, for redaction by exact
// value. All of them, not only the rows marked secret: an owner-set plain
// variable is theirs to see, but a generated value is never worth quoting.
function redactionSecretsFor(configRows = [], envRows = []) {
  return [
    ...configRows.map((row) => row.rawValue),
    ...envRows.map((row) => row.rawValue ?? row.value),
  ].filter((value) => typeof value === 'string');
}

// The same shape as publicConfig, for the same reason: a secret row exposes its
// fingerprint and a label to render, never its value.
function publicEnv(envRows = []) {
  return envRows.map((row) => ({
    fingerprint: row.fingerprint || null,
    name: row.name,
    redactedLabel: row.secret === true ? 'Hidden value' : null,
    secret: row.secret === true,
    service: row.service,
    updatedAt: row.updatedAt,
    ...(row.secret === true ? {} : { value: row.value }),
  }));
}

function publicInstance(instance, projections = [], configRows = [], envRows = []) {
  if (!instance) return null;
  return {
    config: publicConfig(configRows),
    enabled: instance.enabled,
    env: publicEnv(envRows),
    id: instance.id,
    installedAt: instance.installedAt,
    manifestDigest: instance.manifestDigest,
    packageId: instance.packageId,
    packageVersion: instance.packageVersion,
    guideState: instance.guideState || null,
    // Attached by the caller that looked it up rather than fetched here, so the
    // serializer stays a pure projection of what it was handed. Absent on every
    // path that has no reason to ask, which is most of them.
    lastFailure: instance.lastFailure || null,
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
  try {
    for (const field of setupFields(manifest)) {
      const hasUserValue = Object.hasOwn(supplied, field.id) && supplied[field.id] !== undefined && supplied[field.id] !== null && supplied[field.id] !== '';
      const generated = generateValue(field);
      // ${owner.*} defaults resolve in the setup form, which knows the owner
      // profile. A caller that skips the form must supply the value itself —
      // storing the unresolved reference would ship it into a container as
      // literal text.
      const fallbackDefault = typeof field.default === 'string' && /\$\{owner\./u.test(field.default) ? undefined : field.default;
      const value = hasUserValue ? supplied[field.id] : generated ?? fallbackDefault;
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
  } catch (error) {
    // A later required/invalid field can fail after an earlier secret was
    // already written. Remove only files created by this attempt: update
    // collection may share the instance directory with installed secrets.
    for (const row of rows) {
      if (row.secretRef) fs.rmSync(secretFilePath(secretDir, instanceId, row.key), { force: true });
    }
    throw error;
  }
}

// Owner env is resolved per service, because two services may each hold a name
// of their own and the projection carries only the reference. Secret values are
// read from disk by the caller and arrive here as `rawValue`, so this stays the
// one place a stored projection turns into something with secrets in it.
function ownerEnvValueMap(envRows, service) {
  const map = new Map();
  for (const row of envRows || []) {
    if (row.service !== service) continue;
    if (row.secret) {
      if (typeof row.rawValue === 'string') map.set(row.name, row.rawValue);
      continue;
    }
    if (row.value !== undefined) map.set(row.name, row.value);
  }
  return map;
}

function materializeRuntimeCompose(compose, configRows, envRows = [], { smtp = null } = {}) {
  return {
    ...compose,
    services: compose.services.map((service) => ({
      ...service,
      environment: renderEnvironment(service.environment, configRows, {
        includeSecrets: true,
        ownerEnv: ownerEnvValueMap(envRows, service.id),
        smtp,
      }),
    })),
  };
}

function materializeRuntimeCaddy(caddy, configRows) {
  return resolveTemplatesDeep(caddy, configRows, { includeSecrets: true });
}

// The address an installed app answers on, as projected. This is the only
// correct basis for an app's public identity.
//
// It must never be rebuilt from the package id. The app agent renders every
// Caddy site from the projected route host and asserts that appHost's first
// label agrees with it, so an appHost derived from the id is accepted only when
// the id happens to equal the route host. That holds for official packages by
// naming convention and is impossible for external ones, whose id is namespaced
// (`x-<hash>-<id>`) — which made every external install fail the agent's
// contract with "appHost is invalid" once the runtime was applied.
function primaryProjectedRoute(projections) {
  const caddy = projections.find((projection) => projection.kind === 'caddy')?.content;
  const route = Array.isArray(caddy?.routes) ? caddy.routes[0] : null;
  if (!route || typeof route.host !== 'string' || !route.host) return null;
  return route;
}

function appPublicIdentity(projections, requestContext = {}) {
  const route = primaryProjectedRoute(projections);
  const baseHost = String(requestContext.baseHost || '').trim().toLowerCase();
  if (!route || !baseHost) {
    throw new AppPackageServiceError('APP_RUNTIME_PROJECTION_INVALID', 'This app does not have enough route data to derive its web address.', 409);
  }
  const scheme = requestContext.scheme === 'https' ? 'https' : 'http';
  const appHost = `${route.host}.${baseHost}`;
  return { appHost, baseHost, publicUrl: `${scheme}://${appHost}/`, scheme };
}

function appRouteForHomepage(projections) {
  const route = primaryProjectedRoute(projections);
  if (!route) {
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

// Patch one service's compose environment and re-digest every projection.
// Shared by the two things that add env to a rendered projection — a connected
// integration and an owner's own variables — so both produce byte-identical
// projection shapes and neither can drift into its own copy.
function cloneProjectionWithServiceEnv(projections, targetService, values) {
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

// The integration env an instance's compose must carry is a pure function of
// its manifest, its config rows, and its integration relationships — never a
// patch left behind in stored projections. Values stay `${config.*}` and
// `${secret.*}` references (the config rows hold the resolved values), so the
// rendered projection is reproducible and secret-free. A relationship whose
// slot the manifest no longer declares contributes nothing, which is how an
// update that drops a slot sheds its env without special-casing.
function integrationEnvPatches(manifest, configRows, integrations, instanceId) {
  const patches = [];
  for (const relationship of integrations || []) {
    if (relationship.consumerInstanceId !== instanceId || relationship.status === 'removed') continue;
    const [slotId, slot] = integrationSlots(manifest).find(([id]) => id === relationship.consumerIntegrationSlot) || [];
    const target = slot?.apply?.kind === 'service-env' ? manifest.configTargets?.[slot.apply.target] : null;
    if (!target || target.kind !== 'service-env') continue;
    const values = {};
    for (const envKey of Object.keys(slot.apply.values || {})) {
      const configKey = integrationConfigKey(slotId, envKey);
      const row = configRows.find((item) => item.key === configKey);
      if (!row) continue;
      values[envKey] = row.secretRef ? `\${secret.${configKey}}` : `\${config.${configKey}}`;
    }
    if (Object.keys(values).length) patches.push({ service: target.service, values });
  }
  return patches;
}

// The one way an instance's projections are produced. Everything that persists
// projections for an instance with integration relationships must render
// through here, so that stored projections are always reproducible from their
// inputs and an update rendered from the candidate manifest cannot lose the
// integration env a connect once carried.
// Every environment variable name on a service that MOS itself decides: the
// keys the manifest declares, plus the keys a connected integration contributes
// to that service for this instance. Computed rather than listed, so a package
// that adds a variable, or an integration that is connected later, narrows the
// owner's key space without anyone remembering to update a table.
function managedEnvNames(manifest, configRows, integrations, instanceId, service) {
  const declared = manifest.resources?.services?.[service]?.env;
  const names = new Set(Object.keys(isRecord(declared) ? declared : {}));
  for (const patch of integrationEnvPatches(manifest, configRows, integrations, instanceId)) {
    if (patch.service !== service) continue;
    for (const key of Object.keys(patch.values)) names.add(key);
  }
  return names;
}

// Owner env as compose patches. Values stay `${ownerEnv.NAME}` references, so
// the stored projection is reproducible and secret-free exactly as integration
// env is, and a value the owner edits does not have to be re-rendered anywhere
// else. Names MOS manages are dropped rather than applied: the save path
// refuses them with a message naming the key, and this makes it structurally
// impossible for a stale owner row to shadow a manifest or integration value if
// the managed set later grows over it.
function ownerEnvPatches(manifest, configRows, integrations, instanceId, envRows) {
  const services = new Map();
  for (const row of envRows || []) {
    if (!manifest.resources?.services?.[row.service]) continue;
    if (managedEnvNames(manifest, configRows, integrations, instanceId, row.service).has(row.name)) continue;
    const values = services.get(row.service) || {};
    values[row.name] = `\${ownerEnv.${row.name}}`;
    services.set(row.service, values);
  }
  return [...services].map(([service, values]) => ({ service, values }));
}

function renderInstanceProjections(manifest, configRows = [], { instanceId, integrations = [], ownerEnv = [], packageId = manifest.id } = {}) {
  let projections = renderDryRunProjections(manifest, configRows, { packageId });
  // Owner env first, integration env second: a later patch wins the key, so
  // this ordering is the second half of the guarantee that a MOS-managed name
  // is never overridden by an owner-set one.
  for (const patch of ownerEnvPatches(manifest, configRows, integrations, instanceId, ownerEnv)) {
    projections = cloneProjectionWithServiceEnv(projections, patch.service, patch.values);
  }
  for (const patch of integrationEnvPatches(manifest, configRows, integrations, instanceId)) {
    projections = cloneProjectionWithServiceEnv(projections, patch.service, patch.values);
  }
  return projections;
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

module.exports = {
  APP_LOOPBACK_PORT_BASE,
  APP_LOOPBACK_PORT_SPAN,
  AppPackageServiceError,
  OWNER_ENV_NAME_PATTERN,
  appPublicIdentity,
  appRouteForHomepage,
  primaryProjectedRoute,
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
  isRecord,
  loopbackPortFor,
  managedEnvNames,
  materializeRuntimeCaddy,
  materializeRuntimeCompose,
  ownerEnvSecretKey,
  privacyReviewPresentation,
  publicEnv,
  publicInstance,
  readSecretValue,
  redactionSecretsFor,
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
  setupFields,
  writeSecretFile,
};
