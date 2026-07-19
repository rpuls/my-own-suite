const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { digestAppPackage } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');

const { DISPLACED_INSTALLED_DIR, HEALTH_REFRESH_TIMEOUT_MS, SystemAppAdapter, removeAppRouteBlock, upsertAppRouteBlock } = require('./system-adapter.cjs');

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-app-agent-'));
}

async function writePackage(root, packageId = 'example-tool') {
  const packageDir = path.join(root, packageId);
  await fsp.mkdir(packageDir, { recursive: true });
  await fsp.writeFile(path.join(packageDir, 'manifest.json'), `${JSON.stringify({ id: packageId, packageFiles: [] })}\n`);
  await fsp.writeFile(path.join(packageDir, 'Dockerfile'), 'FROM scratch\n');
  return { packageDir, packageDigest: digestAppPackage(packageDir) };
}

test('system adapter atomically snapshots only validated package files', async () => {
  const root = await tempDir();
  const appsRoot = path.join(root, 'apps');
  const appPackageRoot = path.join(root, 'state');
  const { packageDigest } = await writePackage(appsRoot);
  const adapter = new SystemAppAdapter({ appPackageRoot, appsRoot });
  const instanceId = '12345678-1234-4123-8123-123456789abc';

  const result = await adapter.snapshotAppPackage({ instanceId, packageDigest, packageId: 'example-tool' });

  assert.deepEqual(result.steps, ['validated', 'copied', 'verified', 'promoted']);
  assert.equal(result.snapshotPath, path.join(appPackageRoot, instanceId, 'installed'));
  assert.equal(digestAppPackage(result.snapshotPath), packageDigest);
  assert.deepEqual((await fsp.readdir(path.join(appPackageRoot, instanceId))).sort(), ['installed']);
});

// Suite Manager runs as a different user than this root agent and reads the
// snapshot to re-verify it, so it reaches these files only through the package
// root's group. A same-user test cannot see that boundary: every file it writes
// is already its own. Standing the root up under a group the test process has
// but does not create files with by default reproduces it without root.
const secondaryGid = typeof process.getgroups === 'function'
  ? process.getgroups().find((gid) => gid !== process.getgid())
  : undefined;

test('system adapter gives snapshots the package root group so Suite Manager can read them', {
  skip: secondaryGid === undefined ? 'needs a POSIX host where the test user has a secondary group' : false,
}, async () => {
  const root = await tempDir();
  const appsRoot = path.join(root, 'apps');
  const appPackageRoot = path.join(root, 'state');
  const { packageDigest } = await writePackage(appsRoot);
  await fsp.mkdir(appPackageRoot, { recursive: true });
  await fsp.chown(appPackageRoot, process.getuid(), secondaryGid);
  const adapter = new SystemAppAdapter({ appPackageRoot, appsRoot });
  const instanceId = '12345678-1234-4123-8123-123456789abc';

  const result = await adapter.snapshotAppPackage({ instanceId, packageDigest, packageId: 'example-tool' });

  // The instance root too: a readable snapshot under an unreachable parent is
  // still unreadable.
  const instanceRoot = path.join(appPackageRoot, instanceId);
  for (const entry of [instanceRoot, result.snapshotPath, path.join(result.snapshotPath, 'manifest.json'), path.join(result.snapshotPath, 'Dockerfile')]) {
    const stats = await fsp.stat(entry);
    assert.equal(stats.gid, secondaryGid, `${path.relative(appPackageRoot, entry)} must carry the package root group`);
    assert.equal(Boolean(stats.mode & 0o040), true, `${path.relative(appPackageRoot, entry)} must stay group readable`);
    assert.equal(Boolean(stats.mode & 0o020), false, `${path.relative(appPackageRoot, entry)} must not be group writable`);
  }
});

test('system adapter leaves no snapshot after digest or package validation failure', async () => {
  const root = await tempDir();
  const appsRoot = path.join(root, 'apps');
  const appPackageRoot = path.join(root, 'state');
  await writePackage(appsRoot);
  const adapter = new SystemAppAdapter({ appPackageRoot, appsRoot });
  const instanceId = '12345678-1234-4123-8123-123456789abc';

  await assert.rejects(() => adapter.snapshotAppPackage({ instanceId, packageDigest: `sha256:${'0'.repeat(64)}`, packageId: 'example-tool' }), /validated app package could not be snapshotted/u);
  assert.equal(fs.existsSync(path.join(appPackageRoot, instanceId, 'installed')), false);
  await fsp.writeFile(path.join(appsRoot, 'example-tool', 'undeclared.bin'), 'escape');
  await assert.rejects(() => adapter.snapshotAppPackage({ instanceId, packageDigest: `sha256:${'0'.repeat(64)}`, packageId: 'example-tool' }), /validated app package could not be snapshotted/u);
  assert.equal(fs.existsSync(path.join(appPackageRoot, instanceId, 'installed')), false);
});

test('system adapter never replaces an existing installed snapshot', async () => {
  const root = await tempDir();
  const appsRoot = path.join(root, 'apps');
  const appPackageRoot = path.join(root, 'state');
  const { packageDigest } = await writePackage(appsRoot);
  const adapter = new SystemAppAdapter({ appPackageRoot, appsRoot });
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const installed = path.join(appPackageRoot, instanceId, 'installed');
  await fsp.mkdir(installed, { recursive: true });
  await fsp.writeFile(path.join(installed, 'sentinel'), 'keep');

  await assert.rejects(() => adapter.snapshotAppPackage({ instanceId, packageDigest, packageId: 'example-tool' }), /validated app package could not be snapshotted/u);
  assert.equal(await fsp.readFile(path.join(installed, 'sentinel'), 'utf8'), 'keep');
});

