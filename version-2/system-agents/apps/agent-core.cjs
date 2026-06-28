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
const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SEMVERISH_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SAFE_DOCKERFILE_PATTERN = /^(?:Dockerfile|Dockerfile\.[a-z0-9][a-z0-9-]*)$/u;

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
  if (!Array.isArray(services) || services.length !== 1 || !Array.isArray(routes) || routes.length !== 1) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'This first runtime slice supports one service and one route.');
  }

  const service = services[0];
  const route = routes[0];
  if (!DNS_LABEL_PATTERN.test(String(service?.id || '')) || !DNS_LABEL_PATTERN.test(String(route?.host || ''))) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Service and route ids must be DNS-safe labels.');
  }
  if (service?.build?.context !== `version-2/apps/${input.packageId}` || !SAFE_DOCKERFILE_PATTERN.test(String(service?.build?.dockerfile || ''))) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The service build must use the installed app package folder.');
  }
  if (!Number.isInteger(service?.internalPort) || service.internalPort < 1 || service.internalPort > 65535) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The service internal port is invalid.');
  }
  if (!Number.isInteger(service?.loopbackPort) || service.loopbackPort < 1024 || service.loopbackPort > 65535) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The service loopback port is invalid.');
  }
  if (route?.reverseProxy !== `127.0.0.1:${service.loopbackPort}`) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The route must target the assigned loopback port.');
  }
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
  if (healthUrl.protocol !== 'http:' || healthUrl.hostname !== '127.0.0.1' || healthUrl.port !== String(service.loopbackPort)) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The health check must target the assigned loopback port.');
  }

  return { route, service };
}

function renderAppRoutes({ appHost, reverseProxy }) {
  return `http://${appHost} {
  reverse_proxy http://${reverseProxy}
}
`;
}

class AppAgentCore {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async status() {
    return {
      capabilities: ['apps.one-service.apply'],
      service: 'mos-v2-app-agent',
    };
  }

  async apply(input) {
    const { route, service } = assertRuntimeRequest(input);
    const result = await this.adapter.applyAppService({
      caddyRoutes: renderAppRoutes({ appHost: input.appHost, reverseProxy: route.reverseProxy }),
      dockerfile: service.build.dockerfile,
      healthTarget: input.health.target,
      imageTag: `mos-v2-app-${input.packageId}:${input.packageVersion}`,
      internalPort: service.internalPort,
      loopbackPort: service.loopbackPort,
      packageId: input.packageId,
      publicUrl: input.publicUrl,
      volumes: service.volumes,
    });
    return {
      ...result,
      appHost: input.appHost,
      publicUrl: input.publicUrl,
      status: 'applied',
    };
  }
}

module.exports = { AppAgentCore, AppRuntimeError, assertRuntimeRequest, exactKeys, renderAppRoutes };
