const assert = require('node:assert/strict');
const test = require('node:test');

const { AppAgentCore, AppRuntimeError, renderAppRoutes } = require('./agent-core.cjs');

const request = {
  appHost: 'example-tool.mos.home',
  caddy: { routes: [{ host: 'example-tool', reverseProxy: '127.0.0.1:18123', service: 'web' }] },
  compose: {
    services: [{
      build: { context: 'version-2/apps/example-tool', dockerfile: 'Dockerfile' },
      environment: { APP_HOST: '${app.host}', APP_SCHEME: '${app.scheme}', SERVER_HOST: '${app.publicUrl}' },
      id: 'web',
      internalPort: 3000,
      loopbackPort: 18123,
      volumes: ['configs:/configs'],
    }],
    volumes: ['configs'],
  },
  health: { target: 'http://127.0.0.1:18123/health', type: 'http' },
  instanceId: '12345678-1234-4123-8123-123456789abc',
  packageId: 'example-tool',
  packageVersion: '0.1.0',
  publicUrl: 'http://example-tool.mos.home/',
};

test('app agent exposes only narrow app runtime capabilities', async () => {
  const core = new AppAgentCore({ applyAppServices: async () => ({ steps: [] }), checkAppHealth: async () => ({}) });
  const status = await core.status();
  assert.deepEqual(status.capabilities, ['apps.multi-service.apply', 'apps.health.check', 'apps.multi-service.stop', 'apps.multi-service.remove', 'apps.network.connect']);
});

test('app route rendering uses structured host and loopback upstream only', () => {
  assert.equal(renderAppRoutes({
    appHost: 'example-tool.mos.home',
    reverseProxy: '127.0.0.1:18123',
  }), 'http://example-tool.mos.home {\n  reverse_proxy http://127.0.0.1:18123\n}\n');
  assert.equal(renderAppRoutes({
    appHost: 'example-tool.mos.example.com',
    reverseProxy: '127.0.0.1:18123',
    scheme: 'https',
  }), 'https://example-tool.mos.example.com {\n  reverse_proxy http://127.0.0.1:18123\n}\n');
});

test('app route rendering supports a structured tokenized iCal bridge', () => {
  const routes = renderAppRoutes({
    appHost: 'calendar.mos.home',
    internalIcalBridge: {
      basicAuth: { password: 'secret-pass', username: 'calendar-admin' },
      path: '/__mos-v2/ical/token-value',
      targetPath: '/calendar-admin/default-calendar/?export',
    },
    reverseProxy: '127.0.0.1:18124',
  });

  assert.match(routes, /handle \/__mos-v2\/ical\/token-value/u);
  assert.match(routes, /rewrite \* \/calendar-admin\/default-calendar\/\?export/u);
  assert.match(routes, /header_up Authorization "Basic Y2FsZW5kYXItYWRtaW46c2VjcmV0LXBhc3M="/u);
  assert.match(routes, /handle \{\n    reverse_proxy http:\/\/127\.0\.0\.1:18124/u);
});

test('app apply validates internal iCal bridge shape', async () => {
  const core = new AppAgentCore({ applyAppServices: async () => ({ steps: [] }) });
  const bridged = {
    ...request,
    caddy: {
      routes: [{
        ...request.caddy.routes[0],
        internalIcalBridge: {
          basicAuth: { password: 'secret-pass', username: 'calendar-admin' },
          path: '/__mos-v2/ical/token-value',
          targetPath: '/calendar-admin/default-calendar/?export',
        },
      }],
    },
  };

  await core.apply(bridged);
  await assert.rejects(() => core.apply({
    ...bridged,
    caddy: { routes: [{ ...bridged.caddy.routes[0], internalIcalBridge: { ...bridged.caddy.routes[0].internalIcalBridge, path: '/public' } }] },
  }), AppRuntimeError);
  await assert.rejects(() => core.apply({
    ...bridged,
    caddy: { routes: [{ ...bridged.caddy.routes[0], internalIcalBridge: { ...bridged.caddy.routes[0].internalIcalBridge, basicAuth: { password: 'x', username: 'bad:user' } } }] },
  }), AppRuntimeError);
});

test('app apply validates exact shape and delegates sanitized runtime fields', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async applyAppServices(input) {
      calls.push(input);
      return { steps: ['built', 'started', 'healthy'] };
    },
  });
  const result = await core.apply(request);

  assert.equal(result.status, 'applied');
  assert.equal(result.publicUrl, 'http://example-tool.mos.home/');
  assert.equal(calls[0].packageId, 'example-tool');
  assert.equal(calls[0].healthTarget, 'http://127.0.0.1:18123/health');
  assert.equal(calls[0].services[0].loopbackPort, 18123);
  assert.deepEqual(calls[0].services[0].environment, {
    APP_HOST: 'example-tool.mos.home',
    APP_SCHEME: 'http',
    SERVER_HOST: 'http://example-tool.mos.home/',
  });
  assert.match(calls[0].caddyRoutes, /reverse_proxy http:\/\/127\.0\.0\.1:18123/u);
});

