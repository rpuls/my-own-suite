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

const { BackupAgentCore, carriedAddress, sha256 } = require('./agent-core.cjs');
const { DestinationResolver } = require('./destinations.cjs');
const { ObjectDestinationRegistry } = require('./object-destinations.cjs');
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

  // Tar survives only as the pre-restore rescue copy, so the fake keeps only
  // what that path uses: writing an archive and proving it reads back.
  async archiveTree(sourceDir, archivePath) {
    ensureDir(path.dirname(archivePath));
    fs.writeFileSync(archivePath, JSON.stringify({ files: serializeTree(sourceDir) }));
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
  async writeFile(target, content) { this.events.push(['writeFile', target]); ensureDir(path.dirname(target)); fs.writeFileSync(target, content); }
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

// Snapshots in the fake repository are the same JSON tree serializations the
// fake archives use, one file per snapshot, with the repository index holding
// each snapshot's digest. Integrity checking is therefore real: corrupting a
// snapshot file is corrupting repository content, and verifyRepository has to
// find it the way a real engine would.
class FakeEngine {
  constructor(name = 'fake') {
    this.engineName = name;
    this.events = [];
    this.counter = 0;
    this.failNextSnapshot = null;
  }

  get name() { return this.engineName; }

  repositoryInitialized(repositoryPath) { return fs.existsSync(path.join(repositoryPath, 'index.json')); }

  indexPath(repository) { return path.join(repository.localPath, 'index.json'); }
  snapshotPath(repository, snapshotId) { return path.join(repository.localPath, 'snapshots', `${snapshotId}.json`); }
  readIndex(repository) { return readJson(this.indexPath(repository)); }
  writeIndex(repository, index) { writeJson(this.indexPath(repository), index); }

  async openOrCreateRepository({ create = true, localPath, location, missingMessage }) {
    const repository = { engineName: this.name, localPath: localPath || location, location: location || localPath };
    const created = !fs.existsSync(this.indexPath(repository));
    if (created && !create) throw Object.assign(new Error(missingMessage || 'no repository'), { repositoryAbsent: true });
    ensureDir(path.join(repository.localPath, 'snapshots'));
    if (created) this.writeIndex(repository, { snapshots: {} });
    this.events.push(['openOrCreateRepository', repository.localPath, created]);
    return { ...repository, created };
  }

  async snapshotTree({ repository, sourceDir, tags = {} }) {
    if (this.failNextSnapshot) { const error = new Error(this.failNextSnapshot); this.failNextSnapshot = null; throw error; }
    this.counter += 1;
    const snapshotId = `snap-${String(this.counter).padStart(4, '0')}`;
    const file = this.snapshotPath(repository, snapshotId);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ files: serializeTree(sourceDir) }));
    const index = this.readIndex(repository);
    index.snapshots[snapshotId] = { digest: sha256(file), sourcePath: path.resolve(sourceDir), tags };
    this.writeIndex(repository, index);
    this.events.push(['snapshotTree', sourceDir, snapshotId]);
    return { snapshotId, sourcePath: path.resolve(sourceDir) };
  }

  async restoreSnapshot({ repository, snapshotId, targetDir }) {
    const file = this.snapshotPath(repository, snapshotId);
    if (!fs.existsSync(file)) throw new Error(`Backup repository is missing snapshot ${snapshotId}.`);
    const { files } = JSON.parse(fs.readFileSync(file, 'utf8'));
    ensureDir(targetDir);
    for (const [relative, base64] of Object.entries(files)) {
      const absolute = path.join(targetDir, ...relative.split('/'));
      ensureDir(path.dirname(absolute));
      fs.writeFileSync(absolute, Buffer.from(base64, 'base64'));
    }
    this.events.push(['restoreSnapshot', snapshotId, targetDir]);
  }

  async listSnapshots({ repository }) {
    return Object.entries(this.readIndex(repository).snapshots).map(([snapshotId, entry]) => ({ snapshotId, ...entry }));
  }

  async forgetSnapshots({ repository, snapshotIds }) {
    const index = this.readIndex(repository);
    for (const snapshotId of snapshotIds) {
      delete index.snapshots[snapshotId];
      fs.rmSync(this.snapshotPath(repository, snapshotId), { force: true });
    }
    this.writeIndex(repository, index);
    this.events.push(['forgetSnapshots', snapshotIds.join(',')]);
  }

  async maintainRepository({ repository }) { this.events.push(['maintainRepository', repository.localPath]); }

  async verifySnapshots({ repository, snapshotIds }) {
    const index = this.readIndex(repository);
    for (const snapshotId of snapshotIds) {
      const entry = index.snapshots[snapshotId];
      const file = this.snapshotPath(repository, snapshotId);
      if (!entry || !fs.existsSync(file)) throw new Error(`Backup repository is missing snapshot ${snapshotId}.`);
      if (sha256(file) !== entry.digest) throw new Error('Backup repository integrity check failed: stored data does not match what was written.');
    }
    this.events.push(['verifySnapshots', snapshotIds.join(',')]);
  }

  async verifyRepository({ repository }) {
    for (const [snapshotId, entry] of Object.entries(this.readIndex(repository).snapshots)) {
      const file = this.snapshotPath(repository, snapshotId);
      if (!fs.existsSync(file)) throw new Error(`Backup repository is missing snapshot ${snapshotId}.`);
      if (sha256(file) !== entry.digest) throw new Error('Backup repository integrity check failed: stored data does not match what was written.');
    }
    this.events.push(['verifyRepository', repository.localPath]);
  }

  async repositoryStats({ repository }) {
    return { storedBytes: Object.values(serializeTree(repository.localPath)).reduce((sum, base64) => sum + Buffer.from(base64, 'base64').length, 0) };
  }
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
    this.engine = new FakeEngine();
    this.reconcileRuns = [];
    this.progressCalls = [];
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

  core(identity = {}) {
    const readInstances = () => this.readDb().filter((instance) => instance.status !== 'uninstalled');
    return new BackupAgentCore({
      identity,
      apps: {
        installedInstances: () => readInstances().map(({ enabled, instanceId, packageId }) => ({ enabled, instanceId, packageId })),
        // Mirrors the apps agent on reconcile: enabled instances get their
        // declared volumes ensured (created with labels only when absent).
        reconcile: async (log, progress = () => {}) => {
          this.reconcileRuns.push(new Date().toISOString());
          const enabled = readInstances().filter((entry) => entry.enabled);
          for (const [index, instance] of enabled.entries()) {
            progress({ displayName: instance.packageId.toUpperCase(), done: index, packageId: instance.packageId, total: enabled.length, unit: 'apps' });
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
      destinations: new DestinationResolver({
        agentStateDir: this.paths.agentStateDir,
        engine: this.engine,
        objectRegistry: new ObjectDestinationRegistry({ agentStateDir: this.paths.agentStateDir }),
        system: this.system,
      }),
      engine: this.engine,
      jobs: {
        log: (file, message) => this.updateJob(file, (job) => { job.logs.push({ message }); }),
        progress: (file, count) => { this.progressCalls.push({ ...count, stage: readJson(file).stage }); },
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

function restorePointOf(jobFile) { return readJson(jobFile).outputPath; }
function restorePointManifest(jobFile) { return readJson(restorePointOf(jobFile)); }
function repositoryOf(w) { return path.join(w.destination(), 'MOS-backups', 'repository'); }
function snapshotFileOf(w, snapshotId) { return path.join(repositoryOf(w), 'snapshots', `${snapshotId}.json`); }

// Editing a restore point means re-stating its digest, exactly as an attacker
// or a corruption would have to.
function rewriteRestorePoint(manifestPath, mutate) {
  const manifest = readJson(manifestPath);
  mutate(manifest);
  writeJson(manifestPath, manifest);
  fs.writeFileSync(`${manifestPath}.sha256`, `${sha256(manifestPath)}  ${path.basename(manifestPath)}\n`);
  return manifest;
}

// What installs that predate the encrypted repository still have sitting on
// their drives: a directory holding a pre-4 manifest. MOS can no longer read
// one, so the fixture carries the manifest and the completion marker and not
// the archives nothing opens any more.
async function writeLegacyBundle(w, { id = 'legacy-0001', schemaVersion = 3 } = {}) {
  const bundle = path.join(w.destination(), 'MOS-backups', `mos-backup-${id}`);
  ensureDir(bundle);
  const apps = w.readDb().filter((instance) => instance.status !== 'uninstalled').map((instance) => ({
    instanceId: instance.instanceId,
    packageId: instance.packageId,
    packageVersion: '1.0.0',
  }));
  const manifest = {
    backup: { createdAt: new Date().toISOString(), id, kind: 'mos-whole-suite', schemaVersion },
    contents: { apps, stateArchive: 'state.tar.gz', volumes: [] },
    source: await w.system.sourceInfo(),
  };
  writeJson(path.join(bundle, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(bundle, 'MANIFEST.sha256'), `${sha256(path.join(bundle, 'manifest.json'))}  manifest.json\n`);
  fs.writeFileSync(path.join(bundle, 'state.tar.gz'), 'archive-nothing-reads\n');
  fs.writeFileSync(path.join(bundle, 'COMPLETE'), `${new Date().toISOString()}\n`);
  return bundle;
}

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
  const point = restorePointOf(backupJob);
  assert.equal(readJson(backupJob).status, 'succeeded');
  // The manifest is the completion marker, and it carries its own digest.
  assert.ok(fs.existsSync(point));
  assert.ok(fs.existsSync(`${point}.sha256`));
  const manifest = readJson(point);
  assert.equal(manifest.backup.schemaVersion, 4);
  assert.equal(manifest.backup.storage, 'engine-repository');
  assert.ok(manifest.contents.stateSnapshot.snapshotId);
  assert.ok(manifest.contents.volumes[0].snapshotId);
  assert.deepEqual(manifest.contents.volumes.map((volume) => volume.name), ['mos-app-stirling-pdf-configs']);
  assert.equal(manifest.contents.volumes[0].ownership, 'labeled');
  assert.equal(manifest.contents.volumes[0].instanceId, STIRLING.instanceId);
  // The staged state excluded regenerable caches and captured the database.
  const stateProbe = path.join(w.root, 'state-probe');
  const repository = await w.engine.openOrCreateRepository({ localPath: repositoryOf(w), location: repositoryOf(w) });
  await w.engine.restoreSnapshot({ repository, snapshotId: manifest.contents.stateSnapshot.snapshotId, targetDir: stateProbe });
  const stateKeys = Object.keys(serializeTree(stateProbe));
  assert.ok(stateKeys.includes('var-lib-mos/suite-manager/suite-manager.sqlite'));
  assert.ok(!stateKeys.some((key) => key.includes('app-candidates')));

  // Life after the checkpoint: Seafile installed, Stirling data changed.
  await w.installApp(SEAFILE);
  fs.writeFileSync(path.join(w.system.volumeDir('mos-app-stirling-pdf-configs'), 'data.txt'), 'stirling-v2');
  fs.writeFileSync(path.join(w.paths.stateRoot, 'homepage', 'config', 'settings.yaml'), 'homepage-v2\n');
  // An ambient volume that wears the prefix but belongs to no known package.
  await w.system.createVolume('mos-app-not-a-package-data', {});
  fs.writeFileSync(path.join(w.system.volumeDir('mos-app-not-a-package-data'), 'keep.txt'), 'untouched');

  const restoreJob = w.createJob('restore', { backupPath: point });
  await core.restore(restoreJob);
  const finished = readJson(restoreJob);
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.validation.checks.repositoryIntegrity, true);
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

// The tar formats were removed with the code that read them. A backup in one
// of them has to be refused in a sentence an owner can act on, and refused
// before the restore has touched anything — the failure mode to avoid is a
// half-restored machine and a checksum error from a file MOS cannot parse.
test('a backup in a retired format is refused before any mutation', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const bundle = await writeLegacyBundle(w, { id: 'v2-fixture', schemaVersion: 2 });

  w.system.events.length = 0;
  await assert.rejects(() => core.restore(w.createJob('restore', { backupPath: bundle })), /older MOS in the unencrypted bundle format/u);
  await assert.rejects(() => core.validateBackup(w.createJob('validate', { backupPath: bundle })), /older MOS in the unencrypted bundle format/u);
  assert.equal(core.interruptedRestore(), null);
  assert.ok(!w.system.events.some(([event]) => ['removeContainer', 'removeVolume', 'stopService'].includes(event)));
  // Refused, not cleaned up behind the owner's back.
  assert.ok(fs.existsSync(bundle));
});

test('an interrupted restore is detected, blocks new work, and requires explicit acknowledgment', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);

  const originalRestore = w.engine.restoreSnapshot.bind(w.engine);
  w.engine.restoreSnapshot = async (options) => {
    if (options.targetDir.includes('mos-app-stirling-pdf-configs')) throw new Error('disk failure while extracting');
    return originalRestore(options);
  };
  const restoreJob = w.createJob('restore', { backupPath: point });
  await assert.rejects(() => core.restore(restoreJob), /disk failure/u);

  const interrupted = core.interruptedRestore();
  assert.ok(interrupted);
  assert.equal(interrupted.phase, 'restoring-volumes');
  assert.ok(interrupted.rescuePath);
  assert.ok(fs.existsSync(path.join(interrupted.rescuePath, 'rescue-manifest.json')));

  // No new destructive work while the machine sits between two states.
  w.engine.restoreSnapshot = originalRestore;
  await assert.rejects(() => core.backup(w.createJob('backup', { destinationId: w.destination() })), /did not complete/u);
  await assert.rejects(() => core.restore(w.createJob('restore', { backupPath: point })), /did not complete/u);

  assert.throws(() => core.acknowledgeInterruptedRestore({ confirmation: 'yes' }), /ACKNOWLEDGE/u);
  const acknowledged = core.acknowledgeInterruptedRestore({ confirmation: 'ACKNOWLEDGE' });
  assert.equal(acknowledged.phase, 'restoring-volumes');
  assert.equal(core.interruptedRestore(), null);

  // With the interruption acknowledged, a clean retry completes.
  const retryJob = w.createJob('restore', { backupPath: point });
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
  const restoreJob = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
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
  const point = restorePointOf(backupJob);
  rewriteRestorePoint(point, (manifest) => { manifest.backup.schemaVersion = 9; });

  w.system.events.length = 0;
  const restoreJob = w.createJob('restore', { backupPath: point });
  await assert.rejects(() => core.restore(restoreJob), /no longer reads/u);
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

// Deduplication is the point of the repository, so the space check has to
// reflect it: a drive holding one copy of the data can never fit a second, and
// demanding room for one would refuse every backup after the first.
test('a later backup is not refused for lacking room for a whole second copy', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  await core.backup(w.createJob('backup', { destinationId: w.destination() }));

  const rawBytes = await w.system.pathBytes(w.system.volumeDir('mos-app-stirling-pdf-configs'));
  assert.ok(rawBytes > 0);
  // Room for what changes, not for everything again.
  w.system.freeBytes.set(w.destination(), 2 * 1024 * 1024 * 1024);
  const second = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(second);
  assert.equal(readJson(second).status, 'succeeded');

  // A destination with nothing left is still refused, and still before the
  // runtime is touched.
  w.system.freeBytes.set(w.destination(), 1);
  w.system.events.length = 0;
  await assert.rejects(() => core.backup(w.createJob('backup', { destinationId: w.destination() })), /too little to add to the backups already on it/u);
  assert.ok(!w.system.events.some(([event]) => event === 'stopContainer' || event === 'stopService'));
});

test('backup stages suite state off the destination filesystem', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const destination = `${path.resolve(w.destination())}${path.sep}`;
  const realCopyTree = w.system.copyTree.bind(w.system);
  const stagedTargets = [];
  w.system.copyTree = async (source, target, options) => {
    const resolved = path.resolve(target);
    stagedTargets.push(resolved);
    if (resolved.startsWith(destination)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${target}'`), { code: 'EPERM' });
    }
    return realCopyTree(source, target, options);
  };
  await core.backup(w.createJob('backup', { destinationId: w.destination() }));
  assert.ok(stagedTargets.length > 0);
  assert.ok(stagedTargets.every((target) => !target.startsWith(destination)));
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
  const manifest = restorePointManifest(backupJob);
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
  const bundle = restorePointOf(backupJob);

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

test('the read-only check refuses a backup whose stored data was corrupted', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);
  const volumeSnapshot = readJson(point).contents.volumes[0].snapshotId;
  fs.appendFileSync(snapshotFileOf(w, volumeSnapshot), ' ');

  const validateJob = w.createJob('validate', { backupPath: point });
  // What the owner reads says what it means for them; the engine's own words
  // stay on the error for a support panel.
  await assert.rejects(() => core.validateBackup(validateJob), (error) => {
    assert.match(error.message, /failed its integrity check/u);
    assert.match(error.message, /Nothing on this machine was changed/u);
    return true;
  });
});

test('the read-only check reports a software version mismatch without blocking the bundle', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);
  rewriteRestorePoint(point, (manifest) => { manifest.source.version = '9.9.9'; });

  const validateJob = w.createJob('validate', { backupPath: point });
  await core.validateBackup(validateJob);
  const finished = readJson(validateJob);
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.validation.software.matched, false);
  assert.match(finished.validation.warnings[0], /9\.9\.9/u);
  assert.match(finished.validation.warnings[0], /0\.0\.0-test/u);
});

test('a backup from an older MOS reads as the supported direction, and an unreadable generation names its release', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);
  rewriteRestorePoint(point, (manifest) => { manifest.source.version = '0.0.0-older'; });

  const validateJob = w.createJob('validate', { backupPath: point });
  await core.validateBackup(validateJob);
  const finished = readJson(validateJob);
  assert.equal(finished.status, 'succeeded');
  assert.match(finished.validation.warnings[0], /supported direction/u);
  assert.doesNotMatch(finished.validation.warnings[0], /Update MOS first/u);

  rewriteRestorePoint(point, (manifest) => { manifest.backup.schemaVersion = 99; manifest.source.version = '3.1.0'; });
  const refusedJob = w.createJob('validate', { backupPath: point });
  await assert.rejects(core.validateBackup(refusedJob), /Restore it with MOS 3\.1\.0/u);
});