test('system adapter snapshots an external candidate under its namespaced identity', async () => {
  const root = await tempDir();
  const candidateRoot = path.join(root, 'candidates');
  const appPackageRoot = path.join(root, 'state');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { packageDir: candidatePath, packageDigest: candidateDigest } = await writePackage(candidateRoot, 'community-notes');
  const adapter = new SystemAppAdapter({ appCandidateRoot: candidateRoot, appPackageRoot, appsRoot: path.join(root, 'apps') });

  const result = await adapter.snapshotExternalAppPackage({ candidateDigest, candidatePath, instanceId, packageId: 'x-abcdef01-community-notes' });

  assert.deepEqual(result.steps, ['candidate-confined', 'identity-verified', 'validated', 'copied', 'verified', 'promoted']);
  assert.equal(result.snapshotPath, path.join(appPackageRoot, instanceId, 'installed'));
  assert.equal(digestAppPackage(result.snapshotPath), candidateDigest);
});

test('system adapter refuses an external snapshot outside its candidate root, with a changed digest, or over an existing snapshot', async () => {
  const root = await tempDir();
  const candidateRoot = path.join(root, 'candidates');
  const appPackageRoot = path.join(root, 'state');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { packageDir: candidatePath, packageDigest: candidateDigest } = await writePackage(candidateRoot, 'community-notes');
  const { packageDir: outsidePath, packageDigest: outsideDigest } = await writePackage(path.join(root, 'elsewhere'), 'community-notes');
  const adapter = new SystemAppAdapter({ appCandidateRoot: candidateRoot, appPackageRoot, appsRoot: path.join(root, 'apps') });
  const packageId = 'x-abcdef01-community-notes';

  await assert.rejects(
    () => adapter.snapshotExternalAppPackage({ candidateDigest: outsideDigest, candidatePath: outsidePath, instanceId, packageId }),
    /validated app package could not be snapshotted/u,
  );
  await assert.rejects(
    () => adapter.snapshotExternalAppPackage({ candidateDigest: `sha256:${'0'.repeat(64)}`, candidatePath, instanceId, packageId }),
    /validated app package could not be snapshotted/u,
  );
  assert.equal(fs.existsSync(path.join(appPackageRoot, instanceId, 'installed')), false);

  await adapter.snapshotExternalAppPackage({ candidateDigest, candidatePath, instanceId, packageId });
  await assert.rejects(
    () => adapter.snapshotExternalAppPackage({ candidateDigest, candidatePath, instanceId, packageId }),
    /validated app package could not be snapshotted/u,
  );
});

// The agent enforces namespacing itself: every container, volume, network, and
// route name derives from this package id, so an external package that could be
// snapshotted under a bare id would occupy an official app's runtime identity.
test('system adapter refuses to snapshot an external candidate under a bare or mismatched package id', async () => {
  const root = await tempDir();
  const candidateRoot = path.join(root, 'candidates');
  const appPackageRoot = path.join(root, 'state');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { packageDir: candidatePath, packageDigest: candidateDigest } = await writePackage(candidateRoot, 'immich');
  const adapter = new SystemAppAdapter({ appCandidateRoot: candidateRoot, appPackageRoot, appsRoot: path.join(root, 'apps') });

  await assert.rejects(
    () => adapter.snapshotExternalAppPackage({ candidateDigest, candidatePath, instanceId, packageId: 'immich' }),
    /validated app package could not be snapshotted/u,
  );
  await assert.rejects(
    () => adapter.snapshotExternalAppPackage({ candidateDigest, candidatePath, instanceId, packageId: 'x-abcdef01-community-notes' }),
    /validated app package could not be snapshotted/u,
  );
  assert.equal(fs.existsSync(path.join(appPackageRoot, instanceId, 'installed')), false);
});

test('system adapter stages a verified update without changing installed files', async () => {
  const root = await tempDir();
  const appsRoot = path.join(root, 'apps');
  const candidateRoot = path.join(root, 'candidates');
  const appPackageRoot = path.join(root, 'state');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { packageDigest: installedDigest } = await writePackage(appsRoot);
  const installed = path.join(appPackageRoot, instanceId, 'installed');
  await fsp.mkdir(path.dirname(installed), { recursive: true });
  await fsp.cp(path.join(appsRoot, 'example-tool'), installed, { recursive: true });
  const { packageDir: candidatePath } = await writePackage(candidateRoot);
  await fsp.writeFile(path.join(candidatePath, 'Dockerfile'), 'FROM scratch\n# updated\n');
  const candidateDigest = digestAppPackage(candidatePath);
  const adapter = new SystemAppAdapter({ appCandidateRoot: candidateRoot, appPackageRoot, appsRoot });

  const result = await adapter.stageAppPackageUpdate({ candidateDigest, candidatePath, expectedInstalledDigest: installedDigest, instanceId, packageId: 'example-tool' });

  assert.equal(result.snapshotPath, path.join(appPackageRoot, instanceId, 'candidate'));
  assert.equal(digestAppPackage(result.snapshotPath), candidateDigest);
  assert.equal(digestAppPackage(installed), installedDigest);
});

test('system adapter rejects stale identities and candidate paths outside its private root', async () => {
  const root = await tempDir();
  const appsRoot = path.join(root, 'apps');
  const candidateRoot = path.join(root, 'candidates');
  const appPackageRoot = path.join(root, 'state');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { packageDir, packageDigest } = await writePackage(appsRoot);
  const installed = path.join(appPackageRoot, instanceId, 'installed');
  await fsp.mkdir(path.dirname(installed), { recursive: true });
  await fsp.cp(packageDir, installed, { recursive: true });
  const { packageDir: candidatePath, packageDigest: candidateDigest } = await writePackage(candidateRoot);
  const adapter = new SystemAppAdapter({ appCandidateRoot: candidateRoot, appPackageRoot, appsRoot });

  await assert.rejects(() => adapter.stageAppPackageUpdate({ candidateDigest, candidatePath, expectedInstalledDigest: `sha256:${'0'.repeat(64)}`, instanceId, packageId: 'example-tool' }), (error) => error.code === 'APP_UPDATE_IDENTITY_CHANGED');
  await assert.rejects(() => adapter.stageAppPackageUpdate({ candidateDigest: packageDigest, candidatePath: packageDir, expectedInstalledDigest: packageDigest, instanceId, packageId: 'example-tool' }), (error) => error.details.includes('CANDIDATE_PATH_OUTSIDE_ROOT'));
  assert.equal(fs.existsSync(path.join(appPackageRoot, instanceId, 'candidate')), false);
});

