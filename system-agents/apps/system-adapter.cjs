const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { packageImageTag } = require('./agent-core.cjs');
const { collectPackageFiles, digestAppPackage, parseNamespacedPackageId, verifySnapshotIdentity } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');

const APPS_ROOT = process.env.MOS_APPS_ROOT || path.resolve(process.cwd(), 'apps');
const APP_PACKAGE_ROOT = process.env.MOS_APP_PACKAGE_ROOT || '/var/lib/mos/app-packages';
const APP_CANDIDATE_ROOT = process.env.MOS_APP_CANDIDATE_ROOT || '/var/lib/mos/suite-manager/app-candidates';
const APP_ROUTES_PATH = process.env.MOS_APP_ROUTES_PATH || '/etc/caddy/mos-app-routes.caddy';
const CADDY_BINARY = process.env.MOS_CADDY_BINARY || '/usr/local/libexec/mos/caddy';
const DOCKER_BINARY = process.env.MOS_DOCKER_BINARY || '/usr/bin/docker';
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_REFRESH_TIMEOUT_MS = 5_000;
const EMPTY_APP_ROUTES = '# No app runtime routes.\n';
// Where a promotion parks the outgoing installed snapshot between its two
// renames. Deterministic on purpose: a process killed between the renames is
// gone, and only a name every later process can re-derive lets any of them
// find the parked snapshot and finish or undo the swap.
const DISPLACED_INSTALLED_DIR = '.installed-before-update';

// The manifest id a package managed under `packageId` must declare. An official
// package is managed under its bare manifest id; a package from any other source
// is managed under `x-<namespace>-<manifest id>` while its manifest keeps
// declaring the bare id. Resolving the expected id this way keeps every identity
// check exact, and a namespaced package still cannot pass as the official package
// of the same name, because a bare id only ever resolves to itself.
function expectedManifestId(packageId) {
  return parseNamespacedPackageId(packageId).packageId;
}

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

// Suite Manager re-verifies snapshot identity and digest on every read, so it
// reads these files directly and needs group read on everything the root agent
// writes here. The package root is provisioned `root:mos-agent` mode 0750
// and the modes below grant the group read without write, but a directory root
// creates does not inherit that group unless its parent carries the setgid bit
// — and a root recreated by a restore may have lost the bit and the group
// entirely. Take the group from the package root itself rather than a hardcoded
// name, and apply it explicitly so a snapshot is readable whatever state the
// parent was left in. Owner is preserved: only the group moves.
async function applyAgentGroup(root, gid) {
  const pending = [root];
  while (pending.length) {
    const entry = pending.pop();
    const stats = await fsp.lstat(entry);
    if (stats.isDirectory()) {
      for (const child of await fsp.readdir(entry)) pending.push(path.join(entry, child));
    }
    if (stats.gid !== gid) await fsp.chown(entry, stats.uid, gid);
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

// The only image names this agent will ever hand to `docker image rm`. Both the
// names it derives and the names it reads back from disk go through here, so a
// tampered sidecar or an odd manifest version cannot widen a reclamation into
// some unrelated image on the host.
const RECLAIMABLE_IMAGE_PATTERN = /^mos-app-[a-z0-9][a-z0-9-]{0,130}:[0-9A-Za-z.-]{1,48}-pkg-[a-f0-9]{12}-src-[a-f0-9]{12}$/u;

// Name every image built for a package snapshot. The manifest must be one this
// caller has already verified against its digest, because it is what decides
// which images are claimed to be superseded.
function packageImageTags({ manifest, packageDigest, packageId, sourceRevision }) {
  const services = manifest?.resources?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return [];
  return Object.keys(services)
    .map((serviceId) => packageImageTag({ packageDigest, packageId, packageVersion: String(manifest.version), serviceId, sourceRevision }))
    .filter((imageTag) => RECLAIMABLE_IMAGE_PATTERN.test(imageTag));
}

// Image tags belonging to the snapshot currently kept in `previous`. A snapshot
// alone cannot name its own images once the instance row has moved on: the tag
// needs the source revision, which is deliberately not part of the digested
// package. Recording them at promote is what keeps a rollback-safe app's images
// bounded to the one retained generation instead of one per update forever.
async function readRetainedImageTags(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!Array.isArray(parsed?.imageTags)) return [];
    return parsed.imageTags.filter((imageTag) => RECLAIMABLE_IMAGE_PATTERN.test(String(imageTag)));
  } catch {
    return [];
  }
}