test('the read-only check stays available while an interrupted restore blocks other work', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const bundle = restorePointOf(backupJob);

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

// The 2026-07-20 unmounted-destination drill: the mountpoint directory
// outlives the mount, so a backup whose drive vanished mid-job wrote 13 GB
// onto the system disk and reported success. Success now requires the
// destination to still be mounted.
test('a backup whose destination disappears mid-job fails instead of reporting success', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();

  // The drive detaches while the backup is storing volumes.
  const originalSnapshot = w.engine.snapshotTree.bind(w.engine);
  w.engine.snapshotTree = async (options) => {
    const result = await originalSnapshot(options);
    w.system.destinationMountedResult = false;
    return result;
  };
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await assert.rejects(core.backup(backupJob), /drive was disconnected while MOS was writing to it/u);
  // Nothing is listed, and the repository this job created is removed, so no
  // orphaned gigabytes stay behind on the system disk.
  assert.equal(fs.existsSync(readJson(backupJob).outputPath), false);
  assert.equal(fs.existsSync(repositoryOf(w)), false);
  // The runtime was restarted despite the failure.
  assert.ok(w.system.events.some(([event, name]) => event === 'startContainer' && name === 'mos-app-stirling-pdf'));

  // A backup that starts with the destination already gone fails immediately.
  w.system.destinationMountedResult = false;
  w.engine.snapshotTree = originalSnapshot;
  const refusedJob = w.createJob('backup', { destinationId: w.destination() });
  await assert.rejects(core.backup(refusedJob), /not mounted/u);
});

