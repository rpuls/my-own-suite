const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { packageImageTag } = require('./agent-core.cjs');
const { appVolumeLabels, appVolumeName, OWNERSHIP_LABELS } = require('../../infrastructure/persistent-state.cjs');
const { collectPackageFiles, digestAppPackage, parseNamespacedPackageId, verifySnapshotIdentity } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { describeDuration, describeFailure, indent, maskValues, runCommand, tailOutput } = require('../lib/command-output.cjs');

const APPS_ROOT = process.env.MOS_APPS_ROOT || path.resolve(process.cwd(), 'apps');
const APP_PACKAGE_ROOT = process.env.MOS_APP_PACKAGE_ROOT || '/var/lib/mos/app-packages';
const APP_CANDIDATE_ROOT = process.env.MOS_APP_CANDIDATE_ROOT || '/var/lib/mos/suite-manager/app-candidates';
const APP_ROUTES_PATH = process.env.MOS_APP_ROUTES_PATH || '/etc/caddy/mos-app-routes.caddy';
const CADDY_BINARY = process.env.MOS_CADDY_BINARY || '/usr/local/libexec/mos/caddy';
const DOCKER_BINARY = process.env.MOS_DOCKER_BINARY || '/usr/bin/docker';
// Docker's json-file driver is unbounded by default, so an app that logs on a
// loop fills the root disk and takes the whole suite down with it — MOS, every
// other app, and the backup that would have recovered it. Per container rather
// than a daemon-wide default in daemon.json, because changing that needs a
// docker restart, which stops every running app: this applies to each container
// as it is created, and an existing one picks it up the next time its app is
// applied or updated. 30 MB is three files of 10, which is enough history to
// diagnose a crash loop and small enough that fifty containers cannot fill a
// modest disk.
const CONTAINER_LOG_ARGS = ['--log-opt', 'max-size=10m', '--log-opt', 'max-file=3'];
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_REFRESH_TIMEOUT_MS = 5_000;
// What a failure report quotes from each container's own log. A crash loop
// prints its reason in its last few lines; the full log stays in the
// diagnostics bundle.
const CONTAINER_LOG_TAIL_LINES = 25;
const CONTAINER_LOG_TAIL_CHARS = 2_500;
// Environment values this agent put on a container's command line and can
// therefore recognise in whatever echoes them back. Chosen by key shape: the
// agent is not told which values Suite Manager holds as secrets, and masking
// every value would hide the NODE_ENV=production that explains a failure.
// Suite Manager masks again, by exact value against its full secret set.
const SECRET_SHAPED_KEY = /PASS|SECRET|TOKEN|KEY|CREDENTIAL|SALT|PRIVATE/iu;
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
  'stale-volume': ['APP_VOLUME_STALE', 'Persistent data from a different installation of this app is still present. Remove or restore it before installing.'],
  stop: ['APP_RUNTIME_STOP_FAILED', 'The app runtime could not be stopped.'],
  writing: ['APP_ROUTE_WRITE_FAILED', 'The app route could not be installed.'],
};

// How a failure report names the command that failed. The command line itself
// never appears in a report, so this is the only name it gets.
const STAGE_ACTIVITY = {
  build: 'docker build',
  'caddy-reload': 'reloading Caddy',
  'caddy-validation': 'caddy validate for the new app route',
  health: 'the health check',
  network: 'docker network connect',
  remove: 'removing the app runtime',
  run: 'docker run',
  snapshot: 'snapshotting the package',
  stop: 'stopping the app runtime',
  writing: 'writing the app route',
};

// `details` carries what the agent can say about why: command output, never
// a command line (see ../lib/command-output.cjs). The message stays fixed per
// stage so it is safe to log anywhere.
class AppApplyError extends Error {
  constructor(stage, details = []) {
    const [code, message] = FAILURE_MESSAGES[stage] || ['APP_RUNTIME_APPLY_FAILED', 'The app runtime operation failed.'];
    super(message);
    this.code = code;
    this.details = details;
    this.statusCode = 502;
  }
}

function environmentSecrets(services = []) {
  return services.flatMap((service) => Object.entries(service.environment || {})
    .filter(([key]) => SECRET_SHAPED_KEY.test(key))
    .map(([, value]) => String(value)));
}

