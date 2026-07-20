// Regression coverage for the backup/restore engine against a fake system
// adapter: a simulated host whose Docker volumes are directories, whose
// archives are JSON tree serializations, and whose Suite Manager store is a
// JSON file standing in for the SQLite database. The scenarios mirror the
// July 19, 2026 Hyper-V drill that produced a false restore.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BackupAgentCore, sha256 } = require('./agent-core.cjs');
const { appVolumeLabels, appVolumeName, classifyVolumes, OWNERSHIP_LABELS } = require('../../infrastructure/persistent-state.cjs');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function serializeTree(root) {
  const files = {};
  if (!fs.existsSync(root)) return files;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files[path.relative(root, absolute).split(path.sep).join('/')] = fs.readFileSync(absolute).toString('base64');
    }
  };
  walk(root);
  return files;
}

// Archives in the fake world are JSON serializations of a directory tree —
// still a single hashable file, so the engine's checksum handling is real.
class FakeSystem {
  constructor(root) {
    this.root = root;
    this.volumes = new Map();
    this.containers = ['mos-app-stirling-pdf'];
    this.events = [];
    this.freeBytes = new Map();
  }

  volumeDir(name) { return path.join(this.root, 'volumes', name); }
  async listVolumes() { return [...this.volumes.entries()].map(([name, labels]) => ({ labels, name })); }
  async volumeMountpoint(name) { const dir = this.volumeDir(name); ensureDir(dir); return dir; }
  async createVolume(name, labels = {}) { this.events.push(['createVolume', name]); this.volumes.set(name, labels); ensureDir(this.volumeDir(name)); }
  async removeVolume(name) { this.events.push(['removeVolume', name]); this.volumes.delete(name); fs.rmSync(this.volumeDir(name), { force: true, recursive: true }); }
  async listAppContainers({ runningOnly }) { this.events.push(['listAppContainers', runningOnly]); return [...this.containers]; }
  async stopContainer(name) { this.events.push(['stopContainer', name]); }
  async startContainer(name) { this.events.push(['startContainer', name]); }
  async removeContainer(name) { this.events.push(['removeContainer', name]); }
  async stopService(name) { this.events.push(['stopService', name]); }
  async startService(name) { this.events.push(['startService', name]); }
  async reloadCaddy() { this.events.push(['reloadCaddy']); }

  async archiveTree(sourceDir, archivePath, { entries } = {}) {
    ensureDir(path.dirname(archivePath));
    let files = {};
    if (entries) {
      for (const entry of entries) {
        const absolute = path.join(sourceDir, entry);
        if (!fs.existsSync(absolute)) continue;
        if (fs.statSync(absolute).isDirectory()) {
          for (const [key, value] of Object.entries(serializeTree(absolute))) files[`${entry}/${key}`] = value;
        } else {
          files[entry] = fs.readFileSync(absolute).toString('base64');
        }
      }
    } else {
      files = serializeTree(sourceDir);
    }
    fs.writeFileSync(archivePath, JSON.stringify({ files }));
  }

  async extractArchive(archivePath, targetDir) {
    const { files } = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    for (const [relative, base64] of Object.entries(files)) {
      const absolute = path.join(targetDir, ...relative.split('/'));
      ensureDir(path.dirname(absolute));
      fs.writeFileSync(absolute, Buffer.from(base64, 'base64'));
    }
    ensureDir(targetDir);
  }

  async assertArchiveReadable(archivePath) { JSON.parse(fs.readFileSync(archivePath, 'utf8')); }

  async copyTree(source, target, { excludeNames = [] } = {}) {
    if (!fs.existsSync(source)) return;
    ensureDir(path.dirname(target));
    const root = path.resolve(source);
    fs.cpSync(source, target, {
      filter: (src) => {
        const relative = path.relative(root, path.resolve(src));
        if (!relative) return true;
        return !excludeNames.includes(relative.split(path.sep)[0]);
      },
      force: true,
      recursive: true,
    });
  }

  async removeTree(target) { fs.rmSync(target, { force: true, recursive: true }); }
  async availableBytes(dir) { return this.freeBytes.has(dir) ? this.freeBytes.get(dir) : 10 ** 15; }
  async destinationMounted() { return this.destinationMountedResult ?? true; }