// A pulled drive surfaces first as whatever the engine says about the path it
// could not write, which reads like an internal fault. The owner gets the
// actual cause instead, and support still gets the engine's own words.
test('a backup that fails because the drive was pulled says so instead of quoting the engine', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();

  w.engine.snapshotTree = async () => {
    w.system.destinationMountedResult = false;
    const failure = new Error('Fatal: unable to save snapshot: write /media/backup/MOS-backups/repository/data/fe/fed386-tmp: no space left on device');
    failure.engineOutput = 'Fatal: unable to save snapshot';
    throw failure;
  };
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await assert.rejects(core.backup(backupJob), (error) => {
    assert.match(error.message, /drive was disconnected while MOS was writing to it/u);
    assert.equal(error.engineOutput, 'Fatal: unable to save snapshot');
    assert.match(error.cause.message, /^Fatal: unable to save snapshot/u);
    return true;
  });

  // A failure with the drive still there keeps the engine's own sentence: it
  // is the useful one, and blaming the cable would be a lie.
  const second = await world();
  await second.installApp(STIRLING);
  second.engine.snapshotTree = async () => { throw new Error('Fatal: repository is already locked exclusively'); };
  await assert.rejects(
    second.core().backup(second.createJob('backup', { destinationId: second.destination() })),
    /already locked exclusively/u,
  );
});