// A container's state in the words an owner would use, from the State object
// `docker inspect` reports.
function describeContainerState(state) {
  if (!state) return 'is not present';
  const parts = [];
  if (state.Status === 'running') parts.push(state.Health?.Status ? `is running, health ${state.Health.Status}` : 'is running');
  else if (state.Status === 'exited') parts.push(`exited with code ${state.ExitCode}`);
  else if (state.Status === 'restarting') parts.push(`keeps restarting, last exit code ${state.ExitCode}`);
  else parts.push(`is ${state.Status || 'in an unknown state'}`);
  if (state.OOMKilled) parts.push('was killed for running out of memory');
  if (state.Error) parts.push(`reported: ${state.Error}`);
  return parts.join(', ');
}

// The health probe's own verdict, in one line.
function describeProbe(error, healthTarget) {
  if (error?.message !== 'HEALTH_TIMEOUT') return String(error?.message || 'The health check failed.');
  return `No healthy answer from ${healthTarget} in ${describeDuration(error.waitedMs || HEALTH_TIMEOUT_MS)}; the last probe got: ${error.lastProbe || 'no answer'}.`;
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

function exec(file, args, options = {}) {
  return runCommand(file, args, options);
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

// Rejects with what the last probe saw on `lastProbe`: a connection refused
// and an HTTP 503 are different failures with different fixes.
function waitForHttp(url, { deadlineMs = HEALTH_TIMEOUT_MS } = {}) {
  const started = Date.now();
  let lastProbe = 'no answer';
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, { timeout: 3000 }, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 500) {
          resolve();
          return;
        }
        lastProbe = `HTTP ${response.statusCode}`;
        retry();
      });
      request.on('timeout', () => request.destroy(new Error('TIMEOUT')));
      request.on('error', (error) => {
        lastProbe = error?.message === 'TIMEOUT' ? 'no reply within 3s' : String(error?.code || error?.message || 'connection failed');
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started >= deadlineMs) {
        const failure = new Error('HEALTH_TIMEOUT');
        failure.lastProbe = lastProbe;
        failure.waitedMs = Date.now() - started;
        reject(failure);
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
    executeCapture = undefined,
    routesPath = APP_ROUTES_PATH,
    waitForReady = waitForHttp,
  } = {}) {
    this.appsRoot = appsRoot;
    this.appCandidateRoot = appCandidateRoot;
    this.appPackageRoot = appPackageRoot;
    this.caddyBinary = caddyBinary;
    this.dockerBinary = dockerBinary;
    this.execute = execute;
    // Derived from the plain runner rather than defaulted to the real system,
    // so a harness that stubs only `execute` sees the explicit labeled
    // `volume create` instead of this adapter reaching around the stub to the
    // machine it runs on: a stub that returns nothing reports every volume absent.
    this.executeCapture = executeCapture || (async (file, args, options) => {
      const result = await this.execute(file, args, options);
      if (typeof result?.stdout !== 'string') throw new Error('COMMAND_FAILED');
      return result.stdout;
    });
    this.routesPath = routesPath;
    this.waitForReady = waitForReady;
  }

  async appVolumeState(name) {
    try {
      const output = await this.executeCapture(this.dockerBinary, ['volume', 'inspect', '--format', '{{json .Labels}}', name], { timeoutMs: 30000 });
      return { exists: true, labels: JSON.parse(String(output || '').trim() || 'null') || {} };
    } catch {
      return { exists: false, labels: {} };
    }
  }

  // Volumes are created explicitly before `docker run` can create them as a
  // side effect, so every MOS-owned volume carries its ownership labels from
  // birth. An existing volume bound to a different installation is the false-
  // restore failure mode — fresh credentials over another installation's data
  // — and must refuse loudly instead of silently adopting that data. Volumes
  // created before labeling existed carry no binding and stay accepted.
  async ensureAppVolumes({ instanceId, packageId, services }) {
    const names = new Set();
    for (const service of services) {
      for (const volume of service.volumes || []) {
        const separator = String(volume).indexOf(':');
        if (separator > 0) names.add(appVolumeName(packageId, String(volume).slice(0, separator)));
      }
    }
    for (const name of names) {
      const state = await this.appVolumeState(name);
      if (!state.exists) {
        const labels = appVolumeLabels({ instanceId, name, packageId });
        await this.execute(this.dockerBinary, [
          'volume', 'create',
          ...Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          name,
        ], { timeoutMs: 30000 });
        continue;
      }
      const boundInstance = state.labels[OWNERSHIP_LABELS.instance];
      if (boundInstance && instanceId && boundInstance !== instanceId) {
        throw new AppApplyError('stale-volume');
      }
    }
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
    let activity = STAGE_ACTIVITY.build;
    try {
      verifySnapshotIdentity(installed, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: expectedInstalledDigest, packageId });
      verifySnapshotIdentity(candidate, { errorMessage: 'CANDIDATE_PACKAGE_CHANGED', expectedDigest: candidateDigest, packageId });
      for (const service of services) {
        activity = `docker build for service "${service.id}"`;
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
      const failure = new AppApplyError('build', describeFailure(error, activity));
      failure.code = ['INSTALLED_PACKAGE_CHANGED', 'CANDIDATE_PACKAGE_CHANGED'].includes(error?.message) ? 'APP_UPDATE_IDENTITY_CHANGED' : failure.code;
      failure.statusCode = failure.code === 'APP_UPDATE_IDENTITY_CHANGED' ? 409 : failure.statusCode;
      throw failure;
    }
  }

  async startPackageContainers({ instanceId, packageDigest, packageId, packageVersion, services, sourceRevision }) {
    const serviceCount = services.length;
    const networkName = this.networkName(packageId);
    if (serviceCount > 1) {
      await this.execute(this.dockerBinary, ['network', 'create', networkName], { timeoutMs: 30000 }).catch(() => {});
    }
    await this.ensureAppVolumes({ instanceId, packageId, services });
    for (const service of services) {
      const volumeArgs = [];
      for (const volume of service.volumes || []) {
        const separator = String(volume).indexOf(':');
        if (separator > 0) volumeArgs.push('--volume', `${appVolumeName(packageId, String(volume).slice(0, separator))}:${String(volume).slice(separator + 1)}`);
      }
      await this.execute(this.dockerBinary, [
        'run', '--detach', '--name', this.containerName(packageId, service.id, serviceCount), '--restart', 'unless-stopped',
        ...CONTAINER_LOG_ARGS,
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
      ], { mask: environmentSecrets([service]), timeoutMs: 60000 }).catch((error) => {
        throw error instanceof AppApplyError ? error : new AppApplyError('run', describeFailure(error, `docker run for service "${service.id}"`));
      });
    }
  }

  // What the agent can say about why a step failed, for a failure's details.
  // A health timeout is the one failure where nothing exited non-zero, so it
  // is explained from the containers' own state and last log lines instead.
  async explainFailure(error, { activity, runtime = null, stage }) {
    if (error instanceof AppApplyError) return error.details;
    if (stage === 'health' && runtime) {
      return [describeProbe(error, runtime.healthTarget), ...await this.describeContainers(runtime)];
    }
    return describeFailure(error, activity || STAGE_ACTIVITY[stage] || 'the operation');
  }

  // Each container's state and last log lines, best effort: a container that
  // never started has nothing to inspect, and that is itself the finding.
  async describeContainers({ packageId, services }) {
    const mask = environmentSecrets(services);
    const details = [];
    for (const service of services) {
      const name = this.containerName(packageId, service.id, services.length);
      const state = await this.execute(this.dockerBinary, ['inspect', '--format', '{{json .State}}', name], { timeoutMs: 10_000 })
        .then((result) => JSON.parse(String(result?.stdout || '').trim() || 'null'))
        .catch(() => null);
      const logs = await this.execute(this.dockerBinary, ['logs', '--tail', String(CONTAINER_LOG_TAIL_LINES), name], { mask, timeoutMs: 10_000 })
        .then((result) => tailOutput(result?.output || '', { chars: CONTAINER_LOG_TAIL_CHARS, lines: CONTAINER_LOG_TAIL_LINES }))
        .catch(() => '');
      const header = maskValues(`Container ${name} ${describeContainerState(state)}.`, mask);
      details.push(logs ? `${header}\nIts last log lines:\n${indent(logs)}` : `${header}\nIt has written no log lines.`);
    }
    return details;
  }

  async activateAppPackageUpdate({ candidate, installed }) {
    const instanceRoot = path.join(this.appPackageRoot, candidate.instanceId);
    const installedDir = path.join(instanceRoot, 'installed');
    const candidateDir = path.join(instanceRoot, 'candidate');
    const routeSnapshot = `${this.routesPath}.before-update-${process.pid}`;
    let routesChanged = false;
    let candidateStarted = false;
    let oldRuntimeStopped = false;
    let stage = 'snapshot';
    try {
      verifySnapshotIdentity(installedDir, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: installed.packageDigest, packageId: installed.packageId });
      verifySnapshotIdentity(candidateDir, { errorMessage: 'CANDIDATE_PACKAGE_CHANGED', expectedDigest: candidate.packageDigest, packageId: candidate.packageId });

      stage = 'stop';
      await this.removePackageContainers({ packageId: installed.packageId, serviceIds: installed.services.map((service) => service.id), serviceCount: installed.services.length });
      oldRuntimeStopped = true;
      candidateStarted = true;
      stage = 'run';
      await this.startPackageContainers(candidate);
      stage = 'health';
      await this.waitForReady(candidate.healthTarget);

      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      const nextRoutes = upsertAppRouteBlock(currentRoutes, { caddyRoutes: candidate.caddyRoutes, packageId: candidate.packageId });
      routesChanged = currentRoutes !== nextRoutes;
      if (routesChanged) {
        stage = 'caddy-validation';
        const routeCandidate = `${this.routesPath}.candidate-${process.pid}`;
        try {
          await fsp.writeFile(routeCandidate, nextRoutes);
          await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', routeCandidate], { timeoutMs: 20000 });
        } finally {
          await fsp.rm(routeCandidate, { force: true }).catch(() => {});
        }
        await snapshot(this.routesPath, routeSnapshot);
        stage = 'writing';
        await atomicWrite(this.routesPath, nextRoutes);
        stage = 'caddy-reload';
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
      }
      return { steps: ['installed-identity-verified', 'candidate-identity-verified', 'old-runtime-stopped', 'candidate-started', 'candidate-healthy', ...(routesChanged ? ['route-written', 'caddy-reloaded'] : [])] };
    } catch (error) {
      // Explained before the candidate is torn down: its containers are the
      // evidence, and the rollback below removes them.
      const explanation = await this.explainFailure(error, { runtime: candidate, stage });
      if (routesChanged) {
        await restore(routeSnapshot, this.routesPath).catch(() => {});
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 10000 }).catch(() => {});
      }
      if (!oldRuntimeStopped) {
        const failure = new AppApplyError('snapshot', explanation);
        failure.code = 'APP_UPDATE_IDENTITY_CHANGED';
        failure.statusCode = 409;
        throw failure;
      }
      if (candidateStarted) await this.removePackageContainers({ packageId: candidate.packageId, serviceIds: candidate.services.map((service) => service.id), serviceCount: candidate.services.length }).catch(() => {});
      let restoring = 'run';
      try {
        await this.startPackageContainers(installed);
        restoring = 'health';
        await this.waitForReady(installed.healthTarget);
      } catch (rollbackError) {
        const failure = new AppApplyError('run', [
          ...explanation,
          'Restarting the previous version then failed too:',
          ...await this.explainFailure(rollbackError, { runtime: installed, stage: restoring }),
        ]);
        failure.code = 'APP_UPDATE_ROLLBACK_FAILED';
        throw failure;
      }
      const failure = new AppApplyError(error?.message === 'INSTALLED_PACKAGE_CHANGED' || error?.message === 'CANDIDATE_PACKAGE_CHANGED' ? 'snapshot' : 'run', [...explanation, 'The previous version was restarted and is running again.']);
      failure.code = ['INSTALLED_PACKAGE_CHANGED', 'CANDIDATE_PACKAGE_CHANGED'].includes(error?.message) ? 'APP_UPDATE_IDENTITY_CHANGED' : 'APP_UPDATE_ACTIVATION_FAILED';
      failure.statusCode = failure.code === 'APP_UPDATE_IDENTITY_CHANGED' ? 409 : 502;
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
    let stage = 'snapshot';
    try {
      await this.repairInterruptedPromotion(instanceRoot).catch(() => {});
      verifySnapshotIdentity(installedDir, { errorMessage: 'INSTALLED_PACKAGE_CHANGED', expectedDigest: installed.packageDigest, packageId: installed.packageId });
      verifySnapshotIdentity(candidateDir, { errorMessage: 'CANDIDATE_PACKAGE_CHANGED', expectedDigest: candidate.packageDigest, packageId: candidate.packageId });
      stage = 'stop';
      await this.removePackageContainers({ packageId: candidate.packageId, serviceIds: candidate.services.map((service) => service.id), serviceCount: candidate.services.length });
      stage = 'run';
      await this.startPackageContainers(installed);
      stage = 'health';
      await this.waitForReady(installed.healthTarget);
      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      const nextRoutes = upsertAppRouteBlock(currentRoutes, { caddyRoutes: installed.caddyRoutes, packageId: installed.packageId });
      if (currentRoutes !== nextRoutes) {
        stage = 'caddy-validation';
        const routeCandidate = `${this.routesPath}.rollback-${process.pid}`;
        await fsp.writeFile(routeCandidate, nextRoutes);
        await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', routeCandidate], { timeoutMs: 20000 });
        await fsp.rm(routeCandidate, { force: true }).catch(() => {});
        stage = 'writing';
        await atomicWrite(this.routesPath, nextRoutes);
        stage = 'caddy-reload';
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
      }
      // The candidate this rollback abandoned never became installed, and the
      // old runtime is serving again, so nothing refers to the images built for
      // it. A retry rebuilds them from the same cached layers.
      const imagesReclaimed = await this.reclaimImages(candidate.services.map((service) => service.imageTag));
      return { imagesReclaimed, steps: ['candidate-runtime-stopped', 'installed-runtime-started', 'installed-runtime-healthy', 'installed-route-restored', ...(imagesReclaimed ? ['candidate-images-reclaimed'] : [])] };
    } catch (error) {
      const failure = new AppApplyError('run', await this.explainFailure(error, { runtime: installed, stage }));
      failure.code = 'APP_UPDATE_ROLLBACK_FAILED';
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
    let activity = STAGE_ACTIVITY.build;

    try {
      verifySnapshotIdentity(packageDir, { errorMessage: 'PACKAGE_SNAPSHOT_MISMATCH', expectedDigest: packageDigest, packageId });
      const serviceCount = services.length;
      for (const service of services) {
        activity = `docker build for service "${service.id}"`;
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
      activity = STAGE_ACTIVITY.run;
      await this.removePackageContainers({ packageId, serviceIds: services.map((service) => service.id), serviceCount });
      const networkName = this.networkName(packageId);
      if (serviceCount > 1) {
        await this.execute(this.dockerBinary, ['network', 'create', networkName], { timeoutMs: 30000 }).catch(() => {});
      }

      await this.ensureAppVolumes({ instanceId, packageId, services });
      for (const service of services) {
        activity = `docker run for service "${service.id}"`;
        const volumeArgs = [];
        for (const volume of service.volumes || []) {
          const separator = String(volume).indexOf(':');
          if (separator > 0) {
            volumeArgs.push('--volume', `${appVolumeName(packageId, String(volume).slice(0, separator))}:${String(volume).slice(separator + 1)}`);
          }
        }
        const containerName = this.containerName(packageId, service.id, serviceCount);
        await this.execute(this.dockerBinary, [
          'run',
          '--detach',
          '--name', containerName,
          '--restart', 'unless-stopped',
          ...CONTAINER_LOG_ARGS,
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
        ], { mask: environmentSecrets([service]), timeoutMs: 60000 });
      }

      stage = 'health';
      activity = STAGE_ACTIVITY.health;
      await this.waitForReady(healthTarget);

      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      const nextRoutes = upsertAppRouteBlock(currentRoutes, { caddyRoutes, packageId });
      routesChanged = currentRoutes !== nextRoutes;
      if (routesChanged) {
        stage = 'caddy-validation';
        activity = STAGE_ACTIVITY[stage];
        const candidate = `${this.routesPath}.candidate-${process.pid}`;
        try {
          await fsp.writeFile(candidate, nextRoutes);
          await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', candidate], { timeoutMs: 20000 });
        } finally {
          await fsp.rm(candidate, { force: true }).catch(() => {});
        }
        await snapshot(this.routesPath, routeSnapshot);

        stage = 'writing';
        activity = STAGE_ACTIVITY[stage];
        await atomicWrite(this.routesPath, nextRoutes);

        stage = 'caddy-reload';
        activity = STAGE_ACTIVITY[stage];
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
        await fsp.rm(routeSnapshot, { force: true }).catch(() => {});
        await fsp.rm(`${routeSnapshot}.missing`, { force: true }).catch(() => {});
      }

      return { steps: ['built', 'started', 'healthy', ...(routesChanged ? ['route-written', 'caddy-reloaded'] : [])] };
    } catch (error) {
      const failure = error instanceof AppApplyError
        ? error
        : new AppApplyError(stage, await this.explainFailure(error, { activity, runtime: { healthTarget, packageId, services }, stage }));
      if (routesChanged) {
        await restore(routeSnapshot, this.routesPath).catch(() => {});
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 10000 }).catch(() => {});
      }
      throw failure;
    }
  }

  async checkAppHealth({ healthTarget }) {
    try {
      await this.waitForReady(healthTarget, { deadlineMs: HEALTH_REFRESH_TIMEOUT_MS });
      return { status: 'healthy' };
    } catch (error) {
      throw new AppApplyError('health', [describeProbe(error, healthTarget)]);
    }
  }

  async connectPackageNetwork({ consumerPackageId, providerPackageId, providerServiceCount, providerServices }) {
    const networkName = this.networkName(consumerPackageId);
    let activity = `docker network inspect for ${networkName}`;
    try {
      await this.execute(this.dockerBinary, ['network', 'inspect', networkName], { timeoutMs: 30000 });
      for (const serviceId of providerServices) {
        const containerName = this.containerName(providerPackageId, serviceId, providerServiceCount);
        const aliases = [...new Set([providerPackageId, serviceId])].flatMap((alias) => ['--alias', alias]);
        await this.execute(this.dockerBinary, ['network', 'disconnect', networkName, containerName], { timeoutMs: 30000 }).catch(() => {});
        activity = `docker network connect for ${containerName}`;
        await this.execute(this.dockerBinary, [
          'network',
          'connect',
          ...aliases,
          networkName,
          containerName,
        ], { timeoutMs: 30000 });
      }
      return { steps: ['network-connected'] };
    } catch (error) {
      throw new AppApplyError('network', describeFailure(error, activity));
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
    let activity = STAGE_ACTIVITY.remove;
    try {
      await this.execute(this.dockerBinary, ['rm', '-f', `mos-app-${packageId}`], { timeoutMs: 30000 }).catch(() => {});
      for (const serviceId of serviceIds) {
        await this.execute(this.dockerBinary, ['rm', '-f', `mos-app-${packageId}-${serviceId}`], { timeoutMs: 30000 }).catch(() => {});
      }
      await this.execute(this.dockerBinary, ['network', 'rm', this.networkName(packageId)], { timeoutMs: 30000 }).catch(() => {});
      for (const volume of volumes) {
        const volumeName = appVolumeName(packageId, volume);
        const exists = await this.execute(this.dockerBinary, ['volume', 'inspect', volumeName], { timeoutMs: 30000 }).then(() => true, () => false);
        if (exists) {
          activity = `docker volume rm for ${volumeName}`;
          await this.execute(this.dockerBinary, ['volume', 'rm', volumeName], { timeoutMs: 120000 });
        }
      }

      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      const nextRoutes = removeAppRouteBlock(currentRoutes, packageId);
      routesChanged = currentRoutes !== nextRoutes;
      if (routesChanged) {
        activity = STAGE_ACTIVITY['caddy-validation'];
        const candidate = `${this.routesPath}.candidate-${process.pid}`;
        try {
          await fsp.writeFile(candidate, nextRoutes);
          await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', candidate], { timeoutMs: 20000 });
        } finally {
          await fsp.rm(candidate, { force: true }).catch(() => {});
        }
        await snapshot(this.routesPath, routeSnapshot);
        activity = STAGE_ACTIVITY.writing;
        await atomicWrite(this.routesPath, nextRoutes);
        activity = STAGE_ACTIVITY['caddy-reload'];
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
    } catch (error) {
      if (routesChanged) {
        await restore(routeSnapshot, this.routesPath).catch(() => {});
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 10000 }).catch(() => {});
      }
      throw new AppApplyError('remove', describeFailure(error, activity));
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
