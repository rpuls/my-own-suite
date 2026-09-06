// The backup storage engine: restic, and everything MOS knows about it.
//
// This file owns both halves — the process plumbing (locating the pinned
// binary, running it with the repository password in the environment instead
// of argv, translating failures into sentences an owner can act on, owning the
// machine-local repository key) and the CLI knowledge. They were split across
// a base class while MOS carried two candidate engines; one engine needs one
// file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENGINE_BINARY_DIR = '/usr/local/libexec/mos';
const REPOSITORY_KEY_FILENAME = 'engine-key';
const DEFAULT_TIMEOUT_MS = 3_600_000;
// Operations that move the data itself — snapshot, restore, verify-by-reading,
// maintenance — take as long as the data takes: a first backup near the beta
// size cap over USB can legitimately run for hours, and killing it at 90% is
// worse than waiting. The day-long ceiling only exists so a hung engine on a
// dead drive cannot pin the job pipeline forever.
const DATA_TIMEOUT_MS = 86_400_000;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

// The repository password never leaves the machine that generated it. It is
// written root-only into the agent state directory, which
// `managedStateTargets` classifies machine-local and never backs up, so a
// backup can never carry its own key. A machine restoring its own backups
// still has it, which is why same-machine restore never prompts.
function ensureRepositoryKey(keyFile) {
  if (fs.existsSync(keyFile)) {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing) return existing;
  }
  ensureDir(path.dirname(keyFile));
  fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  return fs.readFileSync(keyFile, 'utf8').trim();
}

const PROGRESS_LINE = /^\[[\d:]|%|\bETA\b|\bprocessed\b/iu;
const FAILURE_WORDS = /\berror|\bfatal|\bfailed|\bcannot\b|\bunable\b|\binvalid\b|\bcorrupt|\bdenied\b|\bno space\b/iu;

// restic reports under --json, so the useful sentence is a field rather than
// the line. Unwrap it before anything else looks at the text.
function unwrapJsonLine(line) {
  if (!line.startsWith('{')) return line;
  try {
    const parsed = JSON.parse(line);
    return String(parsed.message || parsed.error || line).trim();
  } catch {
    return line;
  }
}

function significantLine(output) {
  const lines = String(output || '').split(/\r?\n/u).map((line) => unwrapJsonLine(line.trim())).filter(Boolean);
  const named = lines.filter((line) => FAILURE_WORDS.test(line));
  if (named.length) return named[named.length - 1];
  const quiet = lines.filter((line) => !PROGRESS_LINE.test(line));
  return quiet.length ? quiet[quiet.length - 1] : lines[lines.length - 1] || null;
}

function treeBytes(root) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) total += treeBytes(absolute);
    else if (entry.isFile()) { try { total += fs.statSync(absolute).size; } catch {} }
  }
  return total;
}

function sanitizeTagValue(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]+/gu, '-').slice(0, 120) || 'unknown';
}

class ResticEngine {
  constructor({ agentStateDir, binaryDir = ENGINE_BINARY_DIR, keyFile } = {}) {
    this.agentStateDir = agentStateDir;
    this.binaryDir = binaryDir;
    this.keyFile = keyFile || path.join(agentStateDir || '.', REPOSITORY_KEY_FILENAME);
  }

  get name() { return 'restic'; }

  get binaryPath() { return path.join(this.binaryDir, this.name); }

  installed() { return fs.existsSync(this.binaryPath); }

  assertInstalled() {
    if (this.installed()) return;
    throw new Error('The backup storage engine is not installed on this machine. Run a platform update to install it, then try again.');
  }

  cacheDir() { return path.join(this.agentStateDir, 'engine-cache', this.name); }

  // Verification has to read the repository, not a local copy of what the
  // repository said last time, so integrity checks run --no-cache throughout.
  dropCache() { fs.rmSync(this.cacheDir(), { force: true, recursive: true }); }

  // Failures carry the engine's own last output on the error rather than in
  // the message: the message is what an owner reads, the output is what a
  // support panel shows.
  describeFailure(error) {
    const output = [error?.stderr, error?.stdout].map((part) => String(part || '').trim()).filter(Boolean).join('\n');
    const tail = output.split(/\r?\n/u).slice(-12).join('\n').trim();
    const failure = new Error(this.failureMessage(error, tail));
    failure.engineName = this.name;
    failure.engineOutput = tail || null;
    return failure;
  }

  // The conditions an owner can actually act on are said in their own terms;
  // everything else keeps the engine's sentence, because a vague message about
  // an unknown failure helps nobody. The full output is on the error either
  // way, for a support panel.
  failureMessage(error, tail) {
    if (error?.code === 'ETIMEDOUT') return 'The backup storage engine did not finish in time and was stopped.';
    if (/no space left on device/iu.test(tail)) return 'The backup drive ran out of space while the backup was being written. Free space on the drive, then run a new backup.';
    if (/permission denied|operation not permitted/iu.test(tail)) return 'The backup drive refused to be written to. Check that it is not write-protected, then try again.';
    if (/input\/output error/iu.test(tail)) return 'The backup drive reported a read or write error. The drive may be failing; try another drive.';
    const reason = significantLine(tail);
    return `The backup storage engine reported a problem: ${reason || 'no further detail was reported'}.`;
  }

  // `discardStdout` streams the engine's stdout to nowhere instead of
  // buffering it — for operations whose output is the data itself (a dump used
  // as a read-everything integrity check), where capturing it would buffer
  // gigabytes.
  run(args, { cwd, discardStdout = false, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    this.assertInstalled();
    ensureDir(this.cacheDir());
    try {
      return execFileSync(this.binaryPath, args, {
        cwd: cwd || this.agentStateDir,
        encoding: 'utf8',
        env: { ...process.env, HOME: this.agentStateDir, RESTIC_PASSWORD: ensureRepositoryKey(this.keyFile) },
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', discardStdout ? 'ignore' : 'pipe', 'pipe'],
        timeout,
      }) || '';
    } catch (error) {
      throw this.describeFailure(error);
    }
  }

  // Stored size is measured from the repository directory rather than asked of
  // the engine: the CLI reports it in a form not worth a version-sensitive
  // parser when the truth is on disk.
  async repositoryStats({ repository }) {
    return { storedBytes: treeBytes(repository.repositoryPath) };
  }

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
  // contents directly.
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

module.exports = {
  DATA_TIMEOUT_MS,
  ENGINE_BINARY_DIR,
  ensureRepositoryKey,
  REPOSITORY_KEY_FILENAME,
  ResticEngine,
  significantLine,
  treeBytes,
};
