const assert = require('node:assert/strict');
const test = require('node:test');

const { AppAgentCore, AppRuntimeError, renderAppRoutes } = require('./agent-core.cjs');

const request = {
  appHost: 'example-tool.mos.home',
  caddy: { routes: [{ host: 'example-tool', reverseProxy: '127.0.0.1:18123', service: 'web' }] },
  compose: {
    services: [{
      build: { context: 'apps/example-tool', dockerfile: 'Dockerfile' },
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
  packageDigest: `sha256:${'a'.repeat(64)}`,
  packageId: 'example-tool',
  packageVersion: '0.1.0',
  publicUrl: 'http://example-tool.mos.home/',
  sourceRevision: '0123456789abcdef0123456789abcdef01234567',
};

test('app agent exposes only narrow app runtime capabilities', async () => {
  const core = new AppAgentCore({ applyAppServices: async () => ({ steps: [] }), checkAppHealth: async () => ({}) });
  const status = await core.status();
  assert.deepEqual(status.capabilities, ['apps.multi-service.apply', 'apps.health.check', 'apps.multi-service.stop', 'apps.multi-service.remove', 'apps.network.connect', 'apps.package.snapshot', 'apps.package.snapshot.external', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote', 'apps.package.update.reclaim', 'apps.package.remove.reclaim']);
  assert.equal(status.contractVersion, 9);
});

// The agent runs on the host and is what invokes `docker build`, so it answers
// for the host rather than letting Suite Manager infer one from its own
// container. A host it has no name for is reported as unknown, never guessed.
test('app agent answers for the architecture of the host it builds on', async () => {
  const status = await new AppAgentCore({}).status();
  assert.equal(status.hostArchitecture, { arm64: 'arm64', x64: 'amd64' }[process.arch] || null);
  assert.ok(status.hostArchitecture === null || ['amd64', 'arm64'].includes(status.hostArchitecture));
});

test('app update promotion accepts only digest-bound snapshot identity', async () => {
  const calls = [];
  const core = new AppAgentCore({ async promoteAppPackageUpdate(input) { calls.push(input); return { snapshotPath: '/state/installed' }; } });
  const input = { candidateDigest: `sha256:${'b'.repeat(64)}`, expectedInstalledDigest: request.packageDigest, instanceId: request.instanceId, packageId: request.packageId, rollbackSafe: true };
  assert.equal((await core.promotePackageUpdate(input)).status, 'snapshot-promoted');
  assert.deepEqual(calls, [input]);
  await assert.rejects(() => core.promotePackageUpdate({ ...input, rollbackSafe: 'yes' }), AppRuntimeError);
  await assert.rejects(() => core.promotePackageUpdate({ ...input, path: '/tmp/app' }), AppRuntimeError);
});

test('app update promotion takes the outgoing source revision that names its superseded images', async () => {
  const calls = [];
  const core = new AppAgentCore({ async promoteAppPackageUpdate(input) { calls.push(input); return { snapshotPath: '/state/installed' }; } });
  const input = { candidateDigest: `sha256:${'b'.repeat(64)}`, expectedInstalledDigest: request.packageDigest, installedSourceRevision: 'c'.repeat(40), instanceId: request.instanceId, packageId: request.packageId, rollbackSafe: false };
  assert.equal((await core.promotePackageUpdate(input)).status, 'snapshot-promoted');
  assert.deepEqual(calls, [input]);
  // A revision is what the tag is derived from, so a value that is not one has
  // to be refused rather than turned into a tag that matches nothing.
  await assert.rejects(() => core.promotePackageUpdate({ ...input, installedSourceRevision: 'HEAD' }), AppRuntimeError);
  await assert.rejects(() => core.promotePackageUpdate({ ...input, installedSourceRevision: '' }), AppRuntimeError);
});

test('a promotion from a Suite Manager that cannot name superseded images still succeeds', async () => {
  const core = new AppAgentCore({ async promoteAppPackageUpdate() { return { snapshotPath: '/state/installed' }; } });
  // Refusing here would strand an update whose candidate is already serving
  // traffic, so the older request shape stays acceptable and reclaims nothing.
  const promoted = await core.promotePackageUpdate({ candidateDigest: `sha256:${'b'.repeat(64)}`, expectedInstalledDigest: request.packageDigest, instanceId: request.instanceId, packageId: request.packageId, rollbackSafe: false });
  assert.equal(promoted.status, 'snapshot-promoted');
});

test('app update activation binds candidate and installed runtime identities', async () => {
  const calls = [];
  const core = new AppAgentCore({ async activateAppPackageUpdate(input) { calls.push(input); return { steps: ['candidate-healthy'] }; } });
  const candidate = { ...request, expectedInstalledDigest: request.packageDigest, packageDigest: `sha256:${'b'.repeat(64)}`, packageVersion: '0.2.0', sourceRevision: 'b'.repeat(40) };
  const result = await core.activatePackageUpdate({ candidate, installed: request });
  assert.equal(result.status, 'candidate-healthy');
  assert.equal(calls[0].candidate.packageDigest, candidate.packageDigest);
  assert.equal(calls[0].installed.packageDigest, request.packageDigest);
  await assert.rejects(() => core.activatePackageUpdate({ candidate: { ...candidate, expectedInstalledDigest: `sha256:${'c'.repeat(64)}` }, installed: request }), AppRuntimeError);
  await assert.rejects(() => core.activatePackageUpdate({ candidate, installed: request, path: '/tmp/app' }), AppRuntimeError);
});

test('app update rollback restores only the identity-bound installed runtime', async () => {
  const calls = [];
  const core = new AppAgentCore({ async rollbackAppPackageUpdate(input) { calls.push(input); return { steps: ['installed-runtime-healthy'] }; } });
  const candidate = { ...request, expectedInstalledDigest: request.packageDigest, packageDigest: `sha256:${'b'.repeat(64)}`, packageVersion: '0.2.0', sourceRevision: 'b'.repeat(40) };
  const result = await core.rollbackPackageUpdate({ candidate, installed: request });
  assert.equal(result.status, 'installed-restored');
  assert.equal(calls[0].candidate.packageDigest, candidate.packageDigest);
  assert.equal(calls[0].installed.packageDigest, request.packageDigest);
  await assert.rejects(() => core.rollbackPackageUpdate({ candidate: { ...candidate, expectedInstalledDigest: `sha256:${'c'.repeat(64)}` }, installed: request }), AppRuntimeError);
});

test('app update build uses a validated candidate runtime without applying it', async () => {
  const calls = [];
  const core = new AppAgentCore({ async buildAppPackageUpdate(input) { calls.push(input); return { steps: ['candidate-built'] }; } });
  const result = await core.buildPackageUpdate({ ...request, expectedInstalledDigest: `sha256:${'c'.repeat(64)}` });
  assert.equal(result.status, 'built');
  assert.equal(calls[0].candidateDigest, request.packageDigest);
  assert.equal(calls[0].expectedInstalledDigest, `sha256:${'c'.repeat(64)}`);
  await assert.rejects(() => core.buildPackageUpdate(request), AppRuntimeError);
  await assert.rejects(() => core.apply({ ...request, expectedInstalledDigest: `sha256:${'c'.repeat(64)}` }), AppRuntimeError);
});

test('app update staging binds candidate and installed identities', async () => {
  const calls = [];
  const core = new AppAgentCore({ async stageAppPackageUpdate(input) { calls.push(input); return { snapshotPath: '/state/candidate', steps: ['staged'] }; } });
  const input = {
    candidateDigest: `sha256:${'b'.repeat(64)}`,
    candidatePath: '/var/lib/mos/suite-manager/app-candidates/example-123',
    expectedInstalledDigest: request.packageDigest,
    instanceId: request.instanceId,
    packageId: request.packageId,
  };
  assert.equal((await core.stagePackageUpdate(input)).status, 'staged');
  assert.deepEqual(calls, [input]);
  await assert.rejects(() => core.stagePackageUpdate({ ...input, unexpected: true }), AppRuntimeError);
  await assert.rejects(() => core.stagePackageUpdate({ ...input, candidateDigest: 'latest' }), AppRuntimeError);
});

test('app package snapshot accepts only identity and expected digest', async () => {
  const calls = [];
  const core = new AppAgentCore({ async snapshotAppPackage(input) { calls.push(input); return { snapshotPath: '/state/installed', steps: ['promoted'] }; } });
  const input = { instanceId: request.instanceId, packageDigest: `sha256:${'a'.repeat(64)}`, packageId: request.packageId };
  const result = await core.snapshotPackage(input);
  assert.equal(result.status, 'snapshotted');
  assert.deepEqual(calls, [input]);
  await assert.rejects(() => core.snapshotPackage({ ...input, sourcePath: '/tmp/escape' }), AppRuntimeError);
  await assert.rejects(() => core.snapshotPackage({ ...input, instanceId: '../escape' }), AppRuntimeError);
});

test('external app package snapshot accepts only identity, expected digest, and a candidate path', async () => {
  const calls = [];
  const core = new AppAgentCore({ async snapshotExternalAppPackage(input) { calls.push(input); return { snapshotPath: '/state/installed', steps: ['promoted'] }; } });
  const input = {
    candidateDigest: `sha256:${'a'.repeat(64)}`,
    candidatePath: '/state/app-candidates/ext-abc',
    instanceId: request.instanceId,
    packageId: 'x-abcdef01-community-notes',
  };
  const result = await core.snapshotExternalPackage(input);
  assert.equal(result.status, 'snapshotted');
  assert.equal(result.packageDigest, input.candidateDigest);
  assert.deepEqual(calls, [input]);
  await assert.rejects(() => core.snapshotExternalPackage({ ...input, packageDigest: `sha256:${'b'.repeat(64)}` }), AppRuntimeError);
  await assert.rejects(() => core.snapshotExternalPackage({ ...input, candidateDigest: 'latest' }), AppRuntimeError);
  await assert.rejects(() => core.snapshotExternalPackage({ ...input, instanceId: '../escape' }), AppRuntimeError);
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
      path: '/__mos/ical/token-value',
      targetPath: '/calendar-admin/default-calendar/?export',
    },
    reverseProxy: '127.0.0.1:18124',
  });

  assert.match(routes, /handle \/__mos\/ical\/token-value/u);
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
          path: '/__mos/ical/token-value',
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
  assert.equal(calls[0].packageVersion, '0.1.0');
  assert.equal(calls[0].sourceRevision, request.sourceRevision);
  assert.equal(calls[0].services[0].imageTag, `mos-app-example-tool-web:0.1.0-pkg-${'a'.repeat(12)}-src-0123456789ab`);
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
          build: { context: 'apps/example-tool', dockerfile: 'Dockerfile.mysql' },
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

test('app remove takes the instance and revision that name what an uninstall leaves behind', async () => {
  const calls = [];
  const core = new AppAgentCore({
    async removeAppService(input) {
      calls.push(input);
      return { imagesReclaimed: 2, steps: ['stopped', 'images-reclaimed', 'snapshot-removed'] };
    },
  });

  const result = await core.remove({
    installedSourceRevision: request.sourceRevision,
    instanceId: request.instanceId,
    packageId: 'example-tool',
    services: ['web'],
    volumes: ['data'],
  });

  assert.equal(result.status, 'removed');
  assert.equal(result.imagesReclaimed, 2);
  assert.deepEqual(calls[0], {
    installedSourceRevision: request.sourceRevision,
    instanceId: request.instanceId,
    packageId: 'example-tool',
    serviceIds: ['web'],
    volumes: ['data'],
  });
  await assert.rejects(() => core.remove({ instanceId: 'not-a-uuid', packageId: 'example-tool' }), AppRuntimeError);
  await assert.rejects(() => core.remove({ installedSourceRevision: 'HEAD', instanceId: request.instanceId, packageId: 'example-tool' }), AppRuntimeError);
  await assert.rejects(() => core.remove({ instanceId: request.instanceId, packageId: 'example-tool', unexpected: 'x' }), AppRuntimeError);
});

// A stop is reversible and an uninstall is not, so the fields that discard a
// snapshot must not be reachable through the one that only halts a runtime.
test('app stop cannot name an instance snapshot to discard', async () => {
  const core = new AppAgentCore({ async stopAppService() { return { steps: ['stopped'] }; } });

  await assert.rejects(() => core.stop({ instanceId: request.instanceId, packageId: 'example-tool' }), AppRuntimeError);
  await assert.rejects(() => core.stop({ installedSourceRevision: request.sourceRevision, packageId: 'example-tool' }), AppRuntimeError);
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
