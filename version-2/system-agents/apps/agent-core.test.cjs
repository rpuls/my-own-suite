const assert = require('node:assert/strict');
const test = require('node:test');

const { AppAgentCore, AppRuntimeError, renderAppRoutes } = require('./agent-core.cjs');

const request = {
  appHost: 'example-tool.mos.home',
  caddy: { routes: [{ host: 'example-tool', reverseProxy: '127.0.0.1:18123' }] },
  compose: {
    services: [{
      build: { context: 'version-2/apps/example-tool', dockerfile: 'Dockerfile' },
      environment: { SERVER_HOST: '${app.publicUrl}' },
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
  const core = new AppAgentCore({ applyAppService: async () => ({ steps: [] }), checkAppHealth: async () => ({}) });
  const status = await core.status();
  assert.deepEqual(status.capabilities, ['apps.one-service.apply', 'apps.health.check', 'apps.one-service.remove']);
});

test('app route rendering uses structured host and loopback upstream only', () => {
  assert.equal(renderAppRoutes({
    appHost: 'example-tool.mos.home',
    reverseProxy: '127.0.0.1:18123',
  }), 'http://example-tool.mos.home {\n  reverse_proxy http://127.0.0.1:18123\n}\n');
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
  const core = new AppAgentCore({ applyAppService: async () => ({ steps: [] }) });
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
    async applyAppService(input) {
      calls.push(input);
      return { steps: ['built', 'started', 'healthy'] };
    },
  });
  const result = await core.apply(request);

  assert.equal(result.status, 'applied');
  assert.equal(result.publicUrl, 'http://example-tool.mos.home/');
  assert.equal(calls[0].packageId, 'example-tool');
  assert.equal(calls[0].loopbackPort, 18123);
  assert.equal(calls[0].healthTarget, 'http://127.0.0.1:18123/health');
  assert.deepEqual(calls[0].environment, { SERVER_HOST: 'http://example-tool.mos.home/' });
  assert.match(calls[0].caddyRoutes, /reverse_proxy http:\/\/127\.0\.0\.1:18123/u);
});

test('app apply rejects arbitrary packages, paths, routes, and commands', async () => {
  const core = new AppAgentCore({ applyAppService: async () => ({ steps: [] }) });
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

test('app remove accepts only a package id and delegates without volume deletion fields', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async removeAppService(input) {
      calls.push(input);
      return { steps: ['stopped', 'route-removed'] };
    },
  });

  const result = await core.remove({ packageId: 'example-tool' });

  assert.equal(result.status, 'removed');
  assert.deepEqual(calls, [{ packageId: 'example-tool' }]);
  await assert.rejects(() => core.remove({ packageId: 'example-tool', volumes: true }), AppRuntimeError);
  await assert.rejects(() => core.remove({ packageId: '../example-tool' }), AppRuntimeError);
});