// An external app is managed under `x-<namespace>-<manifest id>` while its
// package keeps declaring the bare id, so its update stages under the namespaced
// identity. The agent still resolves that identity to exactly one manifest id, so
// a package can never be staged into an app identity that is not its own.
test('system adapter stages an external app update under its namespaced identity and refuses a foreign one', async () => {
  const root = await tempDir();
  const candidateRoot = path.join(root, 'candidates');
  const appPackageRoot = path.join(root, 'state');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const packageId = 'x-abcdef01-community-notes';
  const { packageDir: installedSource, packageDigest: installedDigest } = await writePackage(path.join(root, 'origin'), 'community-notes');
  const installed = path.join(appPackageRoot, instanceId, 'installed');
  await fsp.mkdir(path.dirname(installed), { recursive: true });
  await fsp.cp(installedSource, installed, { recursive: true });
  const { packageDir: candidatePath } = await writePackage(candidateRoot, 'community-notes');
  await fsp.writeFile(path.join(candidatePath, 'Dockerfile'), 'FROM scratch\n# updated\n');
  const candidateDigest = digestAppPackage(candidatePath);
  const adapter = new SystemAppAdapter({ appCandidateRoot: candidateRoot, appPackageRoot, appsRoot: path.join(root, 'apps') });

  const result = await adapter.stageAppPackageUpdate({ candidateDigest, candidatePath, expectedInstalledDigest: installedDigest, instanceId, packageId });

  assert.equal(result.snapshotPath, path.join(appPackageRoot, instanceId, 'candidate'));
  assert.equal(digestAppPackage(result.snapshotPath), candidateDigest);
  assert.equal(digestAppPackage(installed), installedDigest);

  for (const foreignId of ['community-notes-editor', 'x-abcdef01-other-notes']) {
    await assert.rejects(
      () => adapter.stageAppPackageUpdate({ candidateDigest, candidatePath, expectedInstalledDigest: installedDigest, instanceId, packageId: foreignId }),
      (error) => error.code === 'APP_UPDATE_IDENTITY_CHANGED',
    );
  }
});

test('system adapter builds, runs, health-checks, writes routes, and reloads Caddy', async () => {
  const root = await tempDir();
  const routesPath = path.join(root, 'routes.caddy');
  const appPackageRoot = path.join(root, 'packages');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const packageDir = path.join(appPackageRoot, instanceId, 'installed');
  const commands = [];
  await fsp.mkdir(packageDir, { recursive: true });
  await fsp.writeFile(path.join(packageDir, 'manifest.json'), `${JSON.stringify({ id: 'example-tool', packageFiles: [] })}\n`);
  await fsp.writeFile(path.join(packageDir, 'Dockerfile'), 'FROM scratch\n');
  const packageDigest = digestAppPackage(packageDir);

  const adapter = new SystemAppAdapter({
    appsRoot: root,
    appPackageRoot,
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
    imageTag: 'mos-app-example-tool:0.1.0',
    instanceId,
    environment: { SERVER_HOST: 'http://example-tool.mos.home/' },
    internalPort: 3000,
    loopbackPort: 18123,
    packageDigest,
    packageId: 'example-tool',
    packageVersion: '0.1.0',
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    volumes: ['configs:/configs'],
  });

  assert.deepEqual(result.steps, ['built', 'started', 'healthy', 'route-written', 'caddy-reloaded']);
  // build, container rm, labeled volume create, run.
  assert.deepEqual(commands.map((command) => command.file), ['docker', 'docker', 'docker', 'docker', 'health', 'caddy', '/usr/bin/systemctl']);
  assert.equal(commands[0].cwd, packageDir);
  assert.ok(commands[0].args.includes('mos.package-version=0.1.0'));
  assert.ok(commands[0].args.includes(`mos.package-digest=${packageDigest}`));
  assert.ok(commands[0].args.includes('mos.source-revision=0123456789abcdef0123456789abcdef01234567'));
  assert.deepEqual(commands[2].args.slice(0, 2), ['volume', 'create']);
  assert.equal(commands[2].args.at(-1), 'mos-app-example-tool-configs');
  assert.ok(commands[2].args.includes('mos.owned=true'));
  assert.ok(commands[2].args.includes(`mos.instance=${instanceId}`));
  assert.deepEqual(commands[3].args.slice(0, 8), ['run', '--detach', '--name', 'mos-app-example-tool', '--restart', 'unless-stopped', '--publish', '127.0.0.1:18123:3000']);
  assert.ok(commands[3].args.includes('SERVER_HOST=http://example-tool.mos.home/'));
  assert.ok(commands[3].args.includes('mos.package-version=0.1.0'));
  assert.ok(commands[3].args.includes(`mos.package-digest=${packageDigest}`));
  assert.ok(commands[3].args.includes('mos.source-revision=0123456789abcdef0123456789abcdef01234567'));
  assert.ok(commands[3].args.includes('mos-app-example-tool-configs:/configs'));
  assert.match(await fsp.readFile(routesPath, 'utf8'), /mos-app-route:start example-tool/u);
  assert.match(await fsp.readFile(routesPath, 'utf8'), /reverse_proxy http:\/\/127\.0\.0\.1:18123/u);
});

