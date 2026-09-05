// restic implementation of the backup storage engine surface, mirroring
// engine-kopia.cjs command for command. Everything the rest of MOS knows about
// restic is in this file.

const fs = require('node:fs');
const path = require('node:path');
const { BackupEngineBase, DATA_TIMEOUT_MS } = require('./engine-base.cjs');

function sanitizeTagValue(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]+/gu, '-').slice(0, 120) || 'unknown';
}

class ResticEngine extends BackupEngineBase {
  get name() { return 'restic'; }

  get passwordEnvVar() { return 'RESTIC_PASSWORD'; }

  repositoryFlags(repository) {
    return [`--repo=${repository.repositoryPath}`, `--cache-dir=${this.cacheDir()}`];
  }

  repositoryInitialized(repositoryPath) {
    return fs.existsSync(path.join(repositoryPath, 'config'));
  }

  async openOrCreateRepository({ repositoryPath }) {
    const repository = { engineName: this.name, repositoryPath };
    const created = !this.repositoryInitialized(repositoryPath);
    if (created) {
      fs.mkdirSync(repositoryPath, { recursive: true });
      this.run(['init', ...this.repositoryFlags(repository)], { timeout: 600_000 });
    } else {
      this.run(['cat', 'config', ...this.repositoryFlags(repository)], { timeout: 600_000 });
      this.clearStaleLocks(repository);
    }
    return { ...repository, created };
  }

  // A backup killed by a power loss or a stopped worker leaves its lock
  // behind, and a measured run on the lab VM showed the next integrity check
  // refusing the repository over that lock rather than over anything wrong
  // with the data. MOS runs one backup job at a time and is the repository's
  // only writer, so a lock left by a process that is gone is always stale.
  // Plain `unlock` removes exactly those and leaves a live one alone.
  clearStaleLocks(repository) {
    try {
      this.run(['unlock', ...this.repositoryFlags(repository)], { timeout: 300_000 });
    } catch {}
  }

  async snapshotTree({ repository, sourceDir, tags = {} }) {
    const tagFlags = Object.entries(tags).filter(([, value]) => value !== undefined && value !== null)
      .flatMap(([key, value]) => ['--tag', `${key}:${sanitizeTagValue(value)}`]);
    const output = this.run(['backup', sourceDir, ...this.repositoryFlags(repository), '--json', ...tagFlags], { timeout: DATA_TIMEOUT_MS });
    return { snapshotId: this.snapshotIdFromBackup(output, repository), sourcePath: path.resolve(sourceDir) };
  }

  // restic streams progress as JSON lines and ends with a summary carrying the
  // new snapshot id; the listing is the fallback when the stream was quiet.
  snapshotIdFromBackup(output, repository) {
    for (const line of String(output || '').split(/\r?\n/u).reverse()) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.message_type === 'summary' && parsed.snapshot_id) return parsed.snapshot_id;
      } catch {}
    }
    const latest = this.listJson(['snapshots', ...this.repositoryFlags(repository), '--json', '--latest', '1']).pop();
    if (!latest?.id) throw new Error('The backup storage engine did not report a snapshot for the data it just stored.');
    return latest.id;
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

  // restic recreates the source's absolute path under the target unless the
  // snapshot is addressed as <id>:<path>, which restores that directory's
  // contents directly — the shape Kopia restores natively.
  async restoreSnapshot({ repository, snapshotId, sourcePath, targetDir }) {
    fs.mkdirSync(targetDir, { recursive: true });
    const selector = sourcePath ? `${snapshotId}:${sourcePath}` : snapshotId;
    this.run(['restore', selector, '--target', targetDir, ...this.repositoryFlags(repository)], { timeout: DATA_TIMEOUT_MS });
  }

  async listSnapshots({ repository }) {
    return this.listJson(['snapshots', ...this.repositoryFlags(repository), '--json'])
      .map((entry) => ({ createdAt: entry.time || null, snapshotId: entry.id, sourcePath: (entry.paths || [])[0] || null, tags: entry.tags || [] }));
  }

  async forgetSnapshots({ repository, snapshotIds }) {
    if (!snapshotIds.length) return;
    this.run(['forget', ...snapshotIds, ...this.repositoryFlags(repository)]);
  }

  async maintainRepository({ repository }) {
    this.run(['prune', ...this.repositoryFlags(repository)], { timeout: DATA_TIMEOUT_MS });
  }

  // restic has no per-snapshot deep verify, and its structural check reads
  // indexes rather than data — measured on the real binary, a flipped byte in
  // a pack file passes `check --no-cache` untouched. Streaming each snapshot
  // through `dump` to nowhere reads, decrypts, and authenticates every blob
  // the restore point needs and nothing else, which is the scoped guarantee
  // MOS wants: the same flipped byte makes it refuse.
  async verifySnapshots({ repository, snapshotIds }) {
    this.run(['check', '--no-cache', `--repo=${repository.repositoryPath}`], { timeout: DATA_TIMEOUT_MS });
    for (const snapshotId of snapshotIds) {
      this.run(['dump', snapshotId, '/', '--no-cache', ...this.repositoryFlags(repository)], { discardStdout: true, timeout: DATA_TIMEOUT_MS });
    }
  }

  async verifyRepository({ repository, deep = true }) {
    this.run(['check', `--repo=${repository.repositoryPath}`, '--no-cache', ...(deep ? ['--read-data'] : [])], { timeout: DATA_TIMEOUT_MS });
  }
}

module.exports = { ResticEngine };
