// Shared plumbing for the backup storage engines: locating the pinned binary,
// running it with the repository password in the environment instead of argv,
// and owning the machine-local repository key. Engine-specific CLI knowledge
// lives in engine-kopia.cjs and engine-restic.cjs; nothing here knows which
// engine is configured.

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
// backup can neither carry its own key nor leak one into a legacy unencrypted
// bundle. A machine restoring its own backups still has it, which is why
// same-machine restore never prompts.
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

class BackupEngineBase {
  constructor({ agentStateDir, binaryDir = ENGINE_BINARY_DIR, keyFile } = {}) {
    this.agentStateDir = agentStateDir;
    this.binaryDir = binaryDir;
    this.keyFile = keyFile || path.join(agentStateDir || '.', REPOSITORY_KEY_FILENAME);
  }

  get binaryPath() { return path.join(this.binaryDir, this.name); }

  installed() { return fs.existsSync(this.binaryPath); }

  assertInstalled() {
    if (this.installed()) return;
    throw new Error('The backup storage engine is not installed on this machine. Run a platform update to install it, then try again.');
  }

  cacheDir() { return path.join(this.agentStateDir, 'engine-cache', this.name); }

  // Verification has to read the repository, not a local copy of what the
  // repository said last time. A measured run on the lab VM showed Kopia
  // reporting a corrupted repository as healthy purely because the damaged
  // blob was still in its content cache, so the cache is dropped before an
  // integrity check rather than trusted. It costs a rebuild on the next
  // backup, which is the correct price for an honest answer.
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
        env: { ...process.env, HOME: this.agentStateDir, [this.passwordEnvVar]: ensureRepositoryKey(this.keyFile) },
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', discardStdout ? 'ignore' : 'pipe', 'pipe'],
        timeout,
      }) || '';
    } catch (error) {
      throw this.describeFailure(error);
    }
  }

  // Stored size is measured from the repository directory rather than asked of
  // the engine: both CLIs report it differently and neither number is worth a
  // version-sensitive parser when the truth is on disk.
  async repositoryStats({ repository }) {
    return { storedBytes: treeBytes(repository.repositoryPath) };
  }
}

module.exports = {
  BackupEngineBase,
  DATA_TIMEOUT_MS,
  significantLine,
  ENGINE_BINARY_DIR,
  ensureRepositoryKey,
  REPOSITORY_KEY_FILENAME,
  treeBytes,
};