// Regression: applyAppServices compared the bare manifest id to the namespaced
// package id, so every external install/enable/restart failed with
// PACKAGE_SNAPSHOT_MISMATCH after its snapshot had already been accepted.
test('system adapter applies runtime for an external app under its namespaced identity', async () => {
  const root = await tempDir();
  const routesPath = path.join(root, 'routes.caddy');
  const appPackageRoot = path.join(root, 'packages');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const packageId = 'x-abcdef01-community-notes';
  const packageDir = path.join(appPackageRoot, instanceId, 'installed');
  const commands = [];
  await fsp.mkdir(packageDir, { recursive: true });
  await fsp.writeFile(path.join(packageDir, 'manifest.json'), `${JSON.stringify({ id: 'community-notes', packageFiles: [] })}\n`);
  await fsp.writeFile(path.join(packageDir, 'Dockerfile'), 'FROM scratch\n');
  const packageDigest = digestAppPackage(packageDir);

  const adapter = new SystemAppAdapter({
    appsRoot: root,
    appPackageRoot,
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

  const request = {
    caddyRoutes: `http://community-notes.mos.home {\n  reverse_proxy http://127.0.0.1:18124\n}\n`,
    dockerfile: 'Dockerfile',
    environment: {},
    healthTarget: 'http://127.0.0.1:18124/health',
    imageTag: `mos-app-${packageId}:0.1.0`,
    instanceId,
    internalPort: 3000,
    loopbackPort: 18124,
    packageDigest,
    packageId,
    packageVersion: '0.1.0',
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    volumes: [],
  };
  const result = await adapter.applyAppService(request);

  assert.deepEqual(result.steps, ['built', 'started', 'healthy', 'route-written', 'caddy-reloaded']);
  assert.deepEqual(commands[2].args.slice(0, 4), ['run', '--detach', '--name', `mos-app-${packageId}`]);
  assert.match(await fsp.readFile(routesPath, 'utf8'), new RegExp(`mos-app-route:start ${packageId}`, 'u'));

  // The identity check still refuses a snapshot that is not the package the
  // namespaced id claims to manage.
  await assert.rejects(
    () => adapter.applyAppService({ ...request, packageId: 'x-abcdef01-other-notes' }),
    (error) => error.code === 'APP_BUILD_FAILED',
  );
});

test('route updates replace only the matching package block', () => {
  const existing = `# mos-app-route:start first-app
http://first-app.mos.home {
  reverse_proxy http://127.0.0.1:18101
}
# mos-app-route:end first-app
`;

  const next = upsertAppRouteBlock(existing, {
    caddyRoutes: `http://second-app.mos.home {
  reverse_proxy http://127.0.0.1:18102
}
`,
    packageId: 'second-app',
  });

  assert.match(next, /mos-app-route:start first-app/u);
  assert.match(next, /mos-app-route:start second-app/u);
  assert.match(next, /127\.0\.0\.1:18101/u);
  assert.match(next, /127\.0\.0\.1:18102/u);
});

test('route removal deletes only the matching package block', () => {
  const existing = `# mos-app-route:start first-app
http://first-app.mos.home {
  reverse_proxy http://127.0.0.1:18101
}
# mos-app-route:end first-app

# mos-app-route:start second-app
http://second-app.mos.home {
  reverse_proxy http://127.0.0.1:18102
}
# mos-app-route:end second-app
`;

  const next = removeAppRouteBlock(existing, 'second-app');

  assert.match(next, /mos-app-route:start first-app/u);
  assert.doesNotMatch(next, /mos-app-route:start second-app/u);
  assert.match(next, /127\.0\.0\.1:18101/u);
  assert.doesNotMatch(next, /127\.0\.0\.1:18102/u);
});

test('system adapter removes runtime, app route, and app volumes on uninstall', async () => {
  const root = await tempDir();
  const routesPath = path.join(root, 'routes.caddy');
  const commands = [];
  await fsp.writeFile(routesPath, `# mos-app-route:start first-app
http://first-app.mos.home {
  reverse_proxy http://127.0.0.1:18101
}
# mos-app-route:end first-app

# mos-app-route:start second-app
http://second-app.mos.home {
  reverse_proxy http://127.0.0.1:18102
}
# mos-app-route:end second-app
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
    ['docker', ['rm', '-f', 'mos-app-second-app']],
    ['docker', ['network', 'rm', 'mos-app-second-app']],
    ['docker', ['volume', 'inspect', 'mos-app-second-app-data']],
    ['docker', ['volume', 'rm', 'mos-app-second-app-data']],
    ['docker', ['volume', 'inspect', 'mos-app-second-app-cache']],
    ['docker', ['volume', 'rm', 'mos-app-second-app-cache']],
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
  await fsp.writeFile(routesPath, `# mos-app-route:start second-app
http://second-app.mos.home {
  reverse_proxy http://127.0.0.1:18102
}
# mos-app-route:end second-app
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
    ['rm', '-f', 'mos-app-second-app'],
    ['rm', '-f', 'mos-app-second-app-web'],
    ['network', 'rm', 'mos-app-second-app'],
  ]);
  assert.equal(commands.some((command) => command.args.includes('volume') || command.args.includes('rmi')), false);
  assert.match(await fsp.readFile(routesPath, 'utf8'), /mos-app-route:start second-app/u);
});

test('system adapter runs multi-service packages on a private package network', async () => {
  const root = await tempDir();
  const routesPath = path.join(root, 'routes.caddy');
  const appPackageRoot = path.join(root, 'packages');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const packageDir = path.join(appPackageRoot, instanceId, 'installed');
  const commands = [];
  await fsp.mkdir(packageDir, { recursive: true });
  await fsp.writeFile(path.join(packageDir, 'manifest.json'), `${JSON.stringify({ id: 'seafile', packageFiles: [] })}\n`);
  await fsp.writeFile(path.join(packageDir, 'Dockerfile'), 'FROM scratch\n');
  const packageDigest = digestAppPackage(packageDir);

  const adapter = new SystemAppAdapter({
    appsRoot: root,
    appPackageRoot,
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
    instanceId,
    packageDigest,
    packageId: 'seafile',
    packageVersion: '0.1.0',
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    services: [
      {
        dockerfile: 'Dockerfile.mysql',
        environment: { MYSQL_ROOT_PASSWORD: 'root-secret' },
        id: 'seafile-mysql',
        imageTag: 'mos-app-seafile-seafile-mysql:0.1.0',
        internalPort: 3306,
        loopbackPort: 18124,
        public: false,
        volumes: ['mysql-data:/var/lib/mysql'],
      },
      {
        dockerfile: 'Dockerfile',
        environment: { SEAFILE_SERVER_HOSTNAME: 'seafile.mos.home' },
        id: 'seafile',
        imageTag: 'mos-app-seafile-seafile:0.1.0',
        internalPort: 80,
        loopbackPort: 18123,
        public: true,
        volumes: ['data:/shared'],
      },
    ],
  });

  const dockerRuns = commands.filter((command) => command.file === 'docker' && command.args[0] === 'run');
  assert.equal(commands.some((command) => command.file === 'docker' && command.args.join(' ') === 'network create mos-app-seafile'), true);
  assert.equal(dockerRuns.length, 2);
  assert.ok(dockerRuns[0].args.includes('--network-alias'));
  assert.equal(dockerRuns[0].args.includes('--publish'), false);
  assert.ok(dockerRuns[1].args.includes('127.0.0.1:18123:80'));
  assert.ok(dockerRuns[1].args.includes('mos-app-seafile-data:/shared'));
});

