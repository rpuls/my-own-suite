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

const { BackupAgentCore, restorePublicIdentity, sha256 } = require('./agent-core.cjs');
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

  indexPath(repository) { return path.join(repository.repositoryPath, 'index.json'); }
  snapshotPath(repository, snapshotId) { return path.join(repository.repositoryPath, 'snapshots', `${snapshotId}.json`); }
  readIndex(repository) { return readJson(this.indexPath(repository)); }
  writeIndex(repository, index) { writeJson(this.indexPath(repository), index); }

  async openOrCreateRepository({ repositoryPath }) {
    const repository = { engineName: this.name, repositoryPath };
    const created = !fs.existsSync(this.indexPath(repository));
    ensureDir(path.join(repositoryPath, 'snapshots'));
    if (created) this.writeIndex(repository, { snapshots: {} });
    this.events.push(['openOrCreateRepository', repositoryPath, created]);
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

  async maintainRepository({ repository }) { this.events.push(['maintainRepository', repository.repositoryPath]); }

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
    this.events.push(['verifyRepository', repository.repositoryPath]);
  }

  async repositoryStats({ repository }) {
    return { storedBytes: Object.values(serializeTree(repository.repositoryPath)).reduce((sum, base64) => sum + Buffer.from(base64, 'base64').length, 0) };
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
      engine: this.engine,
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

// MOS no longer writes v2/v3 tar bundles, so the legacy restore and import
// paths are tested against a fixture of the historical format rather than
// against something the current code produced. This is what is on the drives
// of installs that predate the repository.
async function writeLegacyBundle(w, { id = 'legacy-0001', schemaVersion = 3 } = {}) {
  const core = w.core();
  const bundle = path.join(w.destination(), 'MOS-backups', `mos-backup-${id}`);
  const stage = path.join(w.paths.agentStateDir, `legacy-stage-${id}`);
  fs.rmSync(stage, { force: true, recursive: true });
  for (const target of core.stateTargets()) {
    await w.system.copyTree(target.path, path.join(stage, target.stagePath), { excludeNames: target.exclude || [] });
    if (target.sqliteDatabase) await w.system.snapshotSqlite(path.join(target.path, target.sqliteDatabase), path.join(stage, target.stagePath, target.sqliteDatabase));
  }
  ensureDir(bundle);
  const statePath = path.join(bundle, 'state.tar.gz');
  await w.system.archiveTree(stage, statePath);
  fs.rmSync(stage, { force: true, recursive: true });
  const apps = w.readDb().filter((instance) => instance.status !== 'uninstalled').map((instance) => ({
    instanceId: instance.instanceId,
    manifestDigest: 'test-manifest-digest',
    packageDigest: 'test-package-digest',
    packageId: instance.packageId,
    packageVersion: '1.0.0',
    payload: [],
    source: { kind: 'test' },
  }));
  const { ambiguous, owned } = classifyVolumes(await w.system.listVolumes(), [...new Set(apps.map((app) => app.packageId))]);
  const volumes = [];
  for (const volume of owned) {
    const archive = `volumes/${volume.name}.tar.gz`;
    const archivePath = path.join(bundle, archive);
    await w.system.archiveTree(w.system.volumeDir(volume.name), archivePath);
    const entry = { archive, archiveBytes: fs.statSync(archivePath).size, archiveSha256: sha256(archivePath), name: volume.name };
    volumes.push(schemaVersion >= 3 ? { ...entry, instanceId: volume.instanceId, ownership: volume.ownership, packageId: volume.packageId, rawBytes: await w.system.pathBytes(w.system.volumeDir(volume.name)) } : entry);
  }
  const manifest = {
    backup: { createdAt: new Date().toISOString(), id, kind: 'mos-whole-suite', schemaVersion },
    contents: {
      apps,
      stateArchive: 'state.tar.gz',
      stateArchiveBytes: fs.statSync(statePath).size,
      stateArchiveSha256: sha256(statePath),
      volumes,
      ...(schemaVersion >= 3 ? { ambiguousVolumes: ambiguous, stateRawBytes: 0 } : {}),
    },
    source: await w.system.sourceInfo(),
  };
  writeJson(path.join(bundle, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(bundle, 'MANIFEST.sha256'), `${sha256(path.join(bundle, 'manifest.json'))}  manifest.json\n`);
  await w.system.archiveTree(bundle, path.join(bundle, 'bundle.tar.gz'), { entries: ['manifest.json', 'MANIFEST.sha256', 'state.tar.gz', 'volumes'] });
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
  const repository = await w.engine.openOrCreateRepository({ repositoryPath: repositoryOf(w) });
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

test('a v2 bundle restores with derived ownership and still reconciles absence', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const bundle = await writeLegacyBundle(w, { id: 'v2-fixture', schemaVersion: 2 });

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

// Upload is the inverse of download: the bundle's own bundle.tar.gz, brought
// back to a destination, must become a restorable bundle only after passing
// the full read-only validation — and a broken or duplicate upload must leave
// nothing visible behind.
test('importBundle turns a downloaded archive back into a restorable bundle and refuses duplicates and corruption', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();

  // A note given at backup time is born with the restore point, as a sidecar.
  const backupJob = w.createJob('backup', { destinationId: w.destination(), note: 'before seafile' });
  await core.backup(backupJob);
  assert.equal(fs.readFileSync(`${restorePointOf(backupJob)}.note.txt`, 'utf8'), 'before seafile\n');

  // Upload speaks the legacy bundle format only: a downloaded bundle from an
  // earlier MOS is the sole thing an owner can have to upload.
  const bundle = await writeLegacyBundle(w, { id: 'import-fixture' });
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
  assert.equal(finished.validation.storage, 'tar-bundle');
  const imported = finished.outputPath;
  assert.ok(fs.existsSync(path.join(imported, 'COMPLETE')));
  assert.ok(fs.existsSync(path.join(imported, 'bundle.tar.gz')));
  assert.equal(readJson(path.join(imported, 'manifest.json')).backup.id, originalManifest.backup.id);
  assert.equal(fs.existsSync(upload), false);
  // The sidecar note never rides inside the downloadable archive.
  assert.equal(fs.existsSync(path.join(imported, 'note.txt')), false);

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

  // The drive detaches while the backup is storing volumes.
  const originalSnapshot = w.engine.snapshotTree.bind(w.engine);
  w.engine.snapshotTree = async (options) => {
    const result = await originalSnapshot(options);
    w.system.destinationMountedResult = false;
    return result;
  };
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await assert.rejects(core.backup(backupJob), /disappeared while the backup was running/u);
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

// The dual-engine phase is temporary, but while it lasts a destination holds
// one repository in one format. Writing the other engine's snapshots into it
// would corrupt it, so the refusal happens before the engine is invoked.
test('a destination written by one storage engine refuses the other', async () => {
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

test('a legacy bundle and a restore point coexist on one destination', async () => {
  const w = await world();
  await w.installApp(STIRLING);
  const core = w.core();
  const bundle = await writeLegacyBundle(w, { id: 'coexist' });
  const backupJob = w.createJob('backup', { destinationId: w.destination() });
  await core.backup(backupJob);
  const point = restorePointOf(backupJob);

  const bundleCheck = w.createJob('validate', { backupPath: bundle });
  await core.validateBackup(bundleCheck);
  assert.equal(readJson(bundleCheck).validation.storage, 'tar-bundle');
  assert.equal(readJson(bundleCheck).validation.schemaVersion, 3);

  const pointCheck = w.createJob('validate', { backupPath: point });
  await core.validateBackup(pointCheck);
  assert.equal(readJson(pointCheck).validation.storage, 'engine-repository');
  assert.equal(readJson(pointCheck).validation.schemaVersion, 4);

  // Deleting the legacy bundle leaves the repository and its restore point be.
  assert.equal((await core.deleteBackup(bundle)).kind, 'bundle');
  assert.equal(fs.existsSync(bundle), false);
  assert.ok(fs.existsSync(point));
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
test('restorePublicIdentity prefers the restored HTTPS settings over install-time env', () => {
  const environment = { MOS_HOME_HOST: 'home.mos.home' };
  const bootstrapContract = { MOS_HOME_URL: 'http://home.mos.home/' };

  assert.deepEqual(
    restorePublicIdentity({ bootstrapContract, environment, httpsSettings: { baseDomain: 'mos.example.net', tlsMode: 'cloudflare-dns01' } }),
    { homeHost: 'home.mos.example.net', scheme: 'https' },
  );
  // A domain merely pending (apply began, never completed) must not win.
  assert.deepEqual(
    restorePublicIdentity({ bootstrapContract, environment, httpsSettings: { baseDomain: null, pendingBaseDomain: 'mos.example.net', tlsMode: null } }),
    { homeHost: 'home.mos.home', scheme: 'http' },
  );
  assert.deepEqual(
    restorePublicIdentity({ bootstrapContract, environment, httpsSettings: null }),
    { homeHost: 'home.mos.home', scheme: 'http' },
  );
  assert.deepEqual(
    restorePublicIdentity({ bootstrapContract: { MOS_HOME_URL: 'https://home.mos.cloud.example/' }, environment: {}, httpsSettings: null }),
    { homeHost: 'home.mos.cloud.example', scheme: 'https' },
  );
  assert.deepEqual(restorePublicIdentity({}), { homeHost: 'home.mos.home', scheme: 'http' });
});