  async pathBytes(target) {
    if (!target || !fs.existsSync(target)) return 0;
    if (fs.statSync(target).isFile()) return fs.statSync(target).size;
    return Object.values(serializeTree(target)).reduce((sum, base64) => sum + Buffer.from(base64, 'base64').length, 0);
  }

  async snapshotSqlite(databasePath, targetPath) {
    if (!fs.existsSync(databasePath)) return;
    ensureDir(path.dirname(targetPath));
    fs.cpSync(databasePath, targetPath);
  }

  async restoreStateOwnership() { this.events.push(['restoreStateOwnership']); }
  async sourceInfo() { return { branch: 'test', commit: 'deadbeef', repoDir: this.root, version: '0.0.0-test' }; }
}

const PACKAGE_VOLUMES = {
  seafile: ['mysql-data', 'data'],
  'stirling-pdf': ['configs'],
};

class FakeWorld {
  constructor(root) {
    this.root = root;
    this.paths = {
      agentStateDir: path.join(root, 'agent-state'),
      caddyDir: path.join(root, 'etc-caddy').split(path.sep).join('/'),
      secretsDir: path.join(root, 'etc-secrets').split(path.sep).join('/'),
      stateDir: path.join(root, 'state-root', 'suite-manager'),
      stateRoot: path.join(root, 'state-root'),
    };
    this.system = new FakeSystem(root);
    this.reconcileRuns = [];
    this.jobsDir = path.join(root, 'jobs');
    for (const dir of [this.paths.agentStateDir, this.paths.stateDir, this.jobsDir, path.join(root, 'destination')]) ensureDir(dir);
    ensureDir(path.join(this.paths.stateRoot, 'homepage', 'config'));
    ensureDir(path.join(this.paths.stateRoot, 'app-packages'));
    ensureDir(path.join(root, 'etc-caddy'));
    ensureDir(path.join(root, 'etc-secrets'));
    fs.writeFileSync(path.join(root, 'etc-caddy', 'Caddyfile'), 'caddy-base\n');
    fs.writeFileSync(path.join(root, 'etc-caddy', 'mos-app-routes.caddy'), '# routes v1\n');
    fs.writeFileSync(path.join(root, 'etc-secrets', 'caddy-cloudflare.env'), 'CF_TOKEN=secret\n');
    fs.writeFileSync(path.join(this.paths.stateRoot, 'homepage', 'config', 'settings.yaml'), 'homepage-v1\n');
    ensureDir(path.join(this.paths.stateDir, 'app-candidates'));
    fs.writeFileSync(path.join(this.paths.stateDir, 'app-candidates', 'cache.bin'), 'candidate-cache\n');
  }

  dbPath() { return path.join(this.paths.stateDir, 'suite-manager.sqlite'); }
  writeDb(instances) { fs.writeFileSync(this.dbPath(), JSON.stringify(instances)); }
  readDb() { return JSON.parse(fs.readFileSync(this.dbPath(), 'utf8')); }

  destination() { return path.join(this.root, 'destination'); }