test('system adapter builds an identity-bound update candidate without touching runtime state', async () => {
  const root = await tempDir();
  const appPackageRoot = path.join(root, 'packages');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const installed = path.join(appPackageRoot, instanceId, 'installed');
  const candidate = path.join(appPackageRoot, instanceId, 'candidate');
  await fsp.mkdir(installed, { recursive: true });
  await fsp.mkdir(candidate, { recursive: true });
  for (const directory of [installed, candidate]) {
    await fsp.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({ id: 'example-tool', packageFiles: [] })}\n`);
    await fsp.writeFile(path.join(directory, 'Dockerfile'), 'FROM scratch\n');
  }
  const commands = [];
  const adapter = new SystemAppAdapter({
    appPackageRoot,
    dockerBinary: 'docker',
    async execute(file, args, options = {}) { commands.push({ args, cwd: options.cwd, file }); },
  });
  const result = await adapter.buildAppPackageUpdate({
    candidateDigest: digestAppPackage(candidate),
    expectedInstalledDigest: digestAppPackage(installed),
    instanceId,
    packageId: 'example-tool',
    packageVersion: '0.2.0',
    services: [{ dockerfile: 'Dockerfile', id: 'web', imageTag: 'candidate:test' }],
    sourceRevision: 'b'.repeat(40),
  });
  assert.deepEqual(result.steps, ['installed-identity-verified', 'candidate-identity-verified', 'candidate-built']);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].cwd, candidate);
  assert.equal(commands[0].args[0], 'build');
  assert.equal(commands.some((command) => command.args.includes('rm') || command.args.includes('run')), false);
});

test('system adapter restores the installed runtime when an update candidate fails health', async () => {
  const root = await tempDir();
  const appPackageRoot = path.join(root, 'packages');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const installedDir = path.join(appPackageRoot, instanceId, 'installed');
  const candidateDir = path.join(appPackageRoot, instanceId, 'candidate');
  for (const directory of [installedDir, candidateDir]) {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({ id: 'example-tool', packageFiles: [] })}\n`);
    await fsp.writeFile(path.join(directory, 'Dockerfile'), 'FROM scratch\n');
  }
  const commands = [];
  let healthCalls = 0;
  const service = (imageTag) => ({ dockerfile: 'Dockerfile', environment: {}, id: 'web', imageTag, internalPort: 3000, loopbackPort: 18123, public: true, volumes: ['data:/data'] });
  const runtime = (directory, imageTag, version) => ({
    caddyRoutes: 'http://example-tool.mos.home {\n  reverse_proxy http://127.0.0.1:18123\n}\n',
    healthTarget: `http://127.0.0.1:18123/${version}`,
    instanceId,
    packageDigest: digestAppPackage(directory),
    packageId: 'example-tool',
    packageVersion: version,
    services: [service(imageTag)],
    sourceRevision: version === '0.2.0' ? 'b'.repeat(40) : 'a'.repeat(40),
  });
  const adapter = new SystemAppAdapter({
    appPackageRoot,
    dockerBinary: 'docker',
    routesPath: path.join(root, 'routes.caddy'),
    async execute(file, args) { commands.push({ args, file }); },
    async waitForReady() { healthCalls += 1; if (healthCalls === 1) throw new Error('candidate unhealthy'); },
  });
  await assert.rejects(
    () => adapter.activateAppPackageUpdate({ candidate: runtime(candidateDir, 'candidate:test', '0.2.0'), installed: runtime(installedDir, 'installed:test', '0.1.0') }),
    (error) => error.code === 'APP_UPDATE_ACTIVATION_FAILED' && error.details.includes('old-runtime-restored'),
  );
  const runs = commands.filter((command) => command.args[0] === 'run');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].args.at(-1), 'candidate:test');
  assert.equal(runs[1].args.at(-1), 'installed:test');
  assert.equal(healthCalls, 2);
  assert.ok(runs.every((command) => command.args.includes('mos-app-example-tool-data:/data')));
});

test('system adapter promotes a verified snapshot and retains only one rollback-safe previous snapshot', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const instanceRoot = path.join(root, 'packages', instanceId);
  for (const [name, version] of [['installed', 'old'], ['candidate', 'new'], ['previous', 'older']]) {
    const directory = path.join(instanceRoot, name);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({ id: 'example-tool', packageFiles: [], version })}\n`);
  }
  const installedDigest = digestAppPackage(path.join(instanceRoot, 'installed'));
  const candidateDigest = digestAppPackage(path.join(instanceRoot, 'candidate'));
  const adapter = new SystemAppAdapter({ appPackageRoot: path.join(root, 'packages') });
  const result = await adapter.promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest: installedDigest, instanceId, packageId: 'example-tool', rollbackSafe: true });
  assert.equal(result.previousRetained, true);
  assert.equal(digestAppPackage(path.join(instanceRoot, 'installed')), candidateDigest);
  assert.equal(digestAppPackage(path.join(instanceRoot, 'previous')), installedDigest);
  assert.equal(await fsp.stat(path.join(instanceRoot, 'candidate')).then(() => true, () => false), false);
});

// An instance mid-update: an installed snapshot about to be superseded by a
// candidate, both declaring the services whose images carry their identity.
async function updatableInstance(root, { instanceId, previousImageTags = null } = {}) {
  const instanceRoot = path.join(root, 'packages', instanceId);
  for (const [name, version] of [['installed', '1.0.0'], ['candidate', '2.0.0']]) {
    const directory = path.join(instanceRoot, name);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({ id: 'example-tool', packageFiles: [], resources: { services: { app: {}, db: {} } }, version })}\n`);
  }
  if (previousImageTags) {
    await fsp.mkdir(path.join(instanceRoot, 'previous'), { recursive: true });
    await fsp.writeFile(path.join(instanceRoot, 'previous-images.json'), `${JSON.stringify({ imageTags: previousImageTags })}\n`);
  }
  return {
    candidateDigest: digestAppPackage(path.join(instanceRoot, 'candidate')),
    installedDigest: digestAppPackage(path.join(instanceRoot, 'installed')),
    instanceRoot,
  };
}

