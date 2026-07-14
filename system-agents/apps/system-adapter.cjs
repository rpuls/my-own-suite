const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { collectPackageFiles, digestAppPackage } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');

const APPS_ROOT = process.env.MOS_V2_APPS_ROOT || path.resolve(process.cwd(), 'apps');
const APP_PACKAGE_ROOT = process.env.MOS_V2_APP_PACKAGE_ROOT || '/var/lib/mos-v2/app-packages';
const APP_CANDIDATE_ROOT = process.env.MOS_V2_APP_CANDIDATE_ROOT || '/var/lib/mos-v2/suite-manager/app-candidates';
const APP_ROUTES_PATH = process.env.MOS_V2_APP_ROUTES_PATH || '/etc/caddy/mos-v2-app-routes.caddy';
const CADDY_BINARY = process.env.MOS_V2_CADDY_BINARY || '/usr/local/libexec/mos-v2/caddy';
const DOCKER_BINARY = process.env.MOS_V2_DOCKER_BINARY || '/usr/bin/docker';
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_REFRESH_TIMEOUT_MS = 5_000;
const EMPTY_APP_ROUTES = '# No app runtime routes.\n';

const FAILURE_MESSAGES = {
  build: ['APP_BUILD_FAILED', 'The app image could not be built.'],
  'caddy-reload': ['APP_CADDY_RELOAD_FAILED', 'Caddy could not reload the app route.'],
  'caddy-validation': ['APP_CADDY_VALIDATION_FAILED', 'The generated app route did not pass Caddy validation.'],
  health: ['APP_HEALTH_FAILED', 'The app container started but did not become healthy in time.'],
  network: ['APP_NETWORK_CONNECT_FAILED', 'The app integration network could not be connected.'],
  remove: ['APP_RUNTIME_REMOVE_FAILED', 'The app runtime could not be removed.'],
  run: ['APP_RUN_FAILED', 'The app container could not be started.'],
  snapshot: ['APP_PACKAGE_SNAPSHOT_FAILED', 'The validated app package could not be snapshotted.'],
  stop: ['APP_RUNTIME_STOP_FAILED', 'The app runtime could not be stopped.'],
  writing: ['APP_ROUTE_WRITE_FAILED', 'The app route could not be installed.'],
};

class AppApplyError extends Error {
  constructor(stage) {
    const [code, message] = FAILURE_MESSAGES[stage] || ['APP_RUNTIME_APPLY_FAILED', 'The app runtime operation failed.'];
    super(message);
    this.code = code;
    this.statusCode = 502;
  }
}

function exec(file, args, { cwd = undefined, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: 'ignore' });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error('COMMAND_TIMEOUT'));
    }, timeoutMs);
    child.on('error', (error) => {
      finish(reject, error);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      finish(reject, new Error('COMMAND_FAILED'));
    });
  });
}

async function atomicWrite(target, content, mode = 0o644) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, content, { mode });
  await fsp.chmod(temporary, mode);
  await fsp.rename(temporary, target);
}

async function snapshot(source, target) {
  if (fs.existsSync(source)) await fsp.copyFile(source, target);
  else await fsp.writeFile(`${target}.missing`, '');
}

async function restore(source, target) {
  if (fs.existsSync(`${source}.missing`)) await fsp.rm(target, { force: true });
  else await atomicWrite(target, await fsp.readFile(source, 'utf8'));
}

function renderAppRouteBlock(packageId, caddyRoutes) {
  return `# mos-v2-app-route:start ${packageId}\n${String(caddyRoutes).trimEnd()}\n# mos-v2-app-route:end ${packageId}\n`;
}

function upsertAppRouteBlock(currentRoutes, { caddyRoutes, packageId }) {
  const block = renderAppRouteBlock(packageId, caddyRoutes);
  const current = typeof currentRoutes === 'string' ? currentRoutes : EMPTY_APP_ROUTES;
  const markerPattern = new RegExp(
    `# mos-v2-app-route:start ${packageId}\\n[\\s\\S]*?# mos-v2-app-route:end ${packageId}\\n?`,
    'u',
  );
  if (markerPattern.test(current)) {
    return current.replace(markerPattern, block);
  }

  const meaningful = current.trim();
  if (!meaningful || meaningful === EMPTY_APP_ROUTES.trim() || meaningful === String(caddyRoutes).trim()) {
    return block;
  }
  return `${current.trimEnd()}\n\n${block}`;
}