  writeSecret(instanceId, value) {
    const dir = path.join(this.paths.stateDir, 'app-secrets', instanceId);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'password.secret'), value);
  }

  async installApp({ content, instanceId, packageId }) {
    const db = fs.existsSync(this.dbPath()) ? this.readDb() : [];
    db.push({ enabled: true, instanceId, packageId, status: 'installed' });
    this.writeDb(db);
    this.writeSecret(instanceId, `${packageId}-secret`);
    for (const volume of PACKAGE_VOLUMES[packageId] || []) {
      const name = appVolumeName(packageId, volume);
      await this.system.createVolume(name, appVolumeLabels({ instanceId, name, packageId }));
      fs.writeFileSync(path.join(this.system.volumeDir(name), 'data.txt'), content);
    }
  }

  core() {
    const readInstances = () => this.readDb().filter((instance) => instance.status !== 'uninstalled');
    return new BackupAgentCore({
      apps: {
        installedInstances: () => readInstances().map(({ enabled, instanceId, packageId }) => ({ enabled, instanceId, packageId })),
        // Mirrors the apps agent on reconcile: enabled instances get their
        // declared volumes ensured (created with labels only when absent).
        reconcile: async (log) => {
          this.reconcileRuns.push(new Date().toISOString());
          for (const instance of readInstances().filter((entry) => entry.enabled)) {
            log(`Restoring ${instance.packageId}`);
            for (const volume of PACKAGE_VOLUMES[instance.packageId] || []) {
              const name = appVolumeName(instance.packageId, volume);
              if (!this.system.volumes.has(name)) {
                await this.system.createVolume(name, appVolumeLabels({ instanceId: instance.instanceId, name, packageId: instance.packageId }));
              }
            }
          }
        },
      },
      jobs: {
        log: (file, message) => this.updateJob(file, (job) => { job.logs.push({ message }); }),
        stage: (file, name) => this.updateJob(file, (job) => { job.stage = name; job.status = 'running'; job.logs.push({ message: name }); }),
        update: (file, mutator) => this.updateJob(file, mutator),
      },
      packages: {
        inventory: () => this.readDb().filter((instance) => instance.status !== 'uninstalled').map((instance) => ({
          instanceId: instance.instanceId,
          manifestDigest: 'test-manifest-digest',
          packageDigest: 'test-package-digest',
          packageId: instance.packageId,
          packageVersion: '1.0.0',
          payload: [],
          source: { kind: 'test' },
        })),
        validatePayloads: () => {},
      },
      paths: this.paths,
      system: this.system,
    });
  }

  updateJob(file, mutator) {
    const job = readJson(file);
    mutator(job);
    job.updatedAt = new Date().toISOString();
    writeJson(file, job);
    return job;
  }

  createJob(kind, fields) {
    const id = fields.id || `job-${kind}-${Math.random().toString(36).slice(2, 10)}`;
    const file = path.join(this.jobsDir, `${id}.json`);
    writeJson(file, { error: null, id, kind, logs: [], stage: 'queued', status: 'queued', ...fields });
    return file;
  }
}

async function world() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-backup-core-'));
  return new FakeWorld(root);
}

function bundleDirOf(jobFile) { return readJson(jobFile).outputPath; }

const STIRLING = { content: 'stirling-v1', instanceId: 'aaaaaaaa-1111-4111-8111-111111111111', packageId: 'stirling-pdf' };
const SEAFILE = { content: 'old-mysql-credentials', instanceId: 'bbbbbbbb-2222-4222-8222-222222222222', packageId: 'seafile' };