// A destination holds one repository in one storage format. A MOS that speaks
// a different one would corrupt it, so the refusal happens before the engine
// is invoked — which is also what a future format change has to survive.
test('a destination written in another storage format refuses the current engine', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  await w.core().backup(w.createJob('backup', { destinationId: w.destination() }));

  w.engine = new FakeEngine('other-engine');
  const core = w.core();
  w.system.events.length = 0;
  await assert.rejects(() => core.backup(w.createJob('backup', { destinationId: w.destination() })), /different storage format \(fake\)/u);
  // Refused before the runtime was touched, so nothing stopped for nothing.
  assert.ok(!w.system.events.some(([event]) => event === 'stopContainer' || event === 'stopService'));
});

// Unlinking a snapshot reclaims nothing on its own. An owner deleting a
// backup to free a full drive has to actually get the space back.
test('deleting a restore point forgets its snapshots and runs repository maintenance', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination(), note: 'delete me' });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);
  const manifest = readJson(point);
  const snapshotIds = [manifest.contents.stateSnapshot.snapshotId, ...manifest.contents.volumes.map((volume) => volume.snapshotId)];
  for (const snapshotId of snapshotIds) assert.ok(fs.existsSync(snapshotFileOf(w, snapshotId)));

  w.engine.events.length = 0;
  const deleted = await core.deleteBackup(point);
  assert.equal(deleted.kind, 'restore-point');
  for (const snapshotId of snapshotIds) assert.equal(fs.existsSync(snapshotFileOf(w, snapshotId)), false);
  assert.ok(w.engine.events.some(([event]) => event === 'maintainRepository'));
  // The restore point and everything hanging off it are gone.
  for (const suffix of ['', '.sha256', '.note.txt']) assert.equal(fs.existsSync(`${point}${suffix}`), false);
  // The repository itself survives: other restore points may still need it.
  assert.ok(fs.existsSync(repositoryOf(w)));
});