function removedImages(commands) {
  return commands.filter((command) => command.args[0] === 'image' && command.args[1] === 'rm').map((command) => command.args[2]);
}

test('the startup sweep restores an installed snapshot a crash left displaced mid-promotion', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { candidateDigest, installedDigest, instanceRoot } = await updatableInstance(root, { instanceId });
  // A kill between the promotion's two renames: the outgoing snapshot is parked
  // under the deterministic displaced name and `installed/` is gone.
  await fsp.rename(path.join(instanceRoot, 'installed'), path.join(instanceRoot, DISPLACED_INSTALLED_DIR));
  const adapter = new SystemAppAdapter({ appPackageRoot: path.join(root, 'packages') });

  assert.equal(await adapter.sweepInterruptedPromotions(), 1);
  assert.equal(digestAppPackage(path.join(instanceRoot, 'installed')), installedDigest);
  assert.equal(fs.existsSync(path.join(instanceRoot, DISPLACED_INSTALLED_DIR)), false);

  // The repaired instance promotes normally on retry.
  await adapter.promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest: installedDigest, instanceId, packageId: 'example-tool', rollbackSafe: false });
  assert.equal(digestAppPackage(path.join(instanceRoot, 'installed')), candidateDigest);
  assert.equal(fs.existsSync(path.join(instanceRoot, DISPLACED_INSTALLED_DIR)), false);
});

test('a retried promotion reverts and redoes a swap a crash interrupted before snapshot retirement', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { candidateDigest, installedDigest, instanceRoot } = await updatableInstance(root, { instanceId });
  // A kill after both renames but before the displaced snapshot was retired:
  // the candidate already sits under `installed/`, the old snapshot is still
  // parked, and Suite Manager never saw the promotion return.
  await fsp.rename(path.join(instanceRoot, 'installed'), path.join(instanceRoot, DISPLACED_INSTALLED_DIR));
  await fsp.rename(path.join(instanceRoot, 'candidate'), path.join(instanceRoot, 'installed'));
  const adapter = new SystemAppAdapter({ appPackageRoot: path.join(root, 'packages') });

  const result = await adapter.promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest: installedDigest, instanceId, packageId: 'example-tool', rollbackSafe: false });

  assert.ok(result.steps.includes('snapshot-promoted'));
  assert.equal(digestAppPackage(path.join(instanceRoot, 'installed')), candidateDigest);
  assert.equal(fs.existsSync(path.join(instanceRoot, DISPLACED_INSTALLED_DIR)), false);
  assert.equal(fs.existsSync(path.join(instanceRoot, 'candidate')), false);
});

test('system adapter reclaims the images of a package no snapshot refers to any more', async () => {
  const root = await tempDir();
  const commands = [];
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { candidateDigest, installedDigest } = await updatableInstance(root, { instanceId });
  const adapter = new SystemAppAdapter({ appPackageRoot: path.join(root, 'packages'), dockerBinary: 'docker', async execute(file, args) { commands.push({ args, file }); } });
  const revision = 'c'.repeat(40);
  const result = await adapter.promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest: installedDigest, installedSourceRevision: revision, instanceId, packageId: 'example-tool', rollbackSafe: false });
  const fragment = (value) => value.replace(/^sha256:/u, '').slice(0, 12);
  assert.equal(result.imagesReclaimed, 2);
  assert.ok(result.steps.includes('superseded-images-reclaimed'));
  // Every service of the outgoing package, and nothing belonging to the
  // candidate that now serves traffic.
  assert.deepEqual(removedImages(commands).sort(), [
    `mos-app-example-tool-app:1.0.0-pkg-${fragment(installedDigest)}-src-${fragment(revision)}`,
    `mos-app-example-tool-db:1.0.0-pkg-${fragment(installedDigest)}-src-${fragment(revision)}`,
  ].sort());
  assert.equal(removedImages(commands).some((tag) => tag.includes(fragment(candidateDigest))), false);
});

test('system adapter never forces out an image a container still uses', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { candidateDigest, installedDigest, instanceRoot } = await updatableInstance(root, { instanceId });
  const adapter = new SystemAppAdapter({
    appPackageRoot: path.join(root, 'packages'),
    dockerBinary: 'docker',
    // What docker does when an image is still referenced. Reclamation is
    // caretaking after a committed update, so it must not undo the promotion.
    async execute(file, args) { if (args[1] === 'rm') throw new Error('image is being used by running container'); },
  });
  const result = await adapter.promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest: installedDigest, installedSourceRevision: 'c'.repeat(40), instanceId, packageId: 'example-tool', rollbackSafe: false });
  assert.equal(result.imagesReclaimed, 0);
  assert.equal(result.steps.includes('superseded-images-reclaimed'), false);
  assert.equal(digestAppPackage(path.join(instanceRoot, 'installed')), candidateDigest);
});

test('a rollback-safe update keeps its predecessor images and reclaims the generation it evicts', async () => {
  const root = await tempDir();
  const commands = [];
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const evicted = `mos-app-example-tool-app:0.9.0-pkg-${'9'.repeat(12)}-src-${'8'.repeat(12)}`;
  const { candidateDigest, installedDigest, instanceRoot } = await updatableInstance(root, { instanceId, previousImageTags: [evicted] });
  const adapter = new SystemAppAdapter({ appPackageRoot: path.join(root, 'packages'), dockerBinary: 'docker', async execute(file, args) { commands.push({ args, file }); } });
  const revision = 'c'.repeat(40);
  const result = await adapter.promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest: installedDigest, installedSourceRevision: revision, instanceId, packageId: 'example-tool', rollbackSafe: true });
  assert.equal(result.previousRetained, true);
  // The retained snapshot's images have to survive for it to be worth retaining;
  // only the generation it displaced is reclaimed.
  assert.deepEqual(removedImages(commands), [evicted]);
  const fragment = (value) => value.replace(/^sha256:/u, '').slice(0, 12);
  const recorded = JSON.parse(await fsp.readFile(path.join(instanceRoot, 'previous-images.json'), 'utf8'));
  assert.deepEqual(recorded.imageTags, [
    `mos-app-example-tool-app:1.0.0-pkg-${fragment(installedDigest)}-src-${fragment(revision)}`,
    `mos-app-example-tool-db:1.0.0-pkg-${fragment(installedDigest)}-src-${fragment(revision)}`,
  ]);
});