function renderAppRouteBlock(packageId, caddyRoutes) {
  return `# mos-app-route:start ${packageId}\n${String(caddyRoutes).trimEnd()}\n# mos-app-route:end ${packageId}\n`;
}

function upsertAppRouteBlock(currentRoutes, { caddyRoutes, packageId }) {
  const block = renderAppRouteBlock(packageId, caddyRoutes);
  const current = typeof currentRoutes === 'string' ? currentRoutes : EMPTY_APP_ROUTES;
  const markerPattern = new RegExp(
    `# mos-app-route:start ${packageId}\\n[\\s\\S]*?# mos-app-route:end ${packageId}\\n?`,
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
    `# mos-app-route:start ${packageId}\\n[\\s\\S]*?# mos-app-route:end ${packageId}\\n?`,
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

  // Called with the instance root rather than the snapshot itself, so the
  // directory the snapshot sits in is reachable too: a readable snapshot under
  // a root-only parent is still unreadable. Never fails an operation — a
  // package root left without the agent group is a provisioning fault that
  // Suite Manager reports as a snapshot it cannot read, which is the truth, and
  // is worth more than refusing an otherwise-complete install here.
  async applySnapshotGroup(instanceRoot) {
    try {
      const { gid } = await fsp.stat(this.appPackageRoot);
      await applyAgentGroup(instanceRoot, gid);
    } catch {
      // Intentionally ignored; see above.
    }
  }

  containerName(packageId, serviceId, serviceCount) {
    return serviceCount === 1 ? `mos-app-${packageId}` : `mos-app-${packageId}-${serviceId}`;
  }

  networkName(packageId) {
    return `mos-app-${packageId}`;
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
      await this.applySnapshotGroup(instanceRoot);
      await fsp.rename(temporary, installed);
      return { snapshotPath: installed, steps: ['validated', 'copied', 'verified', 'promoted'] };
    } catch (error) {
      await fsp.rm(temporary, { force: true, recursive: true }).catch(() => {});
      const failure = new AppApplyError('snapshot');
      failure.details = error?.details || [String(error?.message || 'snapshot failed')];
      throw failure;
    }
  }

  // Install-time snapshot for a package that does not live in the repository
  // checkout. The source is a downloaded candidate rather than `appsRoot`, so it
  // is only trusted when it is confined to the host-owned candidate root and its
  // contents hash to the digest Suite Manager already validated.
  //
  // The agent independently enforces the namespacing rule: a candidate snapshot
  // must be installed under an `x-<namespace>-<manifest id>` package id whose
  // suffix is the package's own manifest id. A non-repository package therefore
  // cannot occupy an official package's identity even if Suite Manager asked it
  // to, because every runtime name derives from this package id.
  async snapshotExternalAppPackage({ candidateDigest, candidatePath, instanceId, packageId }) {
    // Lexical confinement alone can be bypassed by a symlink placed beneath
    // the Suite-Manager-writable candidate root. Compare canonical filesystem
    // paths before the privileged agent reads any package-controlled file.
    const candidateRoot = await fsp.realpath(path.resolve(this.appCandidateRoot));
    const source = await fsp.realpath(path.resolve(candidatePath));
    const relativeSource = path.relative(candidateRoot, source);
    const instanceRoot = path.join(this.appPackageRoot, instanceId);
    const installed = path.join(instanceRoot, 'installed');
    const temporary = path.join(instanceRoot, `.snapshot-${crypto.randomUUID()}`);
    try {
      if (!relativeSource || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) throw new Error('CANDIDATE_PATH_OUTSIDE_ROOT');
      const identity = parseNamespacedPackageId(packageId);
      if (!identity.namespaced) throw new Error('EXTERNAL_PACKAGE_ID_NOT_NAMESPACED');
      const manifest = JSON.parse(await fsp.readFile(path.join(source, 'manifest.json'), 'utf8'));
      if (manifest.id !== identity.packageId) throw new Error('EXTERNAL_PACKAGE_ID_MISMATCH');
      if (digestAppPackage(source, { manifest }) !== candidateDigest) throw new Error('PACKAGE_DIGEST_MISMATCH');
      if (fs.existsSync(installed)) throw new Error('INSTALLED_SNAPSHOT_EXISTS');

      await fsp.mkdir(temporary, { recursive: true, mode: 0o750 });
      for (const file of collectPackageFiles(source, { manifest })) {
        const target = path.join(temporary, ...file.relativePath.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
        await fsp.copyFile(file.absolutePath, target);
        const sourceMode = (await fsp.stat(file.absolutePath)).mode;
        await fsp.chmod(target, sourceMode & 0o111 ? 0o750 : 0o640);
      }
      if (digestAppPackage(temporary, { manifest }) !== candidateDigest) throw new Error('COPIED_PACKAGE_DIGEST_MISMATCH');
      await this.applySnapshotGroup(instanceRoot);
      await fsp.rename(temporary, installed);
      return { snapshotPath: installed, steps: ['candidate-confined', 'identity-verified', 'validated', 'copied', 'verified', 'promoted'] };
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
      verifySnapshotIdentity(installed, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: expectedInstalledDigest, packageId });
      const candidateManifest = verifySnapshotIdentity(source, { errorMessage: 'CANDIDATE_PACKAGE_CHANGED', expectedDigest: candidateDigest, packageId });
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
      await this.applySnapshotGroup(instanceRoot);
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
      verifySnapshotIdentity(installed, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: expectedInstalledDigest, packageId });
      verifySnapshotIdentity(candidate, { errorMessage: 'CANDIDATE_PACKAGE_CHANGED', expectedDigest: candidateDigest, packageId });
      for (const service of services) {
        await this.execute(this.dockerBinary, [
          'build', '--file', service.dockerfile, '--tag', service.imageTag,
          '--label', `mos.package=${packageId}`,
          '--label', `mos.package-version=${packageVersion}`,
          '--label', `mos.package-digest=${candidateDigest}`,
          '--label', `mos.source-revision=${sourceRevision}`,
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
        if (separator > 0) volumeArgs.push('--volume', `mos-app-${packageId}-${String(volume).slice(0, separator)}:${String(volume).slice(separator + 1)}`);
      }
      await this.execute(this.dockerBinary, [
        'run', '--detach', '--name', this.containerName(packageId, service.id, serviceCount), '--restart', 'unless-stopped',
        ...(serviceCount > 1 ? ['--network', networkName, '--network-alias', service.id] : []),
        ...(service.public ? ['--publish', `127.0.0.1:${service.loopbackPort}:${service.internalPort}`] : []),
        '--label', `mos.package=${packageId}`,
        '--label', `mos.service=${service.id}`,
        '--label', `mos.package-version=${packageVersion}`,
        '--label', `mos.package-digest=${packageDigest}`,
        '--label', `mos.source-revision=${sourceRevision}`,
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
      verifySnapshotIdentity(installedDir, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: installed.packageDigest, packageId: installed.packageId });
      verifySnapshotIdentity(candidateDir, { errorMessage: 'CANDIDATE_PACKAGE_CHANGED', expectedDigest: candidate.packageDigest, packageId: candidate.packageId });

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
        try {
          await fsp.writeFile(routeCandidate, nextRoutes);
          await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', routeCandidate], { timeoutMs: 20000 });
        } finally {
          await fsp.rm(routeCandidate, { force: true }).catch(() => {});
        }
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

  // Undo a promotion a crash interrupted between its two renames. The displaced
  // snapshot still sitting under its deterministic name means the promotion
  // never returned, so Suite Manager still records the old digest; reverting
  // the swap is the only repair that makes disk match that record again, and it
  // is what lets a retried promote or a rollback verify and proceed. Each
  // branch is itself crash-safe: every intermediate state maps back onto one of
  // these branches on the next run.
  async repairInterruptedPromotion(instanceRoot) {
    const displaced = path.join(instanceRoot, DISPLACED_INSTALLED_DIR);
    if (!fs.existsSync(displaced)) return false;
    const installed = path.join(instanceRoot, 'installed');
    const candidate = path.join(instanceRoot, 'candidate');
    if (fs.existsSync(installed)) {
      // All three directories at once is not a state the promotion sequence can
      // produce; repair nothing rather than guess which snapshot to discard.
      if (fs.existsSync(candidate)) return false;
      await fsp.rename(installed, candidate);
    }
    await fsp.rename(displaced, installed);
    return true;
  }

  // Startup sweep: repair every instance a crash left mid-promotion, so a
  // half-swapped app is already whole again before any request can reach it.
  async sweepInterruptedPromotions() {
    let entries = [];
    try { entries = await fsp.readdir(this.appPackageRoot, { withFileTypes: true }); } catch { return 0; }
    let repaired = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await this.repairInterruptedPromotion(path.join(this.appPackageRoot, entry.name)).catch(() => false)) repaired += 1;
    }
    return repaired;
  }

  async promoteAppPackageUpdate({ candidateDigest, expectedInstalledDigest, installedSourceRevision, instanceId, packageId, rollbackSafe }) {
    const instanceRoot = path.join(this.appPackageRoot, instanceId);
    const installed = path.join(instanceRoot, 'installed');
    const candidate = path.join(instanceRoot, 'candidate');
    const previous = path.join(instanceRoot, 'previous');
    const previousImages = path.join(instanceRoot, 'previous-images.json');
    const displaced = path.join(instanceRoot, DISPLACED_INSTALLED_DIR);
    try {
      await this.repairInterruptedPromotion(instanceRoot).catch(() => {});
      const installedManifest = verifySnapshotIdentity(installed, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: expectedInstalledDigest, packageId });
      verifySnapshotIdentity(candidate, { errorMessage: 'CANDIDATE_PACKAGE_CHANGED', expectedDigest: candidateDigest, packageId });
      // Named from the manifest the digest check above just proved, so the caller
      // cannot widen a reclamation by describing the outgoing package as
      // something other than what is actually on disk. An older Suite Manager
      // sends no revision, and then nothing is reclaimed.
      const superseded = installedSourceRevision
        ? packageImageTags({ manifest: installedManifest, packageDigest: expectedInstalledDigest, packageId, sourceRevision: installedSourceRevision })
        : [];
      const evicted = await readRetainedImageTags(previousImages);
      await fsp.rm(displaced, { force: true, recursive: true });
      await fsp.rename(installed, displaced);
      try { await fsp.rename(candidate, installed); }
      catch (error) { await fsp.rename(displaced, installed).catch(() => {}); throw error; }
      await fsp.rm(previous, { force: true, recursive: true });
      await fsp.rm(previousImages, { force: true });
      if (rollbackSafe) {
        await fsp.rename(displaced, previous);
        if (superseded.length) await atomicWrite(previousImages, `${JSON.stringify({ imageTags: superseded })}\n`, 0o640);
      } else {
        await fsp.rm(displaced, { force: true, recursive: true });
      }
      // Reclaim the images of every snapshot no longer reachable: the one just
      // evicted from `previous`, plus the outgoing one unless it is being kept
      // for rollback. This runs after the swap because the update is already
      // committed by then, and freeing disk must never be able to undo it.
      const imagesReclaimed = await this.reclaimImages([...evicted, ...(rollbackSafe ? [] : superseded)]);
      return { imagesReclaimed, previousRetained: rollbackSafe, snapshotPath: installed, steps: ['installed-identity-verified', 'candidate-identity-verified', 'snapshot-promoted', ...(rollbackSafe ? ['previous-retained'] : []), ...(imagesReclaimed ? ['superseded-images-reclaimed'] : [])] };
    } catch (error) {
      const failure = new AppApplyError('snapshot');
      failure.code = ['INSTALLED_PACKAGE_CHANGED', 'CANDIDATE_PACKAGE_CHANGED'].includes(error?.message) ? 'APP_UPDATE_IDENTITY_CHANGED' : 'APP_UPDATE_PROMOTION_FAILED';
      failure.statusCode = failure.code === 'APP_UPDATE_IDENTITY_CHANGED' ? 409 : 502;
      failure.details = [String(error?.message || 'snapshot promotion failed')];
      throw failure;
    }
  }

  // Remove images no snapshot refers to any more. Deliberately without --force:
  // an image a container still references must stay, and docker refusing is a
  // better check than one this agent would have to make for itself. Every
  // failure is ignored for the same reason — an image that cannot be removed is
  // wasted disk, never a reason to fail an update that already succeeded.
  async reclaimImages(imageTags) {
    let reclaimed = 0;
    for (const imageTag of imageTags) {
      if (!RECLAIMABLE_IMAGE_PATTERN.test(String(imageTag))) continue;
      const removed = await this.execute(this.dockerBinary, ['image', 'rm', imageTag], { timeoutMs: 60000 }).then(() => true, () => false);
      if (removed) reclaimed += 1;
    }
    return reclaimed;
  }

  async rollbackAppPackageUpdate({ candidate, installed }) {
    const instanceRoot = path.join(this.appPackageRoot, installed.instanceId);
    const installedDir = path.join(instanceRoot, 'installed');
    const candidateDir = path.join(instanceRoot, 'candidate');
    try {
      await this.repairInterruptedPromotion(instanceRoot).catch(() => {});
      verifySnapshotIdentity(installedDir, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: installed.packageDigest, packageId: installed.packageId });
      verifySnapshotIdentity(candidateDir, { errorMessage: 'CANDIDATE_PACKAGE_CHANGED', expectedDigest: candidate.packageDigest, packageId: candidate.packageId });
      await this.removePackageContainers({ packageId: candidate.packageId, serviceIds: candidate.services.map((service) => service.id), serviceCount: candidate.services.length });
      await this.startPackageContainers(installed);
      await this.waitForReady(installed.healthTarget);
      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      const nextRoutes = upsertAppRouteBlock(currentRoutes, { caddyRoutes: installed.caddyRoutes, packageId: installed.packageId });
      if (currentRoutes !== nextRoutes) {
        const routeCandidate = `${this.routesPath}.rollback-${process.pid}`;
        await fsp.writeFile(routeCandidate, nextRoutes);
        await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', routeCandidate], { timeoutMs: 20000 });
        await fsp.rm(routeCandidate, { force: true }).catch(() => {});
        await atomicWrite(this.routesPath, nextRoutes);
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
      }
      // The candidate this rollback abandoned never became installed, and the
      // old runtime is serving again, so nothing refers to the images built for
      // it. A retry rebuilds them from the same cached layers.
      const imagesReclaimed = await this.reclaimImages(candidate.services.map((service) => service.imageTag));
      return { imagesReclaimed, steps: ['candidate-runtime-stopped', 'installed-runtime-started', 'installed-runtime-healthy', 'installed-route-restored', ...(imagesReclaimed ? ['candidate-images-reclaimed'] : [])] };
    } catch (error) {
      const failure = new AppApplyError('run');
      failure.code = 'APP_UPDATE_ROLLBACK_FAILED';
      failure.details = [String(error?.message || 'old runtime restore failed')];
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
      verifySnapshotIdentity(packageDir, { errorMessage: 'PACKAGE_SNAPSHOT_MISMATCH', expectedDigest: packageDigest, packageId });
      const serviceCount = services.length;
      for (const service of services) {
        await this.execute(this.dockerBinary, [
          'build',
          '--file', service.dockerfile,
          '--tag', service.imageTag,
          '--label', `mos.package=${packageId}`,
          '--label', `mos.package-version=${packageVersion}`,
          '--label', `mos.package-digest=${packageDigest}`,
          '--label', `mos.source-revision=${sourceRevision}`,
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
            volumeArgs.push('--volume', `mos-app-${packageId}-${String(volume).slice(0, separator)}:${String(volume).slice(separator + 1)}`);
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
          '--label', `mos.package=${packageId}`,
          '--label', `mos.service=${service.id}`,
          '--label', `mos.package-version=${packageVersion}`,
          '--label', `mos.package-digest=${packageDigest}`,
          '--label', `mos.source-revision=${sourceRevision}`,
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
        try {
          await fsp.writeFile(candidate, nextRoutes);
          await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', candidate], { timeoutMs: 20000 });
        } finally {
          await fsp.rm(candidate, { force: true }).catch(() => {});
        }
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
      await this.execute(this.dockerBinary, ['rm', '-f', `mos-app-${packageId}`], { timeoutMs: 30000 }).catch(() => {});
      for (const serviceId of serviceIds) {
        await this.execute(this.dockerBinary, ['rm', '-f', `mos-app-${packageId}-${serviceId}`], { timeoutMs: 30000 }).catch(() => {});
      }
      await this.execute(this.dockerBinary, ['network', 'rm', this.networkName(packageId)], { timeoutMs: 30000 }).catch(() => {});
      return { steps: ['stopped'] };
    } catch {
      throw new AppApplyError('stop');
    }
  }

  // Everything an uninstalled app leaves behind on disk. The instance row is
  // deleted as soon as this returns, taking with it the only reference to this
  // directory and to the revision that names the images built from it, so
  // whatever is not reclaimed here is unreachable for good. An older Suite
  // Manager names no instance, and then this is skipped entirely.
  async discardInstanceSnapshot({ installedSourceRevision, instanceId, packageId }) {
    if (!instanceId) return { imagesReclaimed: 0, snapshotRemoved: false };
    const instanceRoot = path.join(this.appPackageRoot, instanceId);
    const installed = path.join(instanceRoot, 'installed');
    let superseded = [];
    if (installedSourceRevision) {
      try {
        // Named from the snapshot on disk and digested here rather than taken
        // from the caller: a package that is not the one this instance installed
        // yields tags that name nothing, and nothing is reclaimed.
        const manifest = JSON.parse(await fsp.readFile(path.join(installed, 'manifest.json'), 'utf8'));
        if (manifest.id === expectedManifestId(packageId)) {
          superseded = packageImageTags({ manifest, packageDigest: digestAppPackage(installed, { manifest }), packageId, sourceRevision: installedSourceRevision });
        }
      } catch {
        superseded = [];
      }
    }
    const retained = await readRetainedImageTags(path.join(instanceRoot, 'previous-images.json'));
    const imagesReclaimed = await this.reclaimImages([...superseded, ...retained]);
    const snapshotRemoved = await fsp.rm(instanceRoot, { force: true, recursive: true }).then(() => true, () => false);
    return { imagesReclaimed, snapshotRemoved };
  }

  async removeAppService({ installedSourceRevision, instanceId, packageId, serviceIds = [], volumes = [] }) {
    const routeSnapshot = `${this.routesPath}.before-${process.pid}`;
    let routesChanged = false;
    try {
      await this.execute(this.dockerBinary, ['rm', '-f', `mos-app-${packageId}`], { timeoutMs: 30000 }).catch(() => {});
      for (const serviceId of serviceIds) {
        await this.execute(this.dockerBinary, ['rm', '-f', `mos-app-${packageId}-${serviceId}`], { timeoutMs: 30000 }).catch(() => {});
      }
      await this.execute(this.dockerBinary, ['network', 'rm', this.networkName(packageId)], { timeoutMs: 30000 }).catch(() => {});
      for (const volume of volumes) {
        const volumeName = `mos-app-${packageId}-${volume}`;
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
        try {
          await fsp.writeFile(candidate, nextRoutes);
          await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', candidate], { timeoutMs: 20000 });
        } finally {
          await fsp.rm(candidate, { force: true }).catch(() => {});
        }
        await snapshot(this.routesPath, routeSnapshot);
        await atomicWrite(this.routesPath, nextRoutes);
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
        await fsp.rm(routeSnapshot, { force: true }).catch(() => {});
        await fsp.rm(`${routeSnapshot}.missing`, { force: true }).catch(() => {});
      }

      // Last, and unable to fail the uninstall: the containers, volumes, and
      // route are already gone by this point, so reporting a failure here would
      // describe an app that no longer exists as still installed.
      const { imagesReclaimed, snapshotRemoved } = await this.discardInstanceSnapshot({ installedSourceRevision, instanceId, packageId })
        .catch(() => ({ imagesReclaimed: 0, snapshotRemoved: false }));
      return {
        imagesReclaimed,
        steps: [
          'stopped',
          ...(volumes.length ? ['volumes-removed'] : []),
          ...(routesChanged ? ['route-removed', 'caddy-reloaded'] : []),
          ...(imagesReclaimed ? ['images-reclaimed'] : []),
          ...(snapshotRemoved ? ['snapshot-removed'] : []),
        ],
      };
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
  DISPLACED_INSTALLED_DIR,
  HEALTH_REFRESH_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  SystemAppAdapter,
  atomicWrite,
  removeAppRouteBlock,
  renderAppRouteBlock,
  upsertAppRouteBlock,
  waitForHttp,
};
