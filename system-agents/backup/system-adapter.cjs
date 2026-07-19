// Real host implementation of the backup engine's system surface: Docker,
// tar, systemd, disk accounting, and ownership repair. Everything here is
// mechanical; ordering, journaling, and verification live in agent-core.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

class BackupSystemAdapter {
  constructor({ agentStateDir, repoDir, stateDir, stateRoot }) {
    this.agentStateDir = agentStateDir;
    this.repoDir = repoDir;
    this.stateDir = stateDir;
    this.stateRoot = stateRoot;
  }

  command(file, args, options = {}) {
    return execFileSync(file, args, { cwd: options.cwd || this.repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeout || 120_000 }).trim();
  }

  optionalCommand(file, args, options = {}) {
    try { return this.command(file, args, options); } catch { return null; }
  }

  async listVolumes() {
    const output = this.optionalCommand('docker', ['volume', 'ls', '--format', '{{.Name}}']) || '';
    const names = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).sort();
    if (!names.length) return [];
    const inspected = JSON.parse(this.command('docker', ['volume', 'inspect', ...names], { timeout: 60_000 }));
    return inspected.map((volume) => ({ labels: volume.Labels || {}, name: volume.Name }));
  }

  async volumeMountpoint(name) {
    const inspected = JSON.parse(this.command('docker', ['volume', 'inspect', name]));
    return inspected[0].Mountpoint;
  }

  async createVolume(name, labels = {}) {
    this.command('docker', [
      'volume', 'create',
      ...Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      name,
    ], { timeout: 300_000 });
  }

  async removeVolume(name) {
    this.command('docker', ['volume', 'rm', name], { timeout: 300_000 });
  }

  // Label selection first, name-prefix as a fallback union: containers started
  // by current MOS always carry `mos.package`, but a container surviving from
  // an older install may predate its labels and still needs stopping.
  async listAppContainers({ runningOnly }) {
    const flags = runningOnly ? [] : ['--all'];
    const byLabel = this.optionalCommand('docker', ['ps', ...flags, '--filter', 'label=mos.package', '--format', '{{.Names}}']) || '';
    const byName = this.optionalCommand('docker', ['ps', ...flags, '--filter', 'name=mos-app-', '--format', '{{.Names}}']) || '';
    return [...new Set([...byLabel.split(/\r?\n/u), ...byName.split(/\r?\n/u)].map((line) => line.trim()).filter(Boolean))].sort();
  }

  async stopContainer(name) { this.optionalCommand('docker', ['stop', name], { timeout: 120_000 }); }
  async startContainer(name) { this.optionalCommand('docker', ['start', name], { timeout: 120_000 }); }
  async removeContainer(name) { this.optionalCommand('docker', ['rm', '-f', name], { timeout: 120_000 }); }

  async stopService(name) { this.optionalCommand('systemctl', ['stop', name], { timeout: 120_000 }); }
  async startService(name) { this.optionalCommand('systemctl', ['start', name], { timeout: 120_000 }); }
  async reloadCaddy() { this.optionalCommand('systemctl', ['reload', 'caddy.service'], { timeout: 120_000 }); }

  async archiveTree(sourceDir, archivePath, { entries } = {}) {
    ensureDir(path.dirname(archivePath));
    this.command('tar', ['-czf', archivePath, '-C', sourceDir, ...(entries || ['.'])], { timeout: 1_800_000 });
  }

  async extractArchive(archivePath, targetDir) {
    ensureDir(targetDir);
    this.command('tar', ['-xzf', archivePath, '-C', targetDir], { timeout: 1_800_000 });
  }

  // Listing output is discarded on purpose: a multi-gigabyte archive can hold
  // millions of entries, and capturing that listing just to prove readability
  // would buffer it all in memory.
  async assertArchiveReadable(archivePath) {
    const result = spawnSync('tar', ['-tzf', archivePath], { stdio: 'ignore', timeout: 1_800_000 });
    if (result.status !== 0) throw new Error(`Backup archive is not readable: ${path.basename(archivePath)}.`);
  }

  async copyTree(source, target, { excludeNames = [] } = {}) {
    if (!fs.existsSync(source)) return;
    ensureDir(path.dirname(target));
    const root = path.resolve(source);
    fs.cpSync(source, target, {
      dereference: false,
      filter: (src) => {
        const relative = path.relative(root, path.resolve(src));
        if (!relative) return true;
        return !excludeNames.includes(relative.split(path.sep)[0]);
      },
      force: true,
      preserveTimestamps: true,
      recursive: true,
    });
  }

  async removeTree(target) { fs.rmSync(target, { force: true, recursive: true }); }

  async availableBytes(dir) {
    try { const stat = fs.statfsSync(dir); return stat.bavail * stat.bsize; } catch { return null; }
  }

  async pathBytes(target) {
    if (!target || !fs.existsSync(target)) return 0;
    const output = this.optionalCommand('du', ['-sb', target], { timeout: 600_000 });
    if (!output) return null;
    const bytes = Number.parseInt(output.split(/\s+/u)[0], 10);
    return Number.isFinite(bytes) ? bytes : null;
  }

  // Point-in-time SQLite snapshot: VACUUM INTO produces a consistent,
  // standalone database even while Suite Manager keeps writing, which a plain
  // file copy of a WAL-mode database cannot guarantee.
  async snapshotSqlite(databasePath, targetPath) {
    if (!fs.existsSync(databasePath)) return;
    ensureDir(path.dirname(targetPath));
    try {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec(`VACUUM INTO '${targetPath.replace(/'/gu, "''")}'`);
      } finally {
        database.close();
      }
    } catch {
      fs.rmSync(targetPath, { force: true });
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(`${databasePath}${suffix}`)) fs.cpSync(`${databasePath}${suffix}`, `${targetPath}${suffix}`, { force: true, preserveTimestamps: true });
      }
    }
  }

  readBootstrapContract() {
    const contractPath = path.join(this.stateRoot, 'bootstrap-contract.env');
    if (!fs.existsSync(contractPath)) return {};
    return Object.fromEntries(fs.readFileSync(contractPath, 'utf8').split(/\r?\n/u).map((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
      if (!match) return null;
      return [match[1], match[2].trim().replace(/^['"]|['"]$/gu, '')];
    }).filter(Boolean));
  }

  async restoreStateOwnership() {
    const user = process.env.MOS_RUNTIME_USER || this.readBootstrapContract().MOS_RUNTIME_USER || 'mos';
    for (const target of [this.stateDir, path.join(this.stateRoot, 'homepage', 'config')]) {
      if (fs.existsSync(target)) this.optionalCommand('chown', ['-R', `${user}:${user}`, target], { timeout: 300_000 });
    }
    // Restoring app-packages recreates it from the bundle, which carries modes
    // but no ownership, so the root agent's snapshots come back owned
    // root:root and Suite Manager can no longer read the packages it must
    // re-verify on every read — every restored app would report an unreadable
    // snapshot. Put the provisioned identity back: root owns the writes,
    // mos-agent reads them, and the setgid root keeps that true for snapshots
    // written after the restore.
    const packageRoot = path.join(this.stateRoot, 'app-packages');
    if (fs.existsSync(packageRoot)) {
      this.optionalCommand('chown', ['-R', 'root:mos-agent', packageRoot], { timeout: 300_000 });
      this.optionalCommand('chmod', ['2750', packageRoot], { timeout: 60_000 });
    }
  }

  async sourceInfo() {
    return {
      branch: this.optionalCommand('git', ['branch', '--show-current']),
      commit: this.optionalCommand('git', ['rev-parse', 'HEAD']),
      repoDir: this.repoDir,
      version: fs.existsSync(path.join(this.repoDir, 'VERSION')) ? fs.readFileSync(path.join(this.repoDir, 'VERSION'), 'utf8').trim() : null,
    };
  }
}

module.exports = { BackupSystemAdapter };