test('app apply renders HTTPS Caddy routes when public URL is HTTPS', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async applyAppServices(input) {
      calls.push(input);
      return { steps: ['built', 'started', 'healthy'] };
    },
  });

  await core.apply({
    ...request,
    appHost: 'example-tool.mos.example.com',
    publicUrl: 'https://example-tool.mos.example.com/',
  });

  assert.match(calls[0].caddyRoutes, /^https:\/\/example-tool\.mos\.example\.com \{/u);
  assert.equal(calls[0].services[0].environment.APP_SCHEME, 'https');
});

test('app apply delegates multiple services while exposing only declared public routes', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async applyAppServices(input) {
      calls.push(input);
      return { steps: ['built', 'started', 'healthy'] };
    },
  });
  const multi = {
    ...request,
    caddy: { routes: [{ host: 'example-tool', reverseProxy: '127.0.0.1:18123', service: 'web' }] },
    compose: {
      services: [
        request.compose.services[0],
        {
          build: { context: 'version-2/apps/example-tool', dockerfile: 'Dockerfile.mysql' },
          environment: { MYSQL_ROOT_PASSWORD: 'secret' },
          id: 'database',
          internalPort: 3306,
          loopbackPort: 18124,
          volumes: ['mysql-data:/var/lib/mysql'],
        },
      ],
      volumes: ['configs', 'mysql-data'],
    },
  };

  await core.apply(multi);

  assert.equal(calls[0].services.length, 2);
  assert.equal(calls[0].services.find((service) => service.id === 'web').public, true);
  assert.equal(calls[0].services.find((service) => service.id === 'database').public, false);
  assert.match(calls[0].caddyRoutes, /example-tool\.mos\.home/u);
  assert.doesNotMatch(calls[0].caddyRoutes, /database/u);
});

test('app apply rejects arbitrary packages, paths, routes, and commands', async () => {
  const core = new AppAgentCore({ applyAppServices: async () => ({ steps: [] }) });
  await assert.rejects(() => core.apply({ ...request, command: 'docker ps' }), AppRuntimeError);
  await assert.rejects(() => core.apply({ ...request, packageId: '../vaultwarden' }), AppRuntimeError);
  await assert.rejects(() => core.apply({
    ...request,
    compose: { ...request.compose, services: [{ ...request.compose.services[0], build: { context: '../apps/example-tool', dockerfile: 'Dockerfile' } }] },
  }), AppRuntimeError);
  await assert.rejects(() => core.apply({
    ...request,
    caddy: { routes: [{ host: 'example-tool', reverseProxy: 'example-tool:3000' }] },
  }), AppRuntimeError);
  await assert.rejects(() => core.apply({
    ...request,
    health: { target: 'http://127.0.0.1:9999/health', type: 'http' },
  }), AppRuntimeError);
  await assert.rejects(() => core.apply({
    ...request,
    compose: { ...request.compose, services: [{ ...request.compose.services[0], environment: { 'bad-key': 'value' } }] },
  }), AppRuntimeError);
});