test('a promotion from a Suite Manager that cannot name superseded images reclaims nothing', async () => {
  const root = await tempDir();
  const commands = [];
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { candidateDigest, installedDigest, instanceRoot } = await updatableInstance(root, { instanceId });
  const adapter = new SystemAppAdapter({ appPackageRoot: path.join(root, 'packages'), dockerBinary: 'docker', async execute(file, args) { commands.push({ args, file }); } });
  const result = await adapter.promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest: installedDigest, instanceId, packageId: 'example-tool', rollbackSafe: false });
  // Leaking an image is the acceptable outcome here; refusing the promotion
  // after the candidate is already serving traffic is not.
  assert.equal(result.imagesReclaimed, 0);
  assert.deepEqual(removedImages(commands), []);
  assert.equal(digestAppPackage(path.join(instanceRoot, 'installed')), candidateDigest);
});

test('a tampered retained-image record cannot reclaim images outside the package namespace', async () => {
  const root = await tempDir();
  const commands = [];
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const mine = `mos-app-example-tool-app:0.9.0-pkg-${'9'.repeat(12)}-src-${'8'.repeat(12)}`;
  const { candidateDigest, installedDigest } = await updatableInstance(root, {
    instanceId,
    previousImageTags: ['postgres:16', 'mos-suite-manager:latest', '--force', mine],
  });
  const adapter = new SystemAppAdapter({ appPackageRoot: path.join(root, 'packages'), dockerBinary: 'docker', async execute(file, args) { commands.push({ args, file }); } });
  await adapter.promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest: installedDigest, installedSourceRevision: 'c'.repeat(40), instanceId, packageId: 'example-tool', rollbackSafe: true });
  // Only names this agent could have produced itself are ever handed to docker.
  assert.deepEqual(removedImages(commands), [mine]);
});

test('a rolled-back update reclaims the images of the candidate it abandoned', async () => {
  const root = await tempDir();
  const appPackageRoot = path.join(root, 'packages');
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const installedDir = path.join(appPackageRoot, instanceId, 'installed');
  const candidateDir = path.join(appPackageRoot, instanceId, 'candidate');
  for (const [directory, version] of [[installedDir, '1.0.0'], [candidateDir, '2.0.0']]) {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify({ id: 'example-tool', packageFiles: [], version })}\n`);
  }
  const commands = [];
  const candidateImage = `mos-app-example-tool-web:2.0.0-pkg-${'a'.repeat(12)}-src-${'b'.repeat(12)}`;
  const installedImage = `mos-app-example-tool-web:1.0.0-pkg-${'c'.repeat(12)}-src-${'d'.repeat(12)}`;
  const runtime = (directory, imageTag, version) => ({
    caddyRoutes: 'http://example-tool.mos.home {\n  reverse_proxy http://127.0.0.1:18123\n}\n',
    healthTarget: `http://127.0.0.1:18123/${version}`,
    instanceId,
    packageDigest: digestAppPackage(directory),
    packageId: 'example-tool',
    packageVersion: version,
    services: [{ dockerfile: 'Dockerfile', environment: {}, id: 'web', imageTag, internalPort: 3000, loopbackPort: 18123, public: true, volumes: ['data:/data'] }],
    sourceRevision: 'b'.repeat(40),
  });
  const adapter = new SystemAppAdapter({
    appPackageRoot,
    dockerBinary: 'docker',
    routesPath: path.join(root, 'routes.caddy'),
    async execute(file, args) { commands.push({ args, file }); },
    async waitForReady() {},
  });

  const result = await adapter.rollbackAppPackageUpdate({
    candidate: runtime(candidateDir, candidateImage, '2.0.0'),
    installed: runtime(installedDir, installedImage, '1.0.0'),
  });

  assert.ok(result.steps.includes('candidate-images-reclaimed'));
  // The candidate never became installed and is not coming back, but the
  // runtime that just came back keeps the image it is running from.
  assert.deepEqual(removedImages(commands), [candidateImage]);
});

const fragment = (value) => String(value).replace(/^sha256:/u, '').slice(0, 12);
const imageFor = (serviceId, packageDigest, revision) => `mos-app-example-tool-${serviceId}:1.0.0-pkg-${fragment(packageDigest)}-src-${fragment(revision)}`;

// An app being uninstalled: its installed snapshot on disk, a route to drop, and
// an agent that records what it asked docker to do.
async function uninstallableInstance(root, { instanceId, previousImageTags = null } = {}) {
  const routesPath = path.join(root, 'routes.caddy');
  await fsp.writeFile(routesPath, `# mos-app-route:start example-tool
http://example-tool.mos.home {
  reverse_proxy http://127.0.0.1:18123
}
# mos-app-route:end example-tool
`);
  const commands = [];
  const { installedDigest, instanceRoot } = await updatableInstance(root, { instanceId, previousImageTags });
  const adapter = new SystemAppAdapter({
    appPackageRoot: path.join(root, 'packages'),
    caddyBinary: 'caddy',
    dockerBinary: 'docker',
    routesPath,
    async execute(file, args) { commands.push({ args, file }); },
  });
  return { adapter, commands, installedDigest, instanceRoot };
}