// The drill that motivated the reliability plan: back up a Stirling-only
// installation, install Seafile, restore the checkpoint. The restore must
// reconcile absence — Seafile's control-plane rows AND its volumes — so a
// reinstall can never pair fresh credentials with the old database.
test('full restore reconciles absence: post-backup app volumes cannot survive or be silently reused', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();

  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);
  assert.equal(readJson(backupJob).status, 'succeeded');
  assert.ok(fs.existsSync(path.join(bundle, 'COMPLETE')));
  const manifest = readJson(path.join(bundle, 'manifest.json'));
  assert.equal(manifest.backup.schemaVersion, 3);
  assert.deepEqual(manifest.contents.volumes.map((volume) => volume.name), ['mos-app-stirling-pdf-configs']);
  assert.equal(manifest.contents.volumes[0].ownership, 'labeled');
  assert.equal(manifest.contents.volumes[0].instanceId, STIRLING.instanceId);
  // The staged state excluded regenerable caches and captured the database.
  const stateArchive = JSON.parse(fs.readFileSync(path.join(bundle, 'state.tar.gz'), 'utf8'));
  const stateKeys = Object.keys(stateArchive.files);
  assert.ok(stateKeys.includes('var-lib-mos/suite-manager/suite-manager.sqlite'));
  assert.ok(!stateKeys.some((key) => key.includes('app-candidates')));

  // Life after the checkpoint: Seafile installed, Stirling data changed.
  await w.installApp(SEAFILE);
  fs.writeFileSync(path.join(w.system.volumeDir('mos-app-stirling-pdf-configs'), 'data.txt'), 'stirling-v2');
  fs.writeFileSync(path.join(w.paths.stateRoot, 'homepage', 'config', 'settings.yaml'), 'homepage-v2\n');
  // An ambient volume that wears the prefix but belongs to no known package.
  await w.system.createVolume('mos-app-not-a-package-data', {});
  fs.writeFileSync(path.join(w.system.volumeDir('mos-app-not-a-package-data'), 'keep.txt'), 'untouched');

  const restoreJob = w.createJob('restore', { backupPath: bundle });
  await core.restore(restoreJob);
  const finished = readJson(restoreJob);
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.verification.apps.matched, true);
  assert.equal(finished.verification.volumes.matched, true);
  assert.equal(finished.validation.checks.checksums, true);

  // Presence: Stirling is back at the checkpoint.
  assert.equal(fs.readFileSync(path.join(w.system.volumeDir('mos-app-stirling-pdf-configs'), 'data.txt'), 'utf8'), 'stirling-v1');
  assert.equal(fs.readFileSync(path.join(w.paths.stateRoot, 'homepage', 'config', 'settings.yaml'), 'utf8'), 'homepage-v1\n');
  assert.deepEqual(w.readDb().map((instance) => instance.packageId), ['stirling-pdf']);
  // Absence: nothing of Seafile survived — volumes, labels, secrets.
  assert.equal(w.system.volumes.has('mos-app-seafile-mysql-data'), false);
  assert.equal(w.system.volumes.has('mos-app-seafile-data'), false);
  assert.equal(fs.existsSync(path.join(w.paths.stateDir, 'app-secrets', SEAFILE.instanceId)), false);
  // The ambiguous volume was reported, not destroyed.
  assert.equal(fs.readFileSync(path.join(w.system.volumeDir('mos-app-not-a-package-data'), 'keep.txt'), 'utf8'), 'untouched');
  assert.ok(finished.verification.warnings.some((warning) => warning.includes('mos-app-not-a-package-data')));
  // The journal is closed and reconciliation ran.
  assert.equal(core.interruptedRestore(), null);
  assert.equal(w.reconcileRuns.length, 1);
  // One rollback generation: the rescue holds the pre-restore Seafile data.
  const rescueDir = finished.rescuePath;
  const rescueManifest = readJson(path.join(rescueDir, 'rescue-manifest.json'));
  assert.ok(rescueManifest.volumes.some((volume) => volume.name === 'mos-app-seafile-mysql-data'));
  const rescued = JSON.parse(fs.readFileSync(path.join(rescueDir, 'volumes', 'mos-app-seafile-mysql-data.tar.gz'), 'utf8'));
  assert.equal(Buffer.from(rescued.files['data.txt'], 'base64').toString(), 'old-mysql-credentials');

  // Reinstalling Seafile now behaves like the apps agent: the volume is
  // absent, so it is created fresh — no stale MySQL data to clash with the
  // newly generated credentials.
  const reinstallInstance = 'cccccccc-3333-4333-8333-333333333333';
  const name = appVolumeName('seafile', 'mysql-data');
  assert.equal(w.system.volumes.has(name), false);
  await w.system.createVolume(name, appVolumeLabels({ instanceId: reinstallInstance, name, packageId: 'seafile' }));
  assert.deepEqual(fs.readdirSync(w.system.volumeDir(name)), []);
  assert.equal(w.system.volumes.get(name)[OWNERSHIP_LABELS.instance], reinstallInstance);
});

test('a v2 bundle restores with derived ownership and still reconciles absence', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);

  // Rewrite the bundle to the v2 shape: names only, no ownership metadata.
  const manifest = readJson(path.join(bundle, 'manifest.json'));
  manifest.backup.schemaVersion = 2;
  manifest.contents.volumes = manifest.contents.volumes.map(({ archive, archiveBytes, archiveSha256, name }) => ({ archive, archiveBytes, archiveSha256, name }));
  delete manifest.contents.ambiguousVolumes;
  delete manifest.contents.stateRawBytes;
  writeJson(path.join(bundle, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(bundle, 'MANIFEST.sha256'), `${sha256(path.join(bundle, 'manifest.json'))}  manifest.json\n`);

  await w.installApp(SEAFILE);
  const restoreJob = w.createJob('restore', { backupPath: bundle });
  await core.restore(restoreJob);
  assert.equal(readJson(restoreJob).status, 'succeeded');
  assert.equal(w.system.volumes.has('mos-app-seafile-mysql-data'), false);
  // Ownership was re-derived from the bundle's own package inventory, so the
  // recreated volume is labeled and bound to the original installation.
  const labels = w.system.volumes.get('mos-app-stirling-pdf-configs');
  assert.equal(labels[OWNERSHIP_LABELS.owned], 'true');
  assert.equal(labels[OWNERSHIP_LABELS.instance], STIRLING.instanceId);
});

