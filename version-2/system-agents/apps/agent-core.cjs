class AppRuntimeError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function exactKeys(value, expected) {
  const keys = Object.keys(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).sort();
  return keys.join(',') === [...expected].sort().join(',');
}

function assertString(value, label, pattern = /^.+$/u) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', `${label} is invalid.`);
  }
}

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SEMVERISH_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SAFE_DOCKERFILE_PATTERN = /^(?:Dockerfile|Dockerfile\.[a-z0-9][a-z0-9-]*)$/u;
const SAFE_INTERNAL_PATH_PATTERN = /^\/__[A-Za-z0-9/_-]{8,220}$/u;
const SAFE_TARGET_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{1,220}$/u;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function assertRuntimeRequest(input) {
  if (!exactKeys(input, ['appHost', 'caddy', 'compose', 'health', 'instanceId', 'packageId', 'packageVersion', 'publicUrl'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app runtime fields are accepted.');
  }
  assertString(input.instanceId, 'instanceId', /^[0-9a-f-]{36}$/u);
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  assertString(input.packageVersion, 'packageVersion', SEMVERISH_PATTERN);

  const services = input.compose?.services;
  const routes = input.caddy?.routes;
  if (!Array.isArray(services) || services.length < 1 || services.length > 8 || !Array.isArray(routes) || routes.length < 1 || routes.length > 8) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The app runtime request must declare one to eight services and routes.');
  }

  const servicesById = new Map();
  const loopbackPorts = new Set();
  for (const service of services) {
    if (!DNS_LABEL_PATTERN.test(String(service?.id || ''))) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Service ids must be DNS-safe labels.');
    }
    if (servicesById.has(service.id)) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Service ids must be unique.');
    }
    if (service?.build?.context !== `version-2/apps/${input.packageId}` || !SAFE_DOCKERFILE_PATTERN.test(String(service?.build?.dockerfile || ''))) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Each service build must use the installed app package folder.');
    }
    if (!Number.isInteger(service?.internalPort) || service.internalPort < 1 || service.internalPort > 65535) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'A service internal port is invalid.');
    }
    if (!Number.isInteger(service?.loopbackPort) || service.loopbackPort < 1024 || service.loopbackPort > 65535 || loopbackPorts.has(service.loopbackPort)) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'A service loopback port is invalid.');
    }
    loopbackPorts.add(service.loopbackPort);
    servicesById.set(service.id, service);
  }

  const normalizedRoutes = [];
  for (const route of routes) {
    if (!DNS_LABEL_PATTERN.test(String(route?.host || ''))) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Route hosts must be DNS-safe labels.');
    }
    if (!DNS_LABEL_PATTERN.test(String(route?.service || '')) || !servicesById.has(route.service)) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Each route must reference a declared service.');
    }
    const service = servicesById.get(route.service);
    if (route?.reverseProxy !== `127.0.0.1:${service.loopbackPort}`) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Each route must target its assigned loopback port.');
    }
    if (route.internalIcalBridge !== undefined) {
      const bridge = route.internalIcalBridge;
      if (!exactKeys(bridge, ['basicAuth', 'path', 'targetPath']) || !SAFE_INTERNAL_PATH_PATTERN.test(String(bridge.path || '')) || !SAFE_TARGET_PATH_PATTERN.test(String(bridge.targetPath || ''))) {
        throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The internal iCal bridge projection is invalid.');
      }
      if (!exactKeys(bridge.basicAuth, ['password', 'username']) || typeof bridge.basicAuth.username !== 'string' || typeof bridge.basicAuth.password !== 'string' || /[\r\n:]/u.test(bridge.basicAuth.username) || /[\r\n]/u.test(bridge.basicAuth.password) || !bridge.basicAuth.username || !bridge.basicAuth.password) {
        throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The internal iCal bridge auth projection is invalid.');
      }
    }
    normalizedRoutes.push(route);
  }
  const route = normalizedRoutes[0];
  assertString(input.appHost, 'appHost', new RegExp(`^${escapeRegExp(route.host)}\\.[a-z0-9.-]+$`, 'u'));
  assertString(input.publicUrl, 'publicUrl', new RegExp(`^https?://${escapeRegExp(input.appHost)}/$`, 'u'));
  if (input.health?.type !== 'http' || typeof input.health?.target !== 'string') {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The app health projection is invalid.');
  }
  let healthUrl;
  try {
    healthUrl = new URL(input.health.target);
  } catch {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The app health URL is invalid.');
  }
  const healthService = services.find((candidate) => String(candidate.loopbackPort) === healthUrl.port);
  if (healthUrl.protocol !== 'http:' || healthUrl.hostname !== '127.0.0.1' || !healthService) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The health check must target the assigned loopback port.');
  }

  return { routes: normalizedRoutes, services };
}