// Deleting rewrites the shared repository with engine safety off, so it runs
// through the same one-job-at-a-time pipeline as backup and restore.
test('a delete job removes the restore point and reports what it deleted', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);

  const deleteJob = w.createJob('delete', { backupPath: point });
  await core.deleteBackupJob(deleteJob);
  const finished = readJson(deleteJob);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(finished.summary, { deletedKind: 'restore-point' });
  for (const suffix of ['', '.sha256']) assert.equal(fs.existsSync(`${point}${suffix}`), false);
  assert.ok(w.engine.events.some(([event]) => event === 'maintainRepository'));
});

// Installs that predate the repository have tar bundles on the same drive MOS
// now writes restore points to. Both must stay listable and restorable.
// A drive whose store was wiped is not an empty drive to start over on; it is
// a restore point that can no longer be read, and saying so is the whole job.
test('a restore point is refused when the store it points into is gone', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);
  fs.rmSync(repositoryOf(w), { force: true, recursive: true });

  w.system.events.length = 0;
  await assert.rejects(() => core.validateBackup(w.createJob('validate', { backupPath: point })), /encrypted backup store is missing from this drive/u);
  await assert.rejects(() => core.restore(w.createJob('restore', { backupPath: point })), /encrypted backup store is missing from this drive/u);
  assert.equal(core.interruptedRestore(), null);
  assert.ok(!w.system.events.some(([event]) => ['removeContainer', 'removeVolume', 'stopService'].includes(event)));
  // It was never quietly recreated to make the error go away.
  assert.equal(fs.existsSync(repositoryOf(w)), false);
});

// A drive that has been backed up to for a year holds both. The retired one
// cannot be restored, but it still occupies space, so deleting it has to work
// and has to leave the repository beside it completely alone.
test('a retired-format backup can still be deleted, and the repository beside it is untouched', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const bundle = await writeLegacyBundle(w, { id: 'coexist' });
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);

  const pointCheck = w.createJob('validate', { backupPath: point });
  await core.validateBackup(pointCheck);
  assert.equal(readJson(pointCheck).validation.schemaVersion, 4);

  assert.equal((await core.deleteBackup(bundle)).kind, 'legacy-bundle');
  assert.equal(fs.existsSync(bundle), false);
  assert.ok(fs.existsSync(point));
  // Removing it is a directory removal, never a repository rewrite.
  assert.ok(!w.engine.events.some(([event]) => event === 'maintainRepository'));
  const afterJob = w.createJob('restore', { backupPath: point });
  await core.restore(afterJob);
  assert.equal(readJson(afterJob).status, 'succeeded');
});

// A restore point whose manifest was edited is not a restore point any more:
// the digest beside it is what says the snapshot ids were not swapped.
test('a restore point with a tampered manifest is refused before any mutation', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);
  const manifest = readJson(point);
  manifest.contents.volumes[0].snapshotId = 'snap-9999';
  writeJson(point, manifest);

  w.system.events.length = 0;
  await assert.rejects(() => core.restore(w.createJob('restore', { backupPath: point })), /manifest checksum is invalid/u);
  assert.equal(core.interruptedRestore(), null);
  assert.ok(!w.system.events.some(([event]) => ['removeContainer', 'removeVolume', 'stopService'].includes(event)));

  // The same holds when the digest file is missing outright.
  fs.rmSync(`${point}.sha256`);
  await assert.rejects(() => core.restore(w.createJob('restore', { backupPath: point })), /checksum recorded with it is missing/u);
});

// Rebuilding apps during a restore must use the owner's applied HTTPS domain
// from the restored database, not this machine's install-time address: on a
// USB install MOS_HOME_HOST stays the LAN name forever, and deriving from it
// rewrote every app route off its HTTPS address.
// Only a domain travels between machines, and a restore no longer decides
// anything about it: it reports what the backup carried and sets it aside. A
// backup from the machine that wrote it carries nothing to set aside, because
// that domain is already this machine's own.
test('carriedAddress reports a domain to set aside only when the backup came from elsewhere', () => {
  const here = { hostname: 'standby', installId: 'install-b' };
  const own = { source: { domain: 'mos.example.com', hostname: 'other-name', installId: 'install-b' } };
  assert.deepEqual(carriedAddress({ current: here, manifest: own }), { domain: null, foreign: false });
  const foreignNoDomain = { source: { domain: null, hostname: 'home', installId: 'install-a' } };
  assert.deepEqual(carriedAddress({ current: here, manifest: foreignNoDomain }), { domain: null, foreign: true });
  const foreignDomain = { source: { domain: 'mos.example.com', hostname: 'home', installId: 'install-a' } };
  assert.deepEqual(carriedAddress({ current: here, manifest: foreignDomain }), { domain: 'mos.example.com', foreign: true });
  // A standby named like the original is still another machine.
  assert.equal(carriedAddress({ current: { hostname: 'home', installId: 'install-b' }, manifest: foreignDomain }).foreign, true);
});