test('an interrupted restore is detected, blocks new work, and requires explicit acknowledgment', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);

  const originalExtract = w.system.extractArchive.bind(w.system);
  w.system.extractArchive = async (archivePath, targetDir) => {
    if (archivePath.includes('mos-app-stirling-pdf-configs')) throw new Error('disk failure while extracting');
    return originalExtract(archivePath, targetDir);
  };
  const restoreJob = w.createJob('restore', { backupPath: bundle });
  await assert.rejects(() => core.restore(restoreJob), /disk failure/u);

  const interrupted = core.interruptedRestore();
  assert.ok(interrupted);
  assert.equal(interrupted.phase, 'restoring-volumes');
  assert.ok(interrupted.rescuePath);
  assert.ok(fs.existsSync(path.join(interrupted.rescuePath, 'rescue-manifest.json')));

  // No new destructive work while the machine sits between two states.
  w.system.extractArchive = originalExtract;
  await assert.rejects(() => core.backup(w.createJob('backup', { destinationId: w.destination() })), /did not complete/u);
  await assert.rejects(() => core.restore(w.createJob('restore', { backupPath: bundle })), /did not complete/u);

  assert.throws(() => core.acknowledgeInterruptedRestore({ confirmation: 'yes' }), /ACKNOWLEDGE/u);
  const acknowledged = core.acknowledgeInterruptedRestore({ confirmation: 'ACKNOWLEDGE' });
  assert.equal(acknowledged.phase, 'restoring-volumes');
  assert.equal(core.interruptedRestore(), null);

  // With the interruption acknowledged, a clean retry completes.
  const retryJob = w.createJob('restore', { backupPath: bundle });
  await core.restore(retryJob);
  assert.equal(readJson(retryJob).status, 'succeeded');
});

test('restore never reports success when verification finds a resource mismatch', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);

  // A reconcile that leaves an extra owned volume behind simulates any bug
  // that lets state drift from the bundle: verification must fail the job.
  const coreApps = core.apps;
  const originalReconcile = coreApps.reconcile;
  coreApps.reconcile = async (log) => {
    await originalReconcile(log);
    const name = appVolumeName('stirling-pdf', 'stowaway');
    await w.system.createVolume(name, appVolumeLabels({ instanceId: STIRLING.instanceId, name, packageId: 'stirling-pdf' }));
  };
  const restoreJob = w.createJob('restore', { backupPath: bundleDirOf(backupJob) });
  await assert.rejects(() => core.restore(restoreJob), /verification failed.*unexpected.*stowaway/u);
  const interrupted = core.interruptedRestore();
  assert.ok(interrupted);
  assert.equal(interrupted.phase, 'verifying');
});

test('a bundle outside the supported schema window is rejected before any mutation', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);
  const manifest = readJson(path.join(bundle, 'manifest.json'));
  manifest.backup.schemaVersion = 9;
  writeJson(path.join(bundle, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(bundle, 'MANIFEST.sha256'), `${sha256(path.join(bundle, 'manifest.json'))}  manifest.json\n`);

  w.system.events.length = 0;
  const restoreJob = w.createJob('restore', { backupPath: bundle });
  await assert.rejects(() => core.restore(restoreJob), /supported restore window/u);
  assert.equal(core.interruptedRestore(), null);
  assert.ok(!w.system.events.some(([event]) => ['removeContainer', 'removeVolume', 'stopService'].includes(event)));
});

test('backup refuses an undersized destination before touching the runtime', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  w.system.freeBytes.set(w.destination(), 1);
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await assert.rejects(() => core.backup(backupJob), /free but this backup needs/u);
  assert.ok(!w.system.events.some(([event]) => event === 'stopContainer' || event === 'stopService'));
});

