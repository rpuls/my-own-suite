const { detectEasyDoorBase } = require('../../shared/easy-door.cjs');

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

// `exactKeys` for requests where some documented fields are optional: every key
// present must be one the request allows, and the required ones must all be
// there. Spelling the combinations out instead takes 2^n key lists.
function allowedKeys(value, { optional = [], required = [] }) {
  const keys = Object.keys(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const allowed = new Set([...required, ...optional]);
  return keys.every((key) => allowed.has(key)) && required.every((key) => keys.includes(key));
}

function assertString(value, label, pattern = /^.+$/u) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', `${label} is invalid.`);
  }
}

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
// This agent is the process that runs `docker build`, so it is the only thing
// that knows what this host is; Suite Manager may well be a container built for
// something else. A host outside this map reports null rather than a guess: not
// knowing is what an older agent already reports, and both mean the same thing
// to the caller, so neither can block a package.
const HOST_ARCHITECTURES = Object.freeze({ arm64: 'arm64', x64: 'amd64' });
const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SEMVERISH_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SAFE_DOCKERFILE_PATTERN = /^(?:Dockerfile|Dockerfile\.[a-z0-9][a-z0-9-]*)$/u;
const SAFE_INTERNAL_PATH_PATTERN = /^\/__[A-Za-z0-9/_-]{8,220}$/u;
const SAFE_TARGET_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{1,220}$/u;
const PACKAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_REVISION_PATTERN = /^(?:sha256:[a-f0-9]{64}|[a-f0-9]{40,64})$/u;

function dockerIdentityFragment(value) {
  return String(value).replace(/^sha256:/u, '').slice(0, 12);
}