test('a restore point records the machine and domain it came from, and the check compares install ids', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const writer = w.core({ domain: () => 'mos.example.com', hostname: () => 'mos-home', installId: () => 'install-a' });
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await writer.backup(backupJob);
  const manifest = restorePointManifest(backupJob);
  assert.deepEqual({ domain: manifest.source.domain, hostname: manifest.source.hostname, installId: manifest.source.installId }, { domain: 'mos.example.com', hostname: 'mos-home', installId: 'install-a' });

  const sameName = w.core({ hostname: () => 'mos-home', installId: () => 'install-b' });
  const checkJob = w.createJob('validate', { backupPath: restorePointOf(backupJob) });
  await sameName.validateBackup(checkJob);
  const source = readJson(checkJob).validation.source;
  assert.equal(source.matched, false);
  assert.equal(source.backupDomain, 'mos.example.com');
  assert.equal(source.backupInstallId, 'install-a');
  assert.equal(source.currentInstallId, 'install-b');
});

// A backup never changes the address the machine is on. Its Caddy files are its
// own, its provider token is its own, and the settings it serves from are read
// before the restore overwrites them and written back after. A machine that came
// back serving a name it could not reach — and refusing the one it could — is
// what this replaced, so each of the three is asserted directly rather than left
// to the address record.
test('a restore offers the carried domain and never reaches the address this machine is on', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  fs.writeFileSync(path.join(w.root, 'etc-caddy', 'Caddyfile'), 'caddy-of-the-original\n');
  fs.writeFileSync(path.join(w.root, 'etc-secrets', 'caddy-cloudflare.env'), 'CF_TOKEN=of-the-original\n');
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await w.core({ acmeEmail: () => 'owner@example.com', domain: () => 'mos.example.com', installId: () => 'install-a' }).backup(backupJob);
  assert.equal(restorePointManifest(backupJob).source.acmeEmail, 'owner@example.com');
  fs.writeFileSync(path.join(w.root, 'etc-caddy', 'Caddyfile'), 'caddy-of-the-standby\n');
  fs.writeFileSync(path.join(w.root, 'etc-secrets', 'caddy-cloudflare.env'), 'CF_TOKEN=of-the-standby\n');
  // The address is machine-local state the restore never touches: it is not in
  // the state tree the restore replaces, and the engine has no code for it.
  const addressDir = path.join(w.paths.stateRoot, 'suite-address');
  ensureDir(addressDir);
  fs.writeFileSync(path.join(addressDir, 'address.json'), '{"host":"home.192-168-30-104.local.myownsuite.org","kind":"easy-door","scheme":"http"}\n');

  const offers = [];
  const standby = w.core({
    installId: () => 'install-b',
    offerAddress: async (offer) => { offers.push(offer); },
  });
  const job = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
  await standby.restore(job);
  const restored = readJson(job);
  assert.equal(restored.status, 'succeeded');
  assert.deepEqual(restored.address, { domain: 'mos.example.com' });
  assert.equal(fs.readFileSync(path.join(w.root, 'etc-caddy', 'Caddyfile'), 'utf8'), 'caddy-of-the-standby\n');
  assert.equal(fs.readFileSync(path.join(addressDir, 'address.json'), 'utf8'), '{"host":"home.192-168-30-104.local.myownsuite.org","kind":"easy-door","scheme":"http"}\n');
  // The live token is what Caddy read when it started, so the restore carries
  // the backup's alongside it rather than over it.
  assert.equal(fs.readFileSync(path.join(w.root, 'etc-secrets', 'caddy-cloudflare.env'), 'utf8'), 'CF_TOKEN=of-the-standby\n');
  assert.equal(fs.readFileSync(path.join(w.root, 'etc-secrets', 'caddy-cloudflare.env.parked'), 'utf8'), 'CF_TOKEN=of-the-original\n');
  // The carried name is an offer with the contact that issued its certificate.
  assert.deepEqual(offers, [{ acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com' }]);
  assert.ok(restored.logs.some((entry) => /Set mos\.example\.com aside/u.test(entry.message)));

  // Nothing is offered on the machine that wrote the backup: that domain is
  // already its own.
  const homeJob = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
  await w.core({ installId: () => 'install-a', offerAddress: async (offer) => { offers.push(offer); } }).restore(homeJob);
  const home = readJson(homeJob);
  assert.deepEqual(home.address, { domain: null });
  assert.equal(offers.length, 1);
  assert.ok(!home.logs.some((entry) => /aside/u.test(entry.message)));
});

// The route fragments are projections of the restored database and Homepage
// config. A receiving machine's own routes used to survive a restore beside the
// backup's, because the apps agent merges its block into whatever the file held.
test('a restore resets the route fragments before rebuilding them, and re-renders Homepage afterwards', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await w.core().backup(backupJob);
  fs.writeFileSync(path.join(w.root, 'etc-caddy', 'mos-app-routes.caddy'), '# mos-app-route:start stale\nhttp://stale.mos.home {\n}\n# mos-app-route:end stale\n');
  fs.writeFileSync(path.join(w.root, 'etc-caddy', 'mos-homepage-routes.caddy'), 'http://printer.mos.home {\n}\n');

  const order = [];
  const core = new BackupAgentCore({
    ...w.core().constructor === BackupAgentCore ? {} : {},
    apps: { installedInstances: () => w.readDb().map(({ enabled, instanceId, packageId }) => ({ enabled, instanceId, packageId })), reconcile: async () => { order.push('apps'); } },
    destinations: w.core().destinations,
    engine: w.engine,
    homepage: { rebuild: async (log) => { order.push('homepage'); log('Homepage re-rendered'); } },
    jobs: w.core().jobs,
    packages: w.core().packages,
    paths: w.paths,
    system: w.system,
  });
  const job = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
  await core.restore(job);
  assert.equal(readJson(job).status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(w.root, 'etc-caddy', 'mos-app-routes.caddy'), 'utf8'), '# No app runtime routes.\n');
  assert.equal(fs.readFileSync(path.join(w.root, 'etc-caddy', 'mos-homepage-routes.caddy'), 'utf8'), '# No user-managed Homepage routes.\n');
  assert.equal(fs.readFileSync(path.join(w.root, 'etc-caddy', 'Caddyfile'), 'utf8'), 'caddy-base\n');
  assert.deepEqual(order, ['apps', 'homepage']);
  const resets = w.system.events.filter(([name]) => name === 'writeFile').map(([, target]) => path.basename(target)).sort();
  assert.deepEqual(resets, ['mos-app-routes.caddy', 'mos-homepage-routes.caddy']);
  const reconcileAt = w.system.events.findIndex(([name]) => name === 'restoreStateOwnership');
  assert.ok(w.system.events.findIndex(([name]) => name === 'writeFile') < reconcileAt, 'the fragments are reset before the apps are rebuilt');

  // A Homepage that cannot be re-rendered is reported on the job, not a failed restore.
  const failing = new BackupAgentCore({
    apps: { installedInstances: () => w.readDb().map(({ enabled, instanceId, packageId }) => ({ enabled, instanceId, packageId })), reconcile: async () => {} },
    destinations: w.core().destinations,
    engine: w.engine,
    homepage: { rebuild: async () => { throw new Error('homepage agent unavailable'); } },
    jobs: w.core().jobs,
    packages: w.core().packages,
    paths: w.paths,
    system: w.system,
  });
  const second = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
  await failing.restore(second);
  assert.equal(readJson(second).status, 'succeeded');
  assert.ok(readJson(second).logs.some((entry) => /Homepage could not be re-rendered after the restore: homepage agent unavailable/u.test(entry.message)));
});