test('backup classifies volumes by ownership evidence, not bare prefix', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  // Legacy volume: unlabeled but derivable from an installed package.
  await w.system.createVolume('mos-app-stirling-pdf-legacy', {});
  fs.writeFileSync(path.join(w.system.volumeDir('mos-app-stirling-pdf-legacy'), 'old.txt'), 'legacy');
  // Prefix-wearing stranger: no label, no matching package.
  await w.system.createVolume('mos-app-somebody-else', {});
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const manifest = readJson(path.join(bundleDirOf(backupJob), 'manifest.json'));
  const byName = Object.fromEntries(manifest.contents.volumes.map((volume) => [volume.name, volume]));
  assert.equal(byName['mos-app-stirling-pdf-configs'].ownership, 'labeled');
  assert.equal(byName['mos-app-stirling-pdf-legacy'].ownership, 'derived');
  assert.equal(byName['mos-app-somebody-else'], undefined);
  assert.deepEqual(manifest.contents.ambiguousVolumes, ['mos-app-somebody-else']);
});

test('a validate job proves a bundle restorable without mutating anything', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);

  w.system.events.length = 0;
  const validateJob = w.createJob('validate', { backupPath: bundle });
  await core.validateBackup(validateJob);
  const finished = readJson(validateJob);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(finished.validation.apps.map((app) => app.packageId), ['stirling-pdf']);
  assert.deepEqual(finished.validation.volumes.map((volume) => volume.name), ['mos-app-stirling-pdf-configs']);
  assert.equal(finished.validation.software.matched, true);
  assert.deepEqual(finished.validation.warnings, []);
  assert.deepEqual(finished.summary, { appCount: 1, volumeCount: 1 });
  // Read-only: no container, service, or volume operation happened, and the
  // staged extraction used for payload checks was cleaned up.
  assert.deepEqual(w.system.events, []);
  assert.ok(!fs.readdirSync(w.paths.agentStateDir).some((entry) => entry.startsWith('restore-')));
});

test('the read-only check fails on a corrupted volume archive', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);
  fs.appendFileSync(path.join(bundle, 'volumes', 'mos-app-stirling-pdf-configs.tar.gz'), ' ');

  const validateJob = w.createJob('validate', { backupPath: bundle });
  await assert.rejects(() => core.validateBackup(validateJob), /volume checksum is invalid/u);
});

test('the read-only check reports a software version mismatch without blocking the bundle', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);
  const manifest = readJson(path.join(bundle, 'manifest.json'));
  manifest.source.version = '9.9.9';
  writeJson(path.join(bundle, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(bundle, 'MANIFEST.sha256'), `${sha256(path.join(bundle, 'manifest.json'))}  manifest.json\n`);

  const validateJob = w.createJob('validate', { backupPath: bundle });
  await core.validateBackup(validateJob);
  const finished = readJson(validateJob);
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.validation.software.matched, false);
  assert.match(finished.validation.warnings[0], /9\.9\.9/u);
  assert.match(finished.validation.warnings[0], /0\.0\.0-test/u);
});

test('the read-only check stays available while an interrupted restore blocks other work', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);

  core.writeJournal({ backupPath: bundle, jobId: 'j1', phase: 'rescue', startedAt: new Date().toISOString() });
  await assert.rejects(() => core.backup(w.createJob('backup', { destinationId: w.destination() })), /did not complete/u);
  const validateJob = w.createJob('validate', { backupPath: bundle });
  await core.validateBackup(validateJob);
  assert.equal(readJson(validateJob).status, 'succeeded');
  core.acknowledgeInterruptedRestore({ confirmation: 'ACKNOWLEDGE' });
});

test('classifyVolumes trusts labels first, per-package derivation second, and nothing else', () => {
  const volumes = [
    { labels: { [OWNERSHIP_LABELS.owned]: 'true', [OWNERSHIP_LABELS.package]: 'seafile' }, name: 'mos-app-seafile-data' },
    { labels: {}, name: 'mos-app-stirling-pdf-configs' },
    { labels: {}, name: 'mos-app-unknown-thing' },
    { labels: {}, name: 'unrelated-volume' },
  ];
  const { ambiguous, owned } = classifyVolumes(volumes, ['stirling-pdf', 'seafile']);
  assert.deepEqual(owned.map((volume) => [volume.name, volume.ownership]), [
    ['mos-app-seafile-data', 'labeled'],
    ['mos-app-stirling-pdf-configs', 'derived'],
  ]);
  assert.deepEqual(ambiguous, ['mos-app-unknown-thing']);
});

