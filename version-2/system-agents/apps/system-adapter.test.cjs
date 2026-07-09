const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HEALTH_REFRESH_TIMEOUT_MS, SystemAppAdapter, removeAppRouteBlock, upsertAppRouteBlock } = require('./system-adapter.cjs');

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-v2-app-agent-'));
}

test('system adapter builds, runs, health-checks, writes routes, and reloads Caddy', async () => {
  const root = await tempDir();
  const routesPath = path.join(root, 'routes.caddy');
  const packageDir = path.join(root, 'example-tool');
  const commands = [];
  await fsp.mkdir(packageDir);

  const adapter = new SystemAppAdapter({
    appsRoot: root,
    caddyBinary: 'caddy',
    dockerBinary: 'docker',
    routesPath,
    async execute(file, args, options = {}) {
      commands.push({ args, cwd: options.cwd, file });
    },
    async waitForReady(url) {
      commands.push({ args: [url], file: 'health' });
    },
  });

  const result = await adapter.applyAppService({
    caddyRoutes: 'http://example-tool.mos.home {\n  reverse_proxy http://127.0.0.1:18123\n}\n',
    dockerfile: 'Dockerfile',
    healthTarget: 'http://127.0.0.1:18123/health',
    imageTag: 'mos-v2-app-example-tool:0.1.0',
    environment: { SERVER_HOST: 'http://example-tool.mos.home/' },
    internalPort: 3000,
    loopbackPort: 18123,
    packageId: 'example-tool',
    volumes: ['configs:/configs'],
  });

  assert.deepEqual(result.steps, ['built', 'started', 'healthy', 'route-written', 'caddy-reloaded']);
  assert.deepEqual(commands.map((command) => command.file), ['docker', 'docker', 'docker', 'health', 'caddy', '/usr/bin/systemctl']);
  assert.equal(commands[0].cwd, packageDir);
  assert.deepEqual(commands[2].args.slice(0, 8), ['run', '--detach', '--name', 'mos-v2-app-example-tool', '--restart', 'unless-stopped', '--publish', '127.0.0.1:18123:3000']);
  assert.ok(commands[2].args.includes('SERVER_HOST=http://example-tool.mos.home/'));
  assert.ok(commands[2].args.includes('mos-v2-app-example-tool-configs:/configs'));
  assert.match(await fsp.readFile(routesPath, 'utf8'), /mos-v2-app-route:start example-tool/u);
  assert.match(await fsp.readFile(routesPath, 'utf8'), /reverse_proxy http:\/\/127\.0\.0\.1:18123/u);
});

test('route updates replace only the matching package block', () => {
  const existing = `# mos-v2-app-route:start first-app
http://first-app.mos.home {
  reverse_proxy http://127.0.0.1:18101
}
# mos-v2-app-route:end first-app
`;

  const next = upsertAppRouteBlock(existing, {
    caddyRoutes: `http://second-app.mos.home {
  reverse_proxy http://127.0.0.1:18102
}
`,
    packageId: 'second-app',
  });

  assert.match(next, /mos-v2-app-route:start first-app/u);
  assert.match(next, /mos-v2-app-route:start second-app/u);
  assert.match(next, /127\.0\.0\.1:18101/u);
  assert.match(next, /127\.0\.0\.1:18102/u);
});

test('route removal deletes only the matching package block', () => {
  const existing = `# mos-v2-app-route:start first-app
http://first-app.mos.home {
  reverse_proxy http://127.0.0.1:18101
}
# mos-v2-app-route:end first-app

# mos-v2-app-route:start second-app
http://second-app.mos.home {
  reverse_proxy http://127.0.0.1:18102
}
# mos-v2-app-route:end second-app
`;

  const next = removeAppRouteBlock(existing, 'second-app');

  assert.match(next, /mos-v2-app-route:start first-app/u);
  assert.doesNotMatch(next, /mos-v2-app-route:start second-app/u);
  assert.match(next, /127\.0\.0\.1:18101/u);
  assert.doesNotMatch(next, /127\.0\.0\.1:18102/u);
});

test('system adapter removes runtime, app route, and app volumes on uninstall', async () => {
  const root = await tempDir();
  const routesPath = path.join(root, 'routes.caddy');
  const commands = [];
  await fsp.writeFile(routesPath, `# mos-v2-app-route:start first-app
http://first-app.mos.home {
  reverse_proxy http://127.0.0.1:18101
}
# mos-v2-app-route:end first-app

# mos-v2-app-route:start second-app
http://second-app.mos.home {
  reverse_proxy http://127.0.0.1:18102
}
# mos-v2-app-route:end second-app
`);

  const adapter = new SystemAppAdapter({
    caddyBinary: 'caddy',
    dockerBinary: 'docker',
    routesPath,
    async execute(file, args, options = {}) {
      commands.push({ args, cwd: options.cwd, file });
    },
  });

  const result = await adapter.removeAppService({ packageId: 'second-app', volumes: ['data', 'cache'] });

  assert.deepEqual(result.steps, ['stopped', 'volumes-removed', 'route-removed', 'caddy-reloaded']);
  assert.deepEqual(commands.map((command) => [command.file, command.args.slice(0, 3)]), [
    ['docker', ['rm', '-f', 'mos-v2-app-second-app']],
    ['docker', ['network', 'rm', 'mos-v2-app-second-app']],
    ['docker', ['volume', 'inspect', 'mos-v2-app-second-app-data']],
    ['docker', ['volume', 'rm', 'mos-v2-app-second-app-data']],
    ['docker', ['volume', 'inspect', 'mos-v2-app-second-app-cache']],
    ['docker', ['volume', 'rm', 'mos-v2-app-second-app-cache']],
    ['caddy', ['validate', '--adapter', 'caddyfile']],
    ['/usr/bin/systemctl', ['reload', 'caddy.service']],
  ]);
  assert.equal(commands.some((command) => command.args.includes('rmi')), false);
  const routes = await fsp.readFile(routesPath, 'utf8');
  assert.match(routes, /first-app/u);
  assert.doesNotMatch(routes, /second-app/u);
});