function removeAppRouteBlock(currentRoutes, packageId) {
  const current = typeof currentRoutes === 'string' ? currentRoutes : EMPTY_APP_ROUTES;
  const markerPattern = new RegExp(
    `# mos-v2-app-route:start ${packageId}\\n[\\s\\S]*?# mos-v2-app-route:end ${packageId}\\n?`,
    'u',
  );
  const next = current.replace(markerPattern, '').trim();
  return next ? `${next}\n` : EMPTY_APP_ROUTES;
}

function waitForHttp(url, { deadlineMs = HEALTH_TIMEOUT_MS } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, { timeout: 3000 }, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      request.on('timeout', () => request.destroy(new Error('TIMEOUT')));
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started >= deadlineMs) {
        reject(new Error('HEALTH_TIMEOUT'));
        return;
      }
      setTimeout(attempt, 1500);
    };
    attempt();
  });
}

class SystemAppAdapter {
  constructor({
    appsRoot = APPS_ROOT,
    appCandidateRoot = APP_CANDIDATE_ROOT,
    appPackageRoot = APP_PACKAGE_ROOT,
    caddyBinary = CADDY_BINARY,
    dockerBinary = DOCKER_BINARY,
    execute = exec,
    routesPath = APP_ROUTES_PATH,
    waitForReady = waitForHttp,
  } = {}) {
    this.appsRoot = appsRoot;
    this.appCandidateRoot = appCandidateRoot;
    this.appPackageRoot = appPackageRoot;
    this.caddyBinary = caddyBinary;
    this.dockerBinary = dockerBinary;
    this.execute = execute;
    this.routesPath = routesPath;
    this.waitForReady = waitForReady;
  }

  containerName(packageId, serviceId, serviceCount) {
    return serviceCount === 1 ? `mos-v2-app-${packageId}` : `mos-v2-app-${packageId}-${serviceId}`;
  }

  networkName(packageId) {
    return `mos-v2-app-${packageId}`;
  }