// Upload is the inverse of download: the bundle's own bundle.tar.gz, brought
// back to a destination, must become a restorable bundle only after passing
// the full read-only validation — and a broken or duplicate upload must leave
// nothing visible behind.
test('importBundle turns a downloaded archive back into a restorable bundle and refuses duplicates and corruption', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = bundleDirOf(backupJob);
  const originalManifest = readJson(path.join(bundle, 'manifest.json'));

  // Uploading onto a destination that already holds the same backup refuses.
  const duplicateUpload = path.join(w.destination(), 'MOS-backups', '.upload-dup.tar.gz');
  fs.cpSync(path.join(bundle, 'bundle.tar.gz'), duplicateUpload);
  const duplicateJob = w.createJob('upload', { destinationId: w.destination(), uploadPath: duplicateUpload });
  await assert.rejects(core.importBundle(duplicateJob), /already exists/u);
  assert.equal(fs.existsSync(duplicateUpload), false);

  // Importing onto an empty destination (the replacement-machine flow).
  const second = path.join(w.root, 'destination-2');
  ensureDir(path.join(second, 'MOS-backups'));
  const upload = path.join(second, 'MOS-backups', '.upload-ok.tar.gz');
  fs.cpSync(path.join(bundle, 'bundle.tar.gz'), upload);
  const importJob = w.createJob('upload', { destinationId: second, uploadPath: upload });
  await core.importBundle(importJob);
  const finished = readJson(importJob);
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.validation.checks.checksums, true);
  const imported = finished.outputPath;
  assert.ok(fs.existsSync(path.join(imported, 'COMPLETE')));
  assert.ok(fs.existsSync(path.join(imported, 'bundle.tar.gz')));
  assert.equal(readJson(path.join(imported, 'manifest.json')).backup.id, originalManifest.backup.id);
  assert.equal(fs.existsSync(upload), false);

  // The imported bundle actually restores.
  const restoreJob = w.createJob('restore', { backupPath: imported });
  await core.restore(restoreJob);
  assert.equal(readJson(restoreJob).status, 'succeeded');

  // A corrupt upload fails validation and leaves no visible bundle or litter.
  const corrupt = path.join(second, 'MOS-backups', '.upload-bad.tar.gz');
  fs.writeFileSync(corrupt, 'not-a-bundle');
  const corruptJob = w.createJob('upload', { destinationId: second, uploadPath: corrupt });
  await assert.rejects(core.importBundle(corruptJob));
  assert.equal(fs.existsSync(corrupt), false);
  const leftovers = fs.readdirSync(path.join(second, 'MOS-backups')).filter((name) => name.startsWith('.'));
  assert.deepEqual(leftovers, []);
});

// The 2026-07-20 unmounted-destination drill: the mountpoint directory
// outlives the mount, so a backup whose drive vanished mid-job wrote 13 GB
// onto the system disk and reported success. Success now requires the
// destination to still be mounted.
test('a backup whose destination disappears mid-job fails instead of reporting success', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();

  // The drive detaches while the backup is writing volume archives.
  const originalArchive = w.system.archiveTree.bind(w.system);
  w.system.archiveTree = async (sourceDir, archivePath, options) => {
    await originalArchive(sourceDir, archivePath, options);
    w.system.destinationMountedResult = false;
  };
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await assert.rejects(core.backup(backupJob), /disappeared while the backup was running/u);
  // The partial bundle is removed outright — nothing can be listed as a
  // bundle and no orphaned gigabytes stay behind on the system disk.
  const bundleDir = readJson(backupJob).outputPath;
  assert.equal(fs.existsSync(bundleDir), false);
  // The runtime was restarted despite the failure.
  assert.ok(w.system.events.some(([event, name]) => event === 'startContainer' && name === 'mos-app-stirling-pdf'));

  // A backup that starts with the destination already gone fails immediately.
  w.system.destinationMountedResult = false;
  w.system.archiveTree = originalArchive;
  const refusedJob = w.createJob('backup', { destinationId: w.destination() });
  await assert.rejects(core.backup(refusedJob), /not mounted/u);
});
