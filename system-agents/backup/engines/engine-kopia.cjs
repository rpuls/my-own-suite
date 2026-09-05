// Kopia implementation of the backup storage engine surface. Everything the
// rest of MOS knows about Kopia is in this file: command names, flags, and
// output shapes. Callers address snapshots by the ids recorded in the restore
// point manifest, never by re-querying tags, so tag syntax is metadata only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BackupEngineBase, DATA_TIMEOUT_MS } = require('./engine-base.cjs');

// Kopia identifies a snapshot source as user@host:/path. Pinning both keeps
// snapshot sources stable when the same repository is opened from a
// replacement machine with a different hostname.
const SOURCE_IDENTITY = ['--override-hostname=mos', '--override-username=mos'];

function sanitizeTagValue(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]+/gu, '-').slice(0, 120) || 'unknown';
}

class KopiaEngine extends BackupEngineBase {
  get name() { return 'kopia'; }

  get passwordEnvVar() { return 'KOPIA_PASSWORD'; }

  // Kept outside the cache directory so an integrity check can drop the whole
  // cache without losing the connection it is checking.
  configFile(repositoryPath) {
    const digest = crypto.createHash('sha256').update(path.resolve(repositoryPath)).digest('hex').slice(0, 16);
    return path.join(this.agentStateDir, 'engine-config', `kopia-${digest}.config`);
  }

  repositoryInitialized(repositoryPath) {
    return fs.existsSync(path.join(repositoryPath, 'kopia.repository.f'));
  }

  async openOrCreateRepository({ repositoryPath }) {
    const configFile = this.configFile(repositoryPath);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const shared = [`--path=${repositoryPath}`, `--config-file=${configFile}`, `--cache-directory=${this.cacheDir()}`, '--no-check-for-updates'];
    const created = !this.repositoryInitialized(repositoryPath);
    if (created) {
      fs.mkdirSync(repositoryPath, { recursive: true });
      this.run(['repository', 'create', 'filesystem', ...shared, ...SOURCE_IDENTITY], { timeout: 600_000 });
    } else {
      this.run(['repository', 'connect', 'filesystem', ...shared, ...SOURCE_IDENTITY], { timeout: 600_000 });
    }
    return { configFile, created, engineName: this.name, repositoryPath };
  }

  async snapshotTree({ repository, sourceDir, tags = {} }) {
    const tagFlags = Object.entries(tags).filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `--tags=${key}:${sanitizeTagValue(value)}`);
    this.run(['snapshot', 'create', sourceDir, `--config-file=${repository.configFile}`, '--json', ...tagFlags], { timeout: DATA_TIMEOUT_MS });
    return { snapshotId: this.latestSnapshotId({ repository, sourceDir }), sourcePath: path.resolve(sourceDir) };
  }

  // Read the id back from the source listing rather than parsing the create
  // output: the listing shape is stable across Kopia versions and the create
  // output is not.
  latestSnapshotId({ repository, sourceDir }) {
    const listed = this.listJson(['snapshot', 'list', sourceDir, `--config-file=${repository.configFile}`, '--json', '--all']);
    const newest = listed.filter((entry) => entry?.id).sort((left, right) => new Date(left.startTime || 0) - new Date(right.startTime || 0)).pop();
    if (!newest) throw new Error('The backup storage engine did not report a snapshot for the data it just stored.');
    return newest.id;
  }

  listJson(args) {
    const output = this.run(args).trim();
    if (!output) return [];
    try {
      const parsed = JSON.parse(output);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  async restoreSnapshot({ repository, snapshotId, targetDir }) {
    fs.mkdirSync(targetDir, { recursive: true });
    this.run(['snapshot', 'restore', snapshotId, targetDir, `--config-file=${repository.configFile}`, '--overwrite-directories', '--overwrite-files'], { timeout: DATA_TIMEOUT_MS });
  }

  async listSnapshots({ repository }) {
    return this.listJson(['snapshot', 'list', `--config-file=${repository.configFile}`, '--json', '--all'])
      .map((entry) => ({ createdAt: entry.startTime || null, snapshotId: entry.id, sourcePath: entry.source?.path || null, tags: entry.tags || {} }));
  }

  async forgetSnapshots({ repository, snapshotIds }) {
    for (const snapshotId of snapshotIds) {
      this.run(['snapshot', 'delete', snapshotId, `--config-file=${repository.configFile}`, '--delete']);
    }
  }

  // Deleting a snapshot only unlinks it; blob reclamation happens in
  // maintenance. Safety is disabled because MOS is the repository's only
  // writer, and the default safety margin defers reclamation long enough that
  // an owner who deleted a backup to free a full drive would see no space
  // return at all.
  async maintainRepository({ repository }) {
    this.run(['maintenance', 'run', '--full', '--safety=none', `--config-file=${repository.configFile}`], { timeout: DATA_TIMEOUT_MS });
  }

  // Scoped to the named snapshots so the cost is the restore point being
  // checked, not every backup ever taken: a whole-repository read grows
  // without bound while validate sits on the restore path. Verified on the
  // real binary: `snapshot verify <id>` accepts ids, and with the cache
  // dropped it refuses a flipped byte in a pack file.
  async verifySnapshots({ repository, snapshotIds }) {
    this.dropCache();
    this.run(['snapshot', 'verify', ...snapshotIds, `--config-file=${repository.configFile}`, '--verify-files-percent=100'], { timeout: DATA_TIMEOUT_MS });
  }

  async verifyRepository({ repository, deep = true }) {
    this.dropCache();
    this.run(['snapshot', 'verify', `--config-file=${repository.configFile}`, `--verify-files-percent=${deep ? 100 : 0}`], { timeout: DATA_TIMEOUT_MS });
  }
}

module.exports = { KopiaEngine };
