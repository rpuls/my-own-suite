const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HEALTH_REFRESH_TIMEOUT_MS, SystemAppAdapter, upsertAppRouteBlock } = require('./system-adapter.cjs');

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