// The one place an app service image is named. Reclaiming a superseded image
// means naming it again from a different direction, and a tag this function did
// not build is a tag `docker image rm` would silently miss.
function packageImageTag({ packageDigest, packageId, packageVersion, serviceId, sourceRevision }) {
  // SemVer build metadata uses `+`, which Docker repository tags reject.
  // Keep the label value exact, but encode the tag's build separator.
  const dockerVersion = String(packageVersion).replace('+', '-build-');
  return `mos-app-${packageId}-${serviceId}:${dockerVersion}-pkg-${dockerIdentityFragment(packageDigest)}-src-${dockerIdentityFragment(sourceRevision)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function assertRuntimeRequest(input, { allowExpectedInstalledDigest = false } = {}) {
  const runtimeKeys = ['appHost', 'caddy', 'compose', 'health', 'instanceId', 'packageDigest', 'packageId', 'packageVersion', 'publicUrl', 'sourceRevision'];
  if (!exactKeys(input, allowExpectedInstalledDigest ? [...runtimeKeys, 'expectedInstalledDigest'] : runtimeKeys)) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app runtime fields are accepted.');
  }
  assertString(input.instanceId, 'instanceId', /^[0-9a-f-]{36}$/u);
  assertString(input.packageDigest, 'packageDigest', PACKAGE_DIGEST_PATTERN);
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  assertString(input.packageVersion, 'packageVersion', SEMVERISH_PATTERN);
  assertString(input.sourceRevision, 'sourceRevision', SOURCE_REVISION_PATTERN);
  if (allowExpectedInstalledDigest) assertString(input.expectedInstalledDigest, 'expectedInstalledDigest', PACKAGE_DIGEST_PATTERN);

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
    if (service?.build?.context !== `apps/${input.packageId}` || !SAFE_DOCKERFILE_PATTERN.test(String(service?.build?.dockerfile || ''))) {
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

// `allowInstance` is what separates an uninstall from a stop: only an uninstall
// may name the instance whose snapshot and images are to be discarded, so a stop
// cannot reach either.
function assertRuntimeRemoveRequest(input, { allowInstance = false, allowVolumes = false } = {}) {
  const optional = [
    'services',
    ...(allowVolumes ? ['volumes'] : []),
    ...(allowInstance ? ['installedSourceRevision', 'instanceId'] : []),
  ];
  if (!allowedKeys(input, { optional, required: ['packageId'] })) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app runtime removal fields are accepted.');
  }
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  if (input.instanceId !== undefined) assertString(input.instanceId, 'instanceId', /^[0-9a-f-]{36}$/u);
  if (input.installedSourceRevision !== undefined) assertString(input.installedSourceRevision, 'installedSourceRevision', SOURCE_REVISION_PATTERN);
  const services = input.services === undefined ? [] : input.services;
  if (!Array.isArray(services) || services.length > 8 || services.some((service) => !DNS_LABEL_PATTERN.test(String(service)))) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The app runtime removal service list is invalid.');
  }
  const volumes = input.volumes === undefined ? [] : input.volumes;
  if (!Array.isArray(volumes) || volumes.length > 16 || volumes.some((volume) => !DNS_LABEL_PATTERN.test(String(volume)))) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The app runtime removal volume list is invalid.');
  }
  return { installedSourceRevision: input.installedSourceRevision, instanceId: input.instanceId, packageId: input.packageId, services, volumes };
}

function assertNetworkConnectRequest(input) {
  if (!exactKeys(input, ['consumerPackageId', 'providerPackageId', 'providerServiceCount', 'providerServices'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app network fields are accepted.');
  }
  assertString(input.consumerPackageId, 'consumerPackageId', PACKAGE_ID_PATTERN);
  assertString(input.providerPackageId, 'providerPackageId', PACKAGE_ID_PATTERN);
  if (!Number.isInteger(input.providerServiceCount) || input.providerServiceCount < 1 || input.providerServiceCount > 8) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The provider service count is invalid.');
  }
  if (!Array.isArray(input.providerServices) || input.providerServices.length < 1 || input.providerServices.length > 8) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The provider service list is invalid.');
  }
  for (const serviceId of input.providerServices) {
    if (!DNS_LABEL_PATTERN.test(String(serviceId))) {
      throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Provider service ids must be DNS-safe labels.');
    }
  }
  return {
    consumerPackageId: input.consumerPackageId,
    providerPackageId: input.providerPackageId,
    providerServiceCount: input.providerServiceCount,
    providerServices: input.providerServices,
  };
}

function assertPackageUpdatePromoteRequest(input) {
  // `installedSourceRevision` is optional so that a Suite Manager talking to an
  // agent from before `apps.package.update.reclaim` keeps promoting normally: an
  // unreclaimed image wastes disk, but a promotion refused here after the
  // candidate is already serving traffic would strand a committed update.
  const promoteKeys = ['candidateDigest', 'expectedInstalledDigest', 'instanceId', 'packageId', 'rollbackSafe'];
  if (!exactKeys(input, promoteKeys) && !exactKeys(input, [...promoteKeys, 'installedSourceRevision'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app update promotion fields are accepted.');
  }
  assertString(input.instanceId, 'instanceId', /^[0-9a-f-]{36}$/u);
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  assertString(input.candidateDigest, 'candidateDigest', PACKAGE_DIGEST_PATTERN);
  assertString(input.expectedInstalledDigest, 'expectedInstalledDigest', PACKAGE_DIGEST_PATTERN);
  if (input.installedSourceRevision !== undefined) assertString(input.installedSourceRevision, 'installedSourceRevision', SOURCE_REVISION_PATTERN);
  if (typeof input.rollbackSafe !== 'boolean') throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'rollbackSafe must be a boolean.');
  return input;
}

function assertPackageSnapshotRequest(input) {
  if (!exactKeys(input, ['instanceId', 'packageDigest', 'packageId'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app package snapshot fields are accepted.');
  }
  assertString(input.instanceId, 'instanceId', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  assertString(input.packageDigest, 'packageDigest', PACKAGE_DIGEST_PATTERN);
  return input;
}

function assertPackageSnapshotExternalRequest(input) {
  if (!exactKeys(input, ['candidateDigest', 'candidatePath', 'instanceId', 'packageId'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented external app package snapshot fields are accepted.');
  }
  assertString(input.instanceId, 'instanceId', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  assertString(input.candidateDigest, 'candidateDigest', PACKAGE_DIGEST_PATTERN);
  assertString(input.candidatePath, 'candidatePath');
  return input;
}

function assertPackageUpdateStageRequest(input) {
  if (!exactKeys(input, ['candidateDigest', 'candidatePath', 'expectedInstalledDigest', 'instanceId', 'packageId'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only the documented app package update staging fields are accepted.');
  }
  assertString(input.instanceId, 'instanceId', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assertString(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  assertString(input.candidateDigest, 'candidateDigest', PACKAGE_DIGEST_PATTERN);
  assertString(input.expectedInstalledDigest, 'expectedInstalledDigest', PACKAGE_DIGEST_PATTERN);
  assertString(input.candidatePath, 'candidatePath');
  return input;
}

function runtimeServices(input, routes) {
  return input.compose.services.map((service) => ({
    dockerfile: service.build.dockerfile,
    environment: resolveEnvironment(service.environment, { publicUrl: input.publicUrl }),
    id: service.id,
    imageTag: packageImageTag({
      packageDigest: input.packageDigest,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      serviceId: service.id,
      sourceRevision: input.sourceRevision,
    }),
    internalPort: service.internalPort,
    loopbackPort: service.loopbackPort,
    public: routes.some((route) => route.service === service.id),
    volumes: service.volumes,
  }));
}

function runtimeAdapterInput(input, routes, easyDoorBase = null) {
  const publicUrl = new URL(input.publicUrl);
  return {
    caddyRoutes: renderAppRoutes({ appHost: input.appHost, easyDoorBase, routes, scheme: publicUrl.protocol.replace(/:$/u, '') }),
    healthTarget: input.health.target,
    instanceId: input.instanceId,
    packageDigest: input.packageDigest,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    services: runtimeServices(input, routes),
    sourceRevision: input.sourceRevision,
  };
}

function assertPackageUpdateActivateRequest(input) {
  if (!exactKeys(input, ['candidate', 'installed'])) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'Only installed and candidate update runtimes are accepted.');
  }
  const candidate = assertRuntimeRequest(input.candidate, { allowExpectedInstalledDigest: true });
  const installed = assertRuntimeRequest(input.installed);
  if (input.candidate.instanceId !== input.installed.instanceId
      || input.candidate.packageId !== input.installed.packageId
      || input.candidate.expectedInstalledDigest !== input.installed.packageDigest) {
    throw new AppRuntimeError('INVALID_APP_RUNTIME_REQUEST', 'The update runtimes do not describe one identity-bound app instance.');
  }
  return { candidate, installed };
}

const assertPackageUpdateRollbackRequest = assertPackageUpdateActivateRequest;

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

function renderAppRouteSite({ appHost, internalIcalBridge = null, reverseProxy, scheme = 'http' }) {
  const bridge = internalIcalBridge ? `  handle ${internalIcalBridge.path} {
    rewrite * ${internalIcalBridge.targetPath}
    reverse_proxy http://${reverseProxy} {
      header_up Authorization "Basic ${Buffer.from(`${internalIcalBridge.basicAuth.username}:${internalIcalBridge.basicAuth.password}`).toString('base64')}"
    }
  }

  handle {
    reverse_proxy http://${reverseProxy}
  }` : `  reverse_proxy http://${reverseProxy}`;
  return `${scheme}://${appHost} {
${bridge}
}
`;
}