test('system adapter stops runtime without removing app routes or volumes', async () => {
  const root = await tempDir();
  const routesPath = path.join(root, 'routes.caddy');
  const commands = [];
  await fsp.writeFile(routesPath, `# mos-v2-app-route:start second-app
http://second-app.mos.home {
  reverse_proxy http://127.0.0.1:18102
}
# mos-v2-app-route:end second-app
`);

  const adapter = new SystemAppAdapter({
    dockerBinary: 'docker',
    routesPath,
    async execute(file, args) {
      commands.push({ args, file });
    },
  });

  const result = await adapter.stopAppService({ packageId: 'second-app', serviceIds: ['web'] });

  assert.deepEqual(result.steps, ['stopped']);
  assert.deepEqual(commands.map((command) => command.args), [
    ['rm', '-f', 'mos-v2-app-second-app'],
    ['rm', '-f', 'mos-v2-app-second-app-web'],
    ['network', 'rm', 'mos-v2-app-second-app'],
  ]);
  assert.equal(commands.some((command) => command.args.includes('volume') || command.args.includes('rmi')), false);
  assert.match(await fsp.readFile(routesPath, 'utf8'), /mos-v2-app-route:start second-app/u);
});

test('system adapter runs multi-service packages on a private package network', async () => {
  const root = await tempDir();
  const routesPath = path.join(root, 'routes.caddy');
  const packageDir = path.join(root, 'seafile');
  const commands = [];
  await fsp.mkdir(packageDir);

  const adapter = new SystemAppAdapter({
    appsRoot: root,
    caddyBinary: 'caddy',
    dockerBinary: 'docker',
    routesPath,
    async execute(file, args, options = {}) {
      commands.push({ args, cwd: options.cwd, file });
    },
    async waitForReady(url) {
      commands.push({ args: [url], file: 'health' });
    },
  });

  await adapter.applyAppServices({
    caddyRoutes: 'http://seafile.mos.home {\n  reverse_proxy http://127.0.0.1:18123\n}\n',
    healthTarget: 'http://127.0.0.1:18123/api2/ping/',
    packageId: 'seafile',
    services: [
      {
        dockerfile: 'Dockerfile.mysql',
        environment: { MYSQL_ROOT_PASSWORD: 'root-secret' },
        id: 'seafile-mysql',
        imageTag: 'mos-v2-app-seafile-seafile-mysql:0.1.0',
        internalPort: 3306,
        loopbackPort: 18124,
        public: false,
        volumes: ['mysql-data:/var/lib/mysql'],
      },
      {
        dockerfile: 'Dockerfile',
        environment: { SEAFILE_SERVER_HOSTNAME: 'seafile.mos.home' },
        id: 'seafile',
        imageTag: 'mos-v2-app-seafile-seafile:0.1.0',
        internalPort: 80,
        loopbackPort: 18123,
        public: true,
        volumes: ['data:/shared'],
      },
    ],
  });

  const dockerRuns = commands.filter((command) => command.file === 'docker' && command.args[0] === 'run');
  assert.equal(commands.some((command) => command.file === 'docker' && command.args.join(' ') === 'network create mos-v2-app-seafile'), true);
  assert.equal(dockerRuns.length, 2);
  assert.ok(dockerRuns[0].args.includes('--network-alias'));
  assert.equal(dockerRuns[0].args.includes('--publish'), false);
  assert.ok(dockerRuns[1].args.includes('127.0.0.1:18123:80'));
  assert.ok(dockerRuns[1].args.includes('mos-v2-app-seafile-data:/shared'));
});

test('system adapter checks app health with a short refresh budget', async () => {
  const calls = [];
  const adapter = new SystemAppAdapter({
    async waitForReady(url, options) {
      calls.push({ options, url });
    },
  });

  const result = await adapter.checkAppHealth({ healthTarget: 'http://127.0.0.1:18123/health' });

  assert.equal(result.status, 'healthy');
  assert.deepEqual(calls, [{
    options: { deadlineMs: HEALTH_REFRESH_TIMEOUT_MS },
    url: 'http://127.0.0.1:18123/health',
  }]);
});

test('system adapter connects a provider container to a consumer package network', async () => {
  const commands = [];
  const adapter = new SystemAppAdapter({
    dockerBinary: 'docker',
    async execute(file, args) {
      commands.push({ args, file });
      if (args[0] === 'network' && args[1] === 'disconnect') {
        throw new Error('not connected yet');
      }
    },
  });

  const result = await adapter.connectPackageNetwork({
    consumerPackageId: 'seafile',
    providerPackageId: 'onlyoffice',
    providerServiceCount: 1,
    providerServices: ['onlyoffice'],
  });

  assert.deepEqual(result.steps, ['network-connected']);
  assert.deepEqual(commands.map((command) => command.args), [
    ['network', 'inspect', 'mos-v2-app-seafile'],
    ['network', 'disconnect', 'mos-v2-app-seafile', 'mos-v2-app-onlyoffice'],
    ['network', 'connect', '--alias', 'onlyoffice', 'mos-v2-app-seafile', 'mos-v2-app-onlyoffice'],
  ]);
});