  async snapshotAppPackage({ instanceId, packageDigest, packageId }) {
    const source = path.join(this.appsRoot, packageId);
    const instanceRoot = path.join(this.appPackageRoot, instanceId);
    const installed = path.join(instanceRoot, 'installed');
    const temporary = path.join(instanceRoot, `.snapshot-${crypto.randomUUID()}`);
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(source, 'manifest.json'), 'utf8'));
      if (manifest.id !== packageId || digestAppPackage(source, { manifest }) !== packageDigest) throw new Error('PACKAGE_DIGEST_MISMATCH');
      if (fs.existsSync(installed)) throw new Error('INSTALLED_SNAPSHOT_EXISTS');

      await fsp.mkdir(temporary, { recursive: true, mode: 0o750 });
      for (const file of collectPackageFiles(source, { manifest })) {
        const target = path.join(temporary, ...file.relativePath.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
        await fsp.copyFile(file.absolutePath, target);
        const sourceMode = (await fsp.stat(file.absolutePath)).mode;
        await fsp.chmod(target, sourceMode & 0o111 ? 0o750 : 0o640);
      }
      if (digestAppPackage(temporary, { manifest }) !== packageDigest) throw new Error('COPIED_PACKAGE_DIGEST_MISMATCH');
      await fsp.rename(temporary, installed);
      return { snapshotPath: installed, steps: ['validated', 'copied', 'verified', 'promoted'] };
    } catch (error) {
      await fsp.rm(temporary, { force: true, recursive: true }).catch(() => {});
      const failure = new AppApplyError('snapshot');
      failure.details = error?.details || [String(error?.message || 'snapshot failed')];
      throw failure;
    }
  }

  async stageAppPackageUpdate({ candidateDigest, candidatePath, expectedInstalledDigest, instanceId, packageId }) {
    const candidateRoot = path.resolve(this.appCandidateRoot);
    const source = path.resolve(candidatePath);
    const relativeSource = path.relative(candidateRoot, source);
    const instanceRoot = path.join(this.appPackageRoot, instanceId);
    const installed = path.join(instanceRoot, 'installed');
    const staged = path.join(instanceRoot, 'candidate');
    const temporary = path.join(instanceRoot, `.candidate-${crypto.randomUUID()}`);
    try {
      if (!relativeSource || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) throw new Error('CANDIDATE_PATH_OUTSIDE_ROOT');
      const installedManifest = JSON.parse(await fsp.readFile(path.join(installed, 'manifest.json'), 'utf8'));
      if (installedManifest.id !== packageId || digestAppPackage(installed, { manifest: installedManifest }) !== expectedInstalledDigest) throw new Error('INSTALLED_PACKAGE_CHANGED');
      const candidateManifest = JSON.parse(await fsp.readFile(path.join(source, 'manifest.json'), 'utf8'));
      if (candidateManifest.id !== packageId || digestAppPackage(source, { manifest: candidateManifest }) !== candidateDigest) throw new Error('CANDIDATE_PACKAGE_CHANGED');
      await fsp.rm(staged, { force: true, recursive: true });
      await fsp.mkdir(temporary, { recursive: true, mode: 0o750 });
      for (const file of collectPackageFiles(source, { manifest: candidateManifest })) {
        const target = path.join(temporary, ...file.relativePath.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
        await fsp.copyFile(file.absolutePath, target);
        const sourceMode = (await fsp.stat(file.absolutePath)).mode;
        await fsp.chmod(target, sourceMode & 0o111 ? 0o750 : 0o640);
      }
      if (digestAppPackage(temporary, { manifest: candidateManifest }) !== candidateDigest) throw new Error('COPIED_CANDIDATE_DIGEST_MISMATCH');
      await fsp.rename(temporary, staged);
      return { snapshotPath: staged, steps: ['installed-identity-verified', 'candidate-identity-verified', 'copied', 'verified', 'staged'] };
    } catch (error) {
      await fsp.rm(temporary, { force: true, recursive: true }).catch(() => {});
      const failure = new AppApplyError('snapshot');
      failure.code = ['INSTALLED_PACKAGE_CHANGED', 'CANDIDATE_PACKAGE_CHANGED'].includes(error?.message) ? 'APP_UPDATE_IDENTITY_CHANGED' : failure.code;
      failure.statusCode = failure.code === 'APP_UPDATE_IDENTITY_CHANGED' ? 409 : failure.statusCode;
      failure.details = [String(error?.message || 'update staging failed')];
      throw failure;
    }
  }

  async buildAppPackageUpdate({ candidateDigest, expectedInstalledDigest, instanceId, packageId, packageVersion, services, sourceRevision }) {
    const instanceRoot = path.join(this.appPackageRoot, instanceId);
    const installed = path.join(instanceRoot, 'installed');
    const candidate = path.join(instanceRoot, 'candidate');
    try {
      const installedManifest = JSON.parse(await fsp.readFile(path.join(installed, 'manifest.json'), 'utf8'));
      if (installedManifest.id !== packageId || digestAppPackage(installed, { manifest: installedManifest }) !== expectedInstalledDigest) throw new Error('INSTALLED_PACKAGE_CHANGED');
      const candidateManifest = JSON.parse(await fsp.readFile(path.join(candidate, 'manifest.json'), 'utf8'));
      if (candidateManifest.id !== packageId || digestAppPackage(candidate, { manifest: candidateManifest }) !== candidateDigest) throw new Error('CANDIDATE_PACKAGE_CHANGED');
      for (const service of services) {
        await this.execute(this.dockerBinary, [
          'build', '--file', service.dockerfile, '--tag', service.imageTag,
          '--label', `mos-v2.package=${packageId}`,
          '--label', `mos-v2.package-version=${packageVersion}`,
          '--label', `mos-v2.package-digest=${candidateDigest}`,
          '--label', `mos-v2.source-revision=${sourceRevision}`,
          '.',
        ], { cwd: candidate, timeoutMs: 300000 });
      }
      return { steps: ['installed-identity-verified', 'candidate-identity-verified', 'candidate-built'] };
    } catch (error) {
      const failure = new AppApplyError('build');
      failure.code = ['INSTALLED_PACKAGE_CHANGED', 'CANDIDATE_PACKAGE_CHANGED'].includes(error?.message) ? 'APP_UPDATE_IDENTITY_CHANGED' : failure.code;
      failure.statusCode = failure.code === 'APP_UPDATE_IDENTITY_CHANGED' ? 409 : failure.statusCode;
      failure.details = [String(error?.message || 'candidate build failed')];
      throw failure;
    }
  }

  async startPackageContainers({ packageDigest, packageId, packageVersion, services, sourceRevision }) {
    const serviceCount = services.length;
    const networkName = this.networkName(packageId);
    if (serviceCount > 1) {
      await this.execute(this.dockerBinary, ['network', 'create', networkName], { timeoutMs: 30000 }).catch(() => {});
    }
    for (const service of services) {
      const volumeArgs = [];
      for (const volume of service.volumes || []) {
        const separator = String(volume).indexOf(':');
        if (separator > 0) volumeArgs.push('--volume', `mos-v2-app-${packageId}-${String(volume).slice(0, separator)}:${String(volume).slice(separator + 1)}`);
      }
      await this.execute(this.dockerBinary, [
        'run', '--detach', '--name', this.containerName(packageId, service.id, serviceCount), '--restart', 'unless-stopped',
        ...(serviceCount > 1 ? ['--network', networkName, '--network-alias', service.id] : []),
        ...(service.public ? ['--publish', `127.0.0.1:${service.loopbackPort}:${service.internalPort}`] : []),
        '--label', `mos-v2.package=${packageId}`,
        '--label', `mos-v2.service=${service.id}`,
        '--label', `mos-v2.package-version=${packageVersion}`,
        '--label', `mos-v2.package-digest=${packageDigest}`,
        '--label', `mos-v2.source-revision=${sourceRevision}`,
        ...Object.entries(service.environment || {}).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        ...volumeArgs,
        service.imageTag,
      ], { timeoutMs: 60000 });
    }
  }

  async activateAppPackageUpdate({ candidate, installed }) {
    const instanceRoot = path.join(this.appPackageRoot, candidate.instanceId);
    const installedDir = path.join(instanceRoot, 'installed');
    const candidateDir = path.join(instanceRoot, 'candidate');
    const routeSnapshot = `${this.routesPath}.before-update-${process.pid}`;
    let routesChanged = false;
    let candidateStarted = false;
    let oldRuntimeStopped = false;
    try {
      const installedManifest = JSON.parse(await fsp.readFile(path.join(installedDir, 'manifest.json'), 'utf8'));
      const candidateManifest = JSON.parse(await fsp.readFile(path.join(candidateDir, 'manifest.json'), 'utf8'));
      if (installedManifest.id !== installed.packageId || digestAppPackage(installedDir, { manifest: installedManifest }) !== installed.packageDigest) throw new Error('INSTALLED_PACKAGE_CHANGED');
      if (candidateManifest.id !== candidate.packageId || digestAppPackage(candidateDir, { manifest: candidateManifest }) !== candidate.packageDigest) throw new Error('CANDIDATE_PACKAGE_CHANGED');

      await this.removePackageContainers({ packageId: installed.packageId, serviceIds: installed.services.map((service) => service.id), serviceCount: installed.services.length });
      oldRuntimeStopped = true;
      candidateStarted = true;
      await this.startPackageContainers(candidate);
      await this.waitForReady(candidate.healthTarget);

      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      const nextRoutes = upsertAppRouteBlock(currentRoutes, { caddyRoutes: candidate.caddyRoutes, packageId: candidate.packageId });
      routesChanged = currentRoutes !== nextRoutes;
      if (routesChanged) {
        const routeCandidate = `${this.routesPath}.candidate-${process.pid}`;
        await fsp.writeFile(routeCandidate, nextRoutes);
        await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', routeCandidate], { timeoutMs: 20000 });
        await fsp.rm(routeCandidate, { force: true }).catch(() => {});
        await snapshot(this.routesPath, routeSnapshot);
        await atomicWrite(this.routesPath, nextRoutes);
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
      }
      return { steps: ['installed-identity-verified', 'candidate-identity-verified', 'old-runtime-stopped', 'candidate-started', 'candidate-healthy', ...(routesChanged ? ['route-written', 'caddy-reloaded'] : [])] };
    } catch (error) {
      if (routesChanged) {
        await restore(routeSnapshot, this.routesPath).catch(() => {});
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 10000 }).catch(() => {});
      }
      if (!oldRuntimeStopped) {
        const failure = new AppApplyError('snapshot');
        failure.code = 'APP_UPDATE_IDENTITY_CHANGED';
        failure.statusCode = 409;
        failure.details = [String(error?.message || 'update identity changed')];
        throw failure;
      }
      if (candidateStarted) await this.removePackageContainers({ packageId: candidate.packageId, serviceIds: candidate.services.map((service) => service.id), serviceCount: candidate.services.length }).catch(() => {});
      try {
        await this.startPackageContainers(installed);
        await this.waitForReady(installed.healthTarget);
      } catch (rollbackError) {
        const failure = new AppApplyError('run');
        failure.code = 'APP_UPDATE_ROLLBACK_FAILED';
        failure.details = [String(error?.message || 'candidate activation failed'), String(rollbackError?.message || 'old runtime restart failed')];
        throw failure;
      }
      const failure = new AppApplyError(error?.message === 'INSTALLED_PACKAGE_CHANGED' || error?.message === 'CANDIDATE_PACKAGE_CHANGED' ? 'snapshot' : 'run');
      failure.code = ['INSTALLED_PACKAGE_CHANGED', 'CANDIDATE_PACKAGE_CHANGED'].includes(error?.message) ? 'APP_UPDATE_IDENTITY_CHANGED' : 'APP_UPDATE_ACTIVATION_FAILED';
      failure.statusCode = failure.code === 'APP_UPDATE_IDENTITY_CHANGED' ? 409 : 502;
      failure.details = [String(error?.message || 'candidate activation failed'), 'old-runtime-restored'];
      throw failure;
    } finally {
      await fsp.rm(routeSnapshot, { force: true }).catch(() => {});
      await fsp.rm(`${routeSnapshot}.missing`, { force: true }).catch(() => {});
    }
  }

  async promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest, instanceId, packageId, rollbackSafe }) {
    const instanceRoot = path.join(this.appPackageRoot, instanceId);
    const installed = path.join(instanceRoot, 'installed');
    const candidate = path.join(instanceRoot, 'candidate');
    const previous = path.join(instanceRoot, 'previous');
    const displaced = path.join(instanceRoot, `.installed-before-update-${process.pid}`);
    try {
      const installedManifest = JSON.parse(await fsp.readFile(path.join(installed, 'manifest.json'), 'utf8'));
      const candidateManifest = JSON.parse(await fsp.readFile(path.join(candidate, 'manifest.json'), 'utf8'));
      if (installedManifest.id !== packageId || digestAppPackage(installed, { manifest: installedManifest }) !== expectedInstalledDigest) throw new Error('INSTALLED_PACKAGE_CHANGED');
      if (candidateManifest.id !== packageId || digestAppPackage(candidate, { manifest: candidateManifest }) !== candidateDigest) throw new Error('CANDIDATE_PACKAGE_CHANGED');
      await fsp.rm(displaced, { force: true, recursive: true });
      await fsp.rename(installed, displaced);
      try { await fsp.rename(candidate, installed); }
      catch (error) { await fsp.rename(displaced, installed).catch(() => {}); throw error; }
      await fsp.rm(previous, { force: true, recursive: true });
      if (rollbackSafe) await fsp.rename(displaced, previous);
      else await fsp.rm(displaced, { force: true, recursive: true });
      return { previousRetained: rollbackSafe, snapshotPath: installed, steps: ['installed-identity-verified', 'candidate-identity-verified', 'snapshot-promoted', ...(rollbackSafe ? ['previous-retained'] : [])] };
    } catch (error) {
      const failure = new AppApplyError('snapshot');
      failure.code = ['INSTALLED_PACKAGE_CHANGED', 'CANDIDATE_PACKAGE_CHANGED'].includes(error?.message) ? 'APP_UPDATE_IDENTITY_CHANGED' : 'APP_UPDATE_PROMOTION_FAILED';
      failure.statusCode = failure.code === 'APP_UPDATE_IDENTITY_CHANGED' ? 409 : 502;
      failure.details = [String(error?.message || 'snapshot promotion failed')];
      throw failure;
    }
  }

  async applyAppService({ caddyRoutes, dockerfile, environment = {}, healthTarget, imageTag, instanceId, internalPort, loopbackPort, packageDigest, packageId, packageVersion, sourceRevision, volumes }) {
    return this.applyAppServices({
      caddyRoutes,
      healthTarget,
      instanceId,
      packageDigest,
      packageId,
      packageVersion,
      sourceRevision,
      services: [{
        dockerfile,
        environment,
        id: packageId,
        imageTag,
        internalPort,
        loopbackPort,
        public: true,
        volumes,
      }],
    });
  }

  async applyAppServices({ caddyRoutes, healthTarget, instanceId, packageDigest, packageId, packageVersion, services, sourceRevision }) {
    const packageDir = path.join(this.appPackageRoot, instanceId, 'installed');
    const routeSnapshot = `${this.routesPath}.before-${process.pid}`;
    let routesChanged = false;
    let stage = 'build';

    try {
      const installedManifest = JSON.parse(await fsp.readFile(path.join(packageDir, 'manifest.json'), 'utf8'));
      if (installedManifest.id !== packageId || digestAppPackage(packageDir) !== packageDigest) throw new Error('PACKAGE_SNAPSHOT_MISMATCH');
      const serviceCount = services.length;
      for (const service of services) {
        await this.execute(this.dockerBinary, [
          'build',
          '--file', service.dockerfile,
          '--tag', service.imageTag,
          '--label', `mos-v2.package=${packageId}`,
          '--label', `mos-v2.package-version=${packageVersion}`,
          '--label', `mos-v2.package-digest=${packageDigest}`,
          '--label', `mos-v2.source-revision=${sourceRevision}`,
          '.',
        ], { cwd: packageDir, timeoutMs: 300000 });
      }

      stage = 'run';
      await this.removePackageContainers({ packageId, serviceIds: services.map((service) => service.id), serviceCount });
      const networkName = this.networkName(packageId);
      if (serviceCount > 1) {
        await this.execute(this.dockerBinary, ['network', 'create', networkName], { timeoutMs: 30000 }).catch(() => {});
      }

      for (const service of services) {
        const volumeArgs = [];
        for (const volume of service.volumes || []) {
          const separator = String(volume).indexOf(':');
          if (separator > 0) {
            volumeArgs.push('--volume', `mos-v2-app-${packageId}-${String(volume).slice(0, separator)}:${String(volume).slice(separator + 1)}`);
          }
        }
        const containerName = this.containerName(packageId, service.id, serviceCount);
        await this.execute(this.dockerBinary, [
          'run',
          '--detach',
          '--name', containerName,
          '--restart', 'unless-stopped',
          ...(serviceCount > 1 ? ['--network', networkName, '--network-alias', service.id] : []),
          ...(service.public ? ['--publish', `127.0.0.1:${service.loopbackPort}:${service.internalPort}`] : []),
          '--label', `mos-v2.package=${packageId}`,
          '--label', `mos-v2.service=${service.id}`,
          '--label', `mos-v2.package-version=${packageVersion}`,
          '--label', `mos-v2.package-digest=${packageDigest}`,
          '--label', `mos-v2.source-revision=${sourceRevision}`,
          ...Object.entries(service.environment || {}).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
          ...volumeArgs,
          service.imageTag,
        ], { timeoutMs: 60000 });
      }

      stage = 'health';
      await this.waitForReady(healthTarget);

      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      const nextRoutes = upsertAppRouteBlock(currentRoutes, { caddyRoutes, packageId });
      routesChanged = currentRoutes !== nextRoutes;
      if (routesChanged) {
        stage = 'caddy-validation';
        const candidate = `${this.routesPath}.candidate-${process.pid}`;
        await fsp.writeFile(candidate, nextRoutes);
        await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', candidate], { timeoutMs: 20000 });
        await fsp.rm(candidate, { force: true }).catch(() => {});
        await snapshot(this.routesPath, routeSnapshot);

        stage = 'writing';
        await atomicWrite(this.routesPath, nextRoutes);

        stage = 'caddy-reload';
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
        await fsp.rm(routeSnapshot, { force: true }).catch(() => {});
        await fsp.rm(`${routeSnapshot}.missing`, { force: true }).catch(() => {});
      }

      return { steps: ['built', 'started', 'healthy', ...(routesChanged ? ['route-written', 'caddy-reloaded'] : [])] };
    } catch {
      if (routesChanged) {
        await restore(routeSnapshot, this.routesPath).catch(() => {});
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 10000 }).catch(() => {});
      }
      throw new AppApplyError(stage);
    }
  }

  async checkAppHealth({ healthTarget }) {
    try {
      await this.waitForReady(healthTarget, { deadlineMs: HEALTH_REFRESH_TIMEOUT_MS });
      return { status: 'healthy' };
    } catch {
      throw new AppApplyError('health');
    }
  }

  async connectPackageNetwork({ consumerPackageId, providerPackageId, providerServiceCount, providerServices }) {
    try {
      const networkName = this.networkName(consumerPackageId);
      await this.execute(this.dockerBinary, ['network', 'inspect', networkName], { timeoutMs: 30000 });
      for (const serviceId of providerServices) {
        const containerName = this.containerName(providerPackageId, serviceId, providerServiceCount);
        const aliases = [...new Set([providerPackageId, serviceId])].flatMap((alias) => ['--alias', alias]);
        await this.execute(this.dockerBinary, ['network', 'disconnect', networkName, containerName], { timeoutMs: 30000 }).catch(() => {});
        await this.execute(this.dockerBinary, [
          'network',
          'connect',
          ...aliases,
          networkName,
          containerName,
        ], { timeoutMs: 30000 });
      }
      return { steps: ['network-connected'] };
    } catch {
      throw new AppApplyError('network');
    }
  }

  async removePackageContainers({ packageId, serviceCount = 1, serviceIds = [] }) {
    const ids = serviceIds.length ? serviceIds : [packageId];
    for (const serviceId of ids) {
      await this.execute(this.dockerBinary, ['rm', '-f', this.containerName(packageId, serviceId, serviceCount)], { timeoutMs: 30000 }).catch(() => {});
    }
    if (serviceCount > 1 || serviceIds.length > 1) {
      await this.execute(this.dockerBinary, ['network', 'rm', this.networkName(packageId)], { timeoutMs: 30000 }).catch(() => {});
    }
  }

  async stopAppService({ packageId, serviceIds = [] }) {
    try {
      await this.execute(this.dockerBinary, ['rm', '-f', `mos-v2-app-${packageId}`], { timeoutMs: 30000 }).catch(() => {});
      for (const serviceId of serviceIds) {
        await this.execute(this.dockerBinary, ['rm', '-f', `mos-v2-app-${packageId}-${serviceId}`], { timeoutMs: 30000 }).catch(() => {});
      }
      await this.execute(this.dockerBinary, ['network', 'rm', this.networkName(packageId)], { timeoutMs: 30000 }).catch(() => {});
      return { steps: ['stopped'] };
    } catch {
      throw new AppApplyError('stop');
    }
  }

  async removeAppService({ packageId, serviceIds = [], volumes = [] }) {
    const routeSnapshot = `${this.routesPath}.before-${process.pid}`;
    let routesChanged = false;
    try {
      await this.execute(this.dockerBinary, ['rm', '-f', `mos-v2-app-${packageId}`], { timeoutMs: 30000 }).catch(() => {});
      for (const serviceId of serviceIds) {
        await this.execute(this.dockerBinary, ['rm', '-f', `mos-v2-app-${packageId}-${serviceId}`], { timeoutMs: 30000 }).catch(() => {});
      }
      await this.execute(this.dockerBinary, ['network', 'rm', this.networkName(packageId)], { timeoutMs: 30000 }).catch(() => {});
      for (const volume of volumes) {
        const volumeName = `mos-v2-app-${packageId}-${volume}`;
        const exists = await this.execute(this.dockerBinary, ['volume', 'inspect', volumeName], { timeoutMs: 30000 }).then(() => true, () => false);
        if (exists) {
          await this.execute(this.dockerBinary, ['volume', 'rm', volumeName], { timeoutMs: 120000 });
        }
      }

      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      const nextRoutes = removeAppRouteBlock(currentRoutes, packageId);
      routesChanged = currentRoutes !== nextRoutes;
      if (routesChanged) {
        const candidate = `${this.routesPath}.candidate-${process.pid}`;
        await fsp.writeFile(candidate, nextRoutes);
        await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', candidate], { timeoutMs: 20000 });
        await fsp.rm(candidate, { force: true }).catch(() => {});
        await snapshot(this.routesPath, routeSnapshot);
        await atomicWrite(this.routesPath, nextRoutes);
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
        await fsp.rm(routeSnapshot, { force: true }).catch(() => {});
        await fsp.rm(`${routeSnapshot}.missing`, { force: true }).catch(() => {});
      }

      return { steps: ['stopped', ...(volumes.length ? ['volumes-removed'] : []), ...(routesChanged ? ['route-removed', 'caddy-reloaded'] : [])] };
    } catch {
      if (routesChanged) {
        await restore(routeSnapshot, this.routesPath).catch(() => {});
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 10000 }).catch(() => {});
      }
      throw new AppApplyError('remove');
    }
  }
}

module.exports = {
  APP_PACKAGE_ROOT,
  APP_CANDIDATE_ROOT,
  APP_ROUTES_PATH,
  AppApplyError,
  HEALTH_REFRESH_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  SystemAppAdapter,
  atomicWrite,
  removeAppRouteBlock,
  renderAppRouteBlock,
  upsertAppRouteBlock,
  waitForHttp,
};