// `easyDoorBase` gives every route a second site on the Easy Door name, so an app
// is reachable from the same door the owner reached Suite Manager through. Unlike
// Suite Manager's own block, which Caddy matches by pattern, an app route names
// one exact host and so has to be re-derived here on every apply — which is also
// what closes it: the base is null whenever this box is not serving the door.
function renderAppRoutes({ appHost, easyDoorBase = null, internalIcalBridge = null, reverseProxy, routes = null, scheme = 'http' }) {
  if (Array.isArray(routes)) {
    const baseDomain = appHost.split('.').slice(1).join('.');
    const baseDomains = easyDoorBase && easyDoorBase !== baseDomain ? [baseDomain, easyDoorBase] : [baseDomain];
    return routes.flatMap((route) => baseDomains.map((base) => renderAppRouteSite({
      appHost: `${route.host}.${base}`,
      internalIcalBridge: route.internalIcalBridge || null,
      reverseProxy: route.reverseProxy,
      scheme,
    }))).join('\n');
  }
  return renderAppRouteSite({ appHost, internalIcalBridge, reverseProxy, scheme });
}

class AppAgentCore {
  constructor(adapter, { easyDoorBase = detectEasyDoorBase } = {}) {
    this.adapter = adapter;
    this.easyDoorBase = easyDoorBase;
  }