// A reload Caddy refused leaves the machine on its pre-restore routes. The data
// is back, so the restore succeeds — but it says so on the job, because the
// silent version of this is a suite nobody can reach reporting success.
test('routes that did not go live are recorded on the job rather than swallowed', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await w.core().backup(backupJob);

  w.system.reloadCaddy = async () => ({ detail: 'API token \'\' appears invalid', ok: false });
  const job = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
  await w.core().restore(job);
  const restored = readJson(job);
  assert.equal(restored.status, 'succeeded');
  assert.deepEqual(restored.controlPlane, { detail: 'API token \'\' appears invalid', routesLive: false });
  assert.ok(restored.logs.some((entry) => /still serving the routes it had before the restore/u.test(entry.message)));

  w.system.reloadCaddy = async () => ({ ok: true });
  const second = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
  await w.core().restore(second);
  assert.deepEqual(readJson(second).controlPlane, { detail: null, routesLive: true });
});

// The engine has no address code left: nothing in it reads a settings row, an
// environment variable or a Caddyfile to decide where the suite is.
test('the restore engine derives no address', () => {
  const source = fs.readFileSync(path.join(__dirname, 'agent-core.cjs'), 'utf8');
  assert.doesNotMatch(source, /MOS_HOME_HOST|servedAddress|captureAddress|settleAddress|getHttpsSettings|easyDoor/u);
});

// A backup whose worker was killed never runs its own cleanup, so the packs it
// had already written stay referenced by nothing. Before this, the only thing
// that ever collected them was the next delete — which an owner may never do.
test('data left by an interrupted backup is collected at the start of the next backup', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  await core.backup(w.createJob('backup', { destinationId: w.destination() }));

  // What reconcileCurrentJob records when it finds a worker that is gone.
  core.noteUncollectedData(w.destination());
  assert.deepEqual(core.readUncollectedData(), [w.destination()]);

  w.engine.events.length = 0;
  const next = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(next);

  assert.ok(w.engine.events.some(([event]) => event === 'maintainRepository'));
  assert.ok(readJson(next).logs.some((line) => /interrupted/u.test(line.message)));
  // Collected once: the note is cleared so every later backup is not slowed by
  // a repository rewrite it does not need.
  assert.deepEqual(core.readUncollectedData(), []);

  w.engine.events.length = 0;
  await core.backup(w.createJob('backup', { destinationId: w.destination() }));
  assert.ok(!w.engine.events.some(([event]) => event === 'maintainRepository'));
});

// The other writer of the note: not a killed worker but a backup that failed
// on its own before its first snapshot was recorded. It ran its cleanup, and
// with nothing to forget that cleanup can only note the destination.
test('a backup that fails before its first snapshot notes the destination, and the next backup collects', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  await w.core().backup(w.createJob('backup', { destinationId: w.destination() }));

  const failing = w.core();
  failing.engine.snapshotTree = async () => { throw new Error('Fatal: repository is already locked exclusively'); };
  await assert.rejects(failing.backup(w.createJob('backup', { destinationId: w.destination() })), /already locked/u);
  assert.deepEqual(w.core().readUncollectedData(), [w.destination()]);

  delete failing.engine.snapshotTree;
  w.engine.events.length = 0;
  const next = w.createJob('backup', { destinationId: w.destination() });
  await w.core().backup(next);
  assert.equal(readJson(next).status, 'succeeded');
  assert.ok(w.engine.events.some(([event]) => event === 'maintainRepository'));
  assert.deepEqual(w.core().readUncollectedData(), []);
});

test('an ordinary backup runs no repository maintenance', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  await core.backup(w.createJob('backup', { destinationId: w.destination() }));
  assert.ok(!w.engine.events.some(([event]) => event === 'maintainRepository'));
  assert.deepEqual(core.readUncollectedData(), []);
});

// Housekeeping must never cost the owner the backup they actually asked for.
test('a backup still succeeds when the leftover data cannot be collected', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  await core.backup(w.createJob('backup', { destinationId: w.destination() }));
  core.noteUncollectedData(w.destination());

  const failing = w.core();
  failing.engine.maintainRepository = async () => { throw new Error('repository is locked'); };
  const job = w.createJob('backup', { destinationId: w.destination() });
  await failing.backup(job);

  const finished = readJson(job);
  assert.equal(finished.status, 'succeeded');
  assert.ok(finished.logs.some((line) => /could not be reclaimed: repository is locked/u.test(line.message)));
  // Cleared even on failure, so one unreachable pass does not rewrite the
  // repository at the start of every backup from now on.
  assert.deepEqual(failing.readUncollectedData(), []);
});