function assertHealthCheckRequest(input) {
  if (!exactKeys(input, ['health', 'packageId'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app health fields are accepted.');
  }
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  if (input.health?.type !== 'http' || typeof input.health?.target !== 'string') {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The app health projection is invalid.');
  }
  let healthUrl;
  try {
    healthUrl = new URL(input.health.target);
  } catch {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The app health URL is invalid.');
  }
  if (healthUrl.protocol !== 'http:' || healthUrl.hostname !== '127.0.0.1' || !healthUrl.port) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The health check must target a loopback app port.');
  }
  return input.health;
}

function assertRuntimeRemoveRequest(input) {
  if (!exactKeys(input, ['packageId']) && !exactKeys(input, ['packageId', 'services'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app runtime removal fields are accepted.');
  }
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  const services = input.services === undefined ? [] : input.services;
  if (!Array.isArray(services) || services.length > 8 || services.some((service) => !DNS_LABEL_PATTERN.test(String(service)))) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The app runtime removal service list is invalid.');
  }
  return { packageId: input.packageId, services };
}

function resolveEnvironment(environment, context) {
  const source = environment === undefined ? {} : environment;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The service environment projection is invalid.');
  }
  const resolved = {};
  for (const [key, value] of Object.entries(source)) {
    if (!ENV_KEY_PATTERN.test(key) || typeof value !== 'string') {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The service environment projection is invalid.');
    }
    const publicUrl = new URL(context.publicUrl);
    resolved[key] = value
      .replace(/\$\{app\.publicUrl\}/gu, context.publicUrl)
      .replace(/\$\{app\.host\}/gu, publicUrl.host)
      .replace(/\$\{app\.scheme\}/gu, publicUrl.protocol.replace(/:$/u, ''));
  }
  return resolved;
}

function renderAppRouteSite({ appHost, internalIcalBridge = null, reverseProxy }) {
  const bridge = internalIcalBridge ? `  handle ${internalIcalBridge.path} {
    rewrite * ${internalIcalBridge.targetPath}
    reverse_proxy http://${reverseProxy} {
      header_up Authorization "Basic ${Buffer.from(`${internalIcalBridge.basicAuth.username}:${internalIcalBridge.basicAuth.password}`).toString('base64')}"
    }
  }

  handle {
    reverse_proxy http://${reverseProxy}
  }` : `  reverse_proxy http://${reverseProxy}`;
  return `http://${appHost} {
${bridge}
}
`;
}

function renderAppRoutes({ appHost, internalIcalBridge = null, reverseProxy, routes = null }) {
  if (Array.isArray(routes)) {
    return routes.map((route) => renderAppRouteSite({
      appHost: `${route.host}.${appHost.split('.').slice(1).join('.')}`,
      internalIcalBridge: route.internalIcalBridge || null,
      reverseProxy: route.reverseProxy,
    })).join('\n');
  }
  return renderAppRouteSite({ appHost, internalIcalBridge, reverseProxy });
}

class AppAgentCore {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async status() {
    return {
      capabilities: ['apps.multi-service.apply', 'apps.health.check', 'apps.multi-service.remove'],
      service: 'mos-v2-app-agent',
    };
  }

  async apply(input) {
    const { routes, services } = assertRuntimeRequest(input);
    const result = await this.adapter.applyAppServices({
      caddyRoutes: renderAppRoutes({ appHost: input.appHost, routes }),
      healthTarget: input.health.target,
      packageId: input.packageId,
      publicUrl: input.publicUrl,
      services: services.map((service) => ({
        dockerfile: service.build.dockerfile,
        environment: resolveEnvironment(service.environment, { publicUrl: input.publicUrl }),
        id: service.id,
        imageTag: `mos-v2-app-${input.packageId}-${service.id}:${input.packageVersion}`,
        internalPort: service.internalPort,
        loopbackPort: service.loopbackPort,
        public: routes.some((route) => route.service === service.id),
        volumes: service.volumes,
      })),
    });
    return {
      ...result,
      appHost: input.appHost,
      publicUrl: input.publicUrl,
      status: 'applied',
    };
  }

  async checkHealth(input) {
    const health = assertHealthCheckRequest(input);
    const result = await this.adapter.checkAppHealth({
      healthTarget: health.target,
      packageId: input.packageId,
    });
    return {
      ...result,
      packageId: input.packageId,
      status: 'healthy',
    };
  }

  async remove(input) {
    const { packageId, services } = assertRuntimeRemoveRequest(input);
    const result = await this.adapter.removeAppService({ packageId, serviceIds: services });
    return {
      ...result,
      packageId,
      status: 'removed',
    };
  }
}

module.exports = { AppAgentCore, AppRuntimeError, assertHealthCheckRequest, assertRuntimeRemoveRequest, assertRuntimeRequest, exactKeys, renderAppRoutes, resolveEnvironment };