test('app health check validates loopback health projection only', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async checkAppHealth(input) {
      calls.push(input);
      return { status: 'healthy' };
    },
  });

  const result = await core.checkHealth({
    health: { target: 'http://127.0.0.1:18123/health', type: 'http' },
    packageId: 'example-tool',
  });

  assert.equal(result.status, 'healthy');
  assert.equal(result.packageId, 'example-tool');
  assert.deepEqual(calls, [{ healthTarget: 'http://127.0.0.1:18123/health', packageId: 'example-tool' }]);
  await assert.rejects(() => core.checkHealth({
    command: 'docker ps',
    health: { target: 'http://127.0.0.1:18123/health', type: 'http' },
    packageId: 'example-tool',
  }), AppRuntimeError);
  await assert.rejects(() => core.checkHealth({
    health: { target: 'http://example-tool:3000/health', type: 'http' },
    packageId: 'example-tool',
  }), AppRuntimeError);
});

test('app remove accepts only package-scoped removal fields and delegates volumes', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async removeAppService(input) {
      calls.push(input);
      return { steps: ['stopped', 'route-removed'] };
    },
  });

  const result = await core.remove({ packageId: 'example-tool' });

  assert.equal(result.status, 'removed');
  assert.deepEqual(calls, [{ packageId: 'example-tool', serviceIds: [], volumes: [] }]);
  await core.remove({ packageId: 'example-tool', services: ['web', 'database'], volumes: ['data', 'cache'] });
  assert.deepEqual(calls[1], { packageId: 'example-tool', serviceIds: ['web', 'database'], volumes: ['data', 'cache'] });
  await assert.rejects(() => core.remove({ packageId: 'example-tool', volumes: true }), AppRuntimeError);
  await assert.rejects(() => core.remove({ packageId: 'example-tool', volumes: ['../bad'] }), AppRuntimeError);
  await assert.rejects(() => core.remove({ packageId: '../example-tool' }), AppRuntimeError);
  await assert.rejects(() => core.remove({ packageId: 'example-tool', services: ['../bad'] }), AppRuntimeError);
});

test('app stop accepts only package service ids and leaves route removal to uninstall', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async stopAppService(input) {
      calls.push(input);
      return { steps: ['stopped'] };
    },
  });

  const result = await core.stop({ packageId: 'example-tool', services: ['web'] });

  assert.equal(result.status, 'stopped');
  assert.deepEqual(calls, [{ packageId: 'example-tool', serviceIds: ['web'] }]);
  await assert.rejects(() => core.stop({ packageId: 'example-tool', volumes: ['data'] }), AppRuntimeError);
  await assert.rejects(() => core.stop({ packageId: 'example-tool', removeRoutes: true }), AppRuntimeError);
  await assert.rejects(() => core.stop({ packageId: '../example-tool' }), AppRuntimeError);
});

test('app network connect accepts only package and service ids', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async connectPackageNetwork(input) {
      calls.push(input);
      return { steps: ['network-connected'] };
    },
  });

  const result = await core.connectNetwork({
    consumerPackageId: 'seafile',
    providerPackageId: 'onlyoffice',
    providerServiceCount: 1,
    providerServices: ['onlyoffice'],
  });

  assert.equal(result.status, 'connected');
  assert.deepEqual(calls, [{
    consumerPackageId: 'seafile',
    providerPackageId: 'onlyoffice',
    providerServiceCount: 1,
    providerServices: ['onlyoffice'],
  }]);
  await assert.rejects(() => core.connectNetwork({
    consumerPackageId: '../seafile',
    providerPackageId: 'onlyoffice',
    providerServiceCount: 1,
    providerServices: ['onlyoffice'],
  }), AppRuntimeError);
  await assert.rejects(() => core.connectNetwork({
    consumerPackageId: 'seafile',
    providerPackageId: 'onlyoffice',
    providerServiceCount: 1,
    providerServices: ['bad/service'],
  }), AppRuntimeError);
});