  async status() {
    return {
      capabilities: ['apps.multi-service.apply', 'apps.health.check', 'apps.multi-service.stop', 'apps.multi-service.remove', 'apps.network.connect', 'apps.package.snapshot', 'apps.package.snapshot.external', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote', 'apps.package.update.reclaim', 'apps.package.remove.reclaim'],
      contractVersion: 9,
      hostArchitecture: HOST_ARCHITECTURES[process.arch] || null,
      service: 'mos-app-agent',
    };
  }

  async snapshotPackage(input) {
    const request = assertPackageSnapshotRequest(input);
    const result = await this.adapter.snapshotAppPackage(request);
    return { ...result, instanceId: request.instanceId, packageDigest: request.packageDigest, packageId: request.packageId, status: 'snapshotted' };
  }

  async snapshotExternalPackage(input) {
    const request = assertPackageSnapshotExternalRequest(input);
    const result = await this.adapter.snapshotExternalAppPackage(request);
    return { ...result, instanceId: request.instanceId, packageDigest: request.candidateDigest, packageId: request.packageId, status: 'snapshotted' };
  }

  async stagePackageUpdate(input) {
    const request = assertPackageUpdateStageRequest(input);
    const result = await this.adapter.stageAppPackageUpdate(request);
    return { ...result, candidateDigest: request.candidateDigest, instanceId: request.instanceId, packageId: request.packageId, status: 'staged' };
  }

  async buildPackageUpdate(input) {
    const { routes } = assertRuntimeRequest(input, { allowExpectedInstalledDigest: true });
    const result = await this.adapter.buildAppPackageUpdate({
      candidateDigest: input.packageDigest,
      expectedInstalledDigest: input.expectedInstalledDigest,
      instanceId: input.instanceId,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      services: runtimeServices(input, routes),
      sourceRevision: input.sourceRevision,
    });
    return { ...result, candidateDigest: input.packageDigest, instanceId: input.instanceId, packageId: input.packageId, status: 'built' };
  }

  async activatePackageUpdate(input) {
    const { candidate, installed } = assertPackageUpdateActivateRequest(input);
    const easyDoorBase = this.easyDoorBase();
    const result = await this.adapter.activateAppPackageUpdate({
      candidate: runtimeAdapterInput(input.candidate, candidate.routes, easyDoorBase),
      installed: runtimeAdapterInput(input.installed, installed.routes, easyDoorBase),
    });
    return { ...result, candidateDigest: input.candidate.packageDigest, instanceId: input.candidate.instanceId, packageId: input.candidate.packageId, status: 'candidate-healthy' };
  }

  async promotePackageUpdate(input) {
    const request = assertPackageUpdatePromoteRequest(input);
    const result = await this.adapter.promoteAppPackageUpdate(request);
    return { ...result, candidateDigest: request.candidateDigest, instanceId: request.instanceId, packageId: request.packageId, status: 'snapshot-promoted' };
  }

  async rollbackPackageUpdate(input) {
    const { candidate, installed } = assertPackageUpdateRollbackRequest(input);
    const easyDoorBase = this.easyDoorBase();
    const result = await this.adapter.rollbackAppPackageUpdate({
      candidate: runtimeAdapterInput(input.candidate, candidate.routes, easyDoorBase),
      installed: runtimeAdapterInput(input.installed, installed.routes, easyDoorBase),
    });
    return { ...result, instanceId: input.installed.instanceId, packageDigest: input.installed.packageDigest, packageId: input.installed.packageId, status: 'installed-restored' };
  }

  async apply(input) {
    const { routes, services } = assertRuntimeRequest(input);
    const publicUrl = new URL(input.publicUrl);
    const scheme = publicUrl.protocol.replace(/:$/u, '');
    const result = await this.adapter.applyAppServices({
      caddyRoutes: renderAppRoutes({ appHost: input.appHost, easyDoorBase: this.easyDoorBase(), routes, scheme }),
      healthTarget: input.health.target,
      instanceId: input.instanceId,
      packageDigest: input.packageDigest,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      publicUrl: input.publicUrl,
      sourceRevision: input.sourceRevision,
      services: runtimeServices(input, routes),
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
    const { installedSourceRevision, instanceId, packageId, services, volumes } = assertRuntimeRemoveRequest(input, { allowInstance: true, allowVolumes: true });
    const result = await this.adapter.removeAppService({
      ...(instanceId ? { instanceId } : {}),
      ...(installedSourceRevision ? { installedSourceRevision } : {}),
      packageId,
      serviceIds: services,
      volumes,
    });
    return {
      ...result,
      packageId,
      status: 'removed',
    };
  }

  async stop(input) {
    const { packageId, services } = assertRuntimeRemoveRequest(input);
    const result = await this.adapter.stopAppService({ packageId, serviceIds: services });
    return {
      ...result,
      packageId,
      status: 'stopped',
    };
  }

  async connectNetwork(input) {
    const request = assertNetworkConnectRequest(input);
    const result = await this.adapter.connectPackageNetwork(request);
    return {
      ...result,
      status: 'connected',
    };
  }
}

module.exports = { AppAgentCore, AppRuntimeError, assertHealthCheckRequest, assertNetworkConnectRequest, assertPackageSnapshotExternalRequest, assertPackageSnapshotRequest, assertRuntimeRemoveRequest, assertRuntimeRequest, exactKeys, packageImageTag, renderAppRoutes, resolveEnvironment };