// Connecting to another server's archive must never change it, so the moment
// this machine may make that server's key its own is the moment it takes that
// server's place — a successful restore that is not a copy. A copy stays a
// second machine and keeps borrowing the key.
// The key follows the data, not the address: a machine holding another
// machine's suite takes on its key whatever it ends up answering on. Deciding
// this from the address plan is what used to leave a restored machine with its
// own key for the disk and a borrowed one for the archive.
test('a restore from another server adopts its key; restoring this machine\'s own backup does not', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await w.core({ domain: () => 'mos.example.com', installId: () => 'install-a' }).backup(backupJob);

  const assumed = [];
  const standby = w.core({
    assumeArchiveKey: async (destinationId) => { assumed.push(destinationId); return true; },
    installId: () => 'install-b',
  });

  const job = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
  await standby.restore(job);
  assert.deepEqual(assumed, [w.destination()]);
  assert.ok(readJson(job).logs.some((entry) => /now uses the recovery key of the server it restored from/u.test(entry.message)));

  // The machine that wrote the backup has nothing to take on.
  await w.core({ assumeArchiveKey: async (id) => { assumed.push(id); return true; }, installId: () => 'install-a' })
    .restore(w.createJob('restore', { backupPath: restorePointOf(backupJob) }));
  assert.deepEqual(assumed, [w.destination()]);
});

// What the surfaces that show a running job are given: the apps and size a
// check or restore is working on, told before the long read starts, and which
// item of how many a stage is on. The words are the host's; the engine only
// says where it is.
test('a check and a restore record what they work on, and count through volumes and apps', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  await w.installApp(SEAFILE);
  const core = w.core();
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);
  const backup = readJson(backupJob);
  assert.deepEqual(backup.subject.apps.map((app) => app.packageId), ['stirling-pdf', 'seafile']);
  assert.equal(backup.subject.volumeCount, 3);
  assert.ok(backup.subject.sizeBytes > 0);
  assert.deepEqual(
    w.progressCalls.filter((call) => call.stage === 'Storing app volumes').map((call) => [call.done, call.total, call.unit, call.packageId]),
    [[0, 3, 'volumes', 'seafile'], [1, 3, 'volumes', 'seafile'], [2, 3, 'volumes', 'stirling-pdf']],
  );

  w.progressCalls.length = 0;
  const validateJob = w.createJob('validate', { backupPath: point });
  await core.validateBackup(validateJob);
  const validated = readJson(validateJob);
  assert.deepEqual(validated.subject.apps.map((app) => app.packageId), ['stirling-pdf', 'seafile']);
  assert.equal(validated.subject.sizeBytes, backup.subject.sizeBytes);
  assert.deepEqual(w.progressCalls, [], 'a check has no counted stage');

  const restoreJob = w.createJob('restore', { backupPath: point });
  await core.restore(restoreJob);
  const restored = readJson(restoreJob);
  assert.equal(restored.status, 'succeeded');
  assert.equal(restored.subject.sizeBytes, backup.subject.sizeBytes);
  const byStage = (stage) => w.progressCalls.filter((call) => call.stage === stage).map((call) => [call.done, call.total, call.unit, call.displayName || call.packageId]);
  assert.deepEqual(byStage('Saving pre-restore rescue copy'), [[0, 3, 'volumes', 'seafile'], [1, 3, 'volumes', 'seafile'], [2, 3, 'volumes', 'stirling-pdf']]);
  assert.deepEqual(byStage('Restoring app volumes'), [[0, 3, 'volumes', 'seafile'], [1, 3, 'volumes', 'seafile'], [2, 3, 'volumes', 'stirling-pdf']]);
  assert.deepEqual(byStage('Rebuilding app runtime'), [[0, 2, 'apps', 'STIRLING-PDF'], [1, 2, 'apps', 'SEAFILE']]);
  // Nothing about a volume reaches a count but the app it belongs to.
  for (const call of w.progressCalls) assert.equal(call.name, undefined);
});

// The half of adoption that used to be silent, and the one that matters most on
// a machine with an encrypted disk: the takeover rekeys the disk before it
// changes any bookkeeping, so a rekey that could not happen must abandon the
// whole adoption. The alternative is a machine whose backups and whose disk
// answer to different keys, discovered by its owner at the one moment they need
// either — and the restore itself succeeded, so the words must not suggest
// otherwise.
test('a takeover whose disk rekey fails adopts nothing and says what still opens what', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await w.core({ installId: () => 'install-a' }).backup(backupJob);

  const standby = w.core({
    assumeArchiveKey: async () => ({ ok: false, reason: 'vault-agent-unavailable' }),
    installId: () => 'install-b',
  });
  const takeoverJob = w.createJob('restore', { backupPath: restorePointOf(backupJob) });
  await standby.restore(takeoverJob);

  const logs = readJson(takeoverJob).logs.map((entry) => entry.message);
  assert.ok(
    !logs.some((line) => /now uses the recovery key of the server it restored from/u.test(line)),
    'a refused rekey must never be reported as an adopted key',
  );
  const refusal = logs.find((line) => /could not change its disk over/u.test(line));
  assert.ok(refusal, 'the refusal is reported');
  assert.match(refusal, /not answering/u, 'and names what stopped it');
  assert.match(refusal, /nothing is lost/u, 'and that the restore itself is complete');
  assert.match(refusal, /still open with the key you entered/u);
  assert.equal(readJson(takeoverJob).status, 'succeeded', 'the restore is not failed by a key it could not change');
});