test('an uninstall reclaims its app images and the snapshot directory that outlives the instance', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const revision = 'e'.repeat(40);
  const { adapter, commands, installedDigest, instanceRoot } = await uninstallableInstance(root, { instanceId });

  const result = await adapter.removeAppService({ installedSourceRevision: revision, instanceId, packageId: 'example-tool', serviceIds: ['app', 'db'], volumes: ['data'] });

  assert.equal(result.imagesReclaimed, 2);
  assert.deepEqual(removedImages(commands), [imageFor('app', installedDigest, revision), imageFor('db', installedDigest, revision)]);
  assert.ok(result.steps.includes('snapshot-removed'));
  // The instance row is deleted the moment this returns, so a directory left
  // here would be unreachable for the rest of the host's life.
  assert.equal(fs.existsSync(instanceRoot), false);
});

test('an uninstall reclaims the generation its app kept for rollback', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const revision = 'e'.repeat(40);
  const retained = `mos-app-example-tool-app:0.9.0-pkg-${'a'.repeat(12)}-src-${'b'.repeat(12)}`;
  const { adapter, commands, installedDigest } = await uninstallableInstance(root, { instanceId, previousImageTags: [retained] });

  const result = await adapter.removeAppService({ installedSourceRevision: revision, instanceId, packageId: 'example-tool', serviceIds: ['app', 'db'] });

  // Nothing is rolling back to a package that is being uninstalled.
  assert.equal(result.imagesReclaimed, 3);
  assert.deepEqual(removedImages(commands), [imageFor('app', installedDigest, revision), imageFor('db', installedDigest, revision), retained]);
});

test('an uninstall from a Suite Manager that cannot name the snapshot still uninstalls', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { adapter, commands, instanceRoot } = await uninstallableInstance(root, { instanceId });

  const result = await adapter.removeAppService({ packageId: 'example-tool', serviceIds: ['app', 'db'], volumes: ['data'] });

  // Leaking a snapshot and its images is the price of an older Suite Manager,
  // and a far better one than an uninstall that refuses to run at all.
  assert.equal(result.imagesReclaimed, 0);
  assert.deepEqual(removedImages(commands), []);
  assert.ok(result.steps.includes('stopped'));
  assert.equal(fs.existsSync(instanceRoot), true);
});

test('an uninstall never reclaims images for a package its snapshot is not', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const retained = `mos-app-other-app-app:0.9.0-pkg-${'a'.repeat(12)}-src-${'b'.repeat(12)}`;
  const { adapter, commands, instanceRoot } = await uninstallableInstance(root, { instanceId, previousImageTags: [retained] });

  const result = await adapter.removeAppService({ installedSourceRevision: 'e'.repeat(40), instanceId, packageId: 'other-app', serviceIds: ['app'] });

  // The snapshot holds example-tool, so nothing here can name an image of the
  // app the caller claims to be uninstalling except the tags it recorded itself.
  assert.deepEqual(removedImages(commands), [retained]);
  assert.equal(result.imagesReclaimed, 1);
  assert.equal(fs.existsSync(instanceRoot), false);
});

test('an uninstall survives an image docker will not remove', async () => {
  const root = await tempDir();
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const { adapter, instanceRoot } = await uninstallableInstance(root, { instanceId });
  adapter.execute = async (file, args) => {
    if (args[0] === 'image' && args[1] === 'rm') throw new Error('image is being used by running container');
  };

  const result = await adapter.removeAppService({ installedSourceRevision: 'e'.repeat(40), instanceId, packageId: 'example-tool', serviceIds: ['app'] });

  assert.equal(result.imagesReclaimed, 0);
  assert.ok(result.steps.includes('stopped'));
  assert.equal(fs.existsSync(instanceRoot), false);
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
    ['network', 'inspect', 'mos-app-seafile'],
    ['network', 'disconnect', 'mos-app-seafile', 'mos-app-onlyoffice'],
    ['network', 'connect', '--alias', 'onlyoffice', 'mos-app-seafile', 'mos-app-onlyoffice'],
  ]);
});

// Ownership from birth: volumes are created explicitly with MOS labels before
// `docker run` can create them unlabeled as a side effect, and a volume still
// bound to a different installation refuses the install instead of silently
// pairing fresh credentials with another installation's data.
test('system adapter creates labeled app volumes and refuses stale data from another installation', async () => {
  const commands = [];
  const adapter = new SystemAppAdapter({
    dockerBinary: 'docker',
    async execute(file, args) { commands.push({ args, file }); },
    async executeCapture(file, args) {
      commands.push({ args, file });
      if (args[1] === 'inspect' && args.at(-1) === 'mos-app-example-tool-data') {
        return JSON.stringify({ 'mos.instance': 'other-installation', 'mos.owned': 'true', 'mos.package': 'example-tool' });
      }
      throw new Error('COMMAND_FAILED');
    },
  });

  await adapter.ensureAppVolumes({ instanceId: 'aaaa-1111', packageId: 'fresh-app', services: [{ volumes: ['data:/data', 'cache:/cache'] }] });
  const creates = commands.filter((command) => command.args[0] === 'volume' && command.args[1] === 'create');
  assert.deepEqual(creates.map((command) => command.args.at(-1)), ['mos-app-fresh-app-data', 'mos-app-fresh-app-cache']);
  assert.ok(creates[0].args.includes('mos.owned=true'));
  assert.ok(creates[0].args.includes('mos.instance=aaaa-1111'));
  assert.ok(creates[0].args.includes('mos.package=fresh-app'));
  assert.ok(creates[0].args.includes('mos.resource=docker-volume:mos-app-fresh-app-data'));

  await assert.rejects(
    () => adapter.ensureAppVolumes({ instanceId: 'bbbb-2222', packageId: 'example-tool', services: [{ volumes: ['data:/data'] }] }),
    (error) => error.code === 'APP_VOLUME_STALE',
  );

  // An unlabeled volume (created before ownership labels existed) stays
  // accepted: no binding, no refusal, no create.
  const before = commands.length;
  const legacyAdapter = new SystemAppAdapter({
    dockerBinary: 'docker',
    async execute(file, args) { commands.push({ args, file }); },
    async executeCapture() { return 'null'; },
  });
  await legacyAdapter.ensureAppVolumes({ instanceId: 'cccc-3333', packageId: 'legacy-app', services: [{ volumes: ['data:/data'] }] });
  assert.equal(commands.slice(before).some((command) => command.args[1] === 'create'), false);
});
