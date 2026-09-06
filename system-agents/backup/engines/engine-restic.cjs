// The backup storage engine: restic, and everything MOS knows about it.
//
// This file owns both halves — the process plumbing (locating the pinned
// binary, running it with the repository password in the environment instead
// of argv, translating failures into sentences an owner can act on, owning the
// machine-local repository key) and the CLI knowledge. They were split across
// a base class while MOS carried two candidate engines; one engine needs one
// file.
//
// A repository is addressed by a `location` rather than a directory, because a
// destination is no longer always a filesystem: a local drive's location is a
// path, a bucket's is an `s3:` URL, and only the first has a `localPath` to
// measure or delete. Credentials for the second travel in `env`, never in argv.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ENGINE_BINARY_DIR = '/usr/local/libexec/mos';
const REPOSITORY_KEY_FILENAME = 'engine-key';
const DEFAULT_TIMEOUT_MS = 3_600_000;
// Reaching a bucket must answer while an owner is still looking at the dialog.
// restic prints why a storage request failed straight away and then waits
// 13-20 seconds before retrying it, so this is long enough to have captured
// the reason and short enough that a wrong endpoint does not look like a hang.
const PROBE_TIMEOUT_MS = 25_000;
const AWS_ENVIRONMENT_KEYS = Object.freeze(['AWS_ACCESS_KEY_ID', 'AWS_DEFAULT_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
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

// Storage credentials are masked by exact value out of anything the engine
// wrote, before it reaches an error, a job record, or a support bundle. A
// rejected S3 request quotes the key it was signed with, so the alternative is
// an owner's secret sitting in a diagnostics file. Short values are left alone:
// masking a two-character string would blank half the output and hide the
// failure instead of the secret.
function maskSecrets(text, secrets = []) {
  let masked = String(text || '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) masked = masked.split(secret).join('••••••••');
  }
  return masked;
}

// Why a repository would not open, in the owner's terms.
//
// Order is the whole point. "The specified bucket does not exist" and "The
// specified key does not exist" are one word apart and mean opposite things:
// the first is a mistyped bucket name, the second is a bucket MOS simply has
// not written to yet. Reading them the same way told an owner their typo was
// "connected, no backups yet" and left the mistake to surface at three in the
// morning, so the narrower causes are matched first and only the last one is
// allowed to mean "there is nothing here, go ahead and create it".
//
// These patterns are matched against everything the engine wrote, not only its
// closing lines. restic retries a failing storage request with a backoff of
// 13-20 seconds and prints the reason immediately, then says nothing but
// "context canceled" when it is finally stopped: the truth is in the first
// line, and the last line is the sound of giving up.
const PROBE_CAUSES = Object.freeze([
  {
    cause: 'missing-bucket',
    message: 'MOS reached the storage provider, but it has no bucket with that name. Check the bucket name, or create the bucket with your provider first — MOS does not create one.',
    test: /nosuchbucket|specified bucket does not exist|bucket[^.\n]{0,40}does not exist/iu,
  },
  {
    cause: 'rejected-key',
    message: 'The storage provider rejected the access key. Check the key and its secret, that the key is allowed to use this bucket, and the region.',
    test: /signature we calculated does not match|signaturedoesnotmatch|invalidaccesskeyid|access ?denied|invalid.{0,20}credential|403 forbidden|401 unauthorized/iu,
  },
  {
    cause: 'unreachable-host',
    message: 'MOS could not reach that endpoint. Check the address, and that this server can reach it.',
    test: /no such host|connection refused|no route to host|network is unreachable|dial tcp|i\/o timeout|server misbehaving/iu,
  },
  {
    cause: 'tls',
    message: 'MOS reached that endpoint but could not establish a secure connection to it. Check that the address is right and that its certificate is valid.',
    test: /x509|certificate|tls handshake|unknown authority/iu,
  },
  {
    cause: 'absent',
    message: null,
    test: /repository does not exist|specified key does not exist|unable to open config file|no such file|nosuchkey|repository (?:is )?not initialized|config file not found/iu,
  },
]);

function repositoryProbeCause(output) {
  const text = String(output || '');
  return PROBE_CAUSES.find((entry) => entry.test.test(text)) || { cause: 'unknown', message: null };
}

function repositoryProbeVerdict(output) {
  return repositoryProbeCause(output).cause === 'absent' ? 'absent' : 'unreachable';
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
  // The whole output is what gets classified; only the display copy is
  // trimmed. A storage failure names itself in its first line and then repeats
  // "context canceled" until it is stopped, so judging by the tail alone reads
  // the giving-up rather than the reason.
  describeFailure(error, secrets = []) {
    const output = maskSecrets([error?.stderr, error?.stdout].map((part) => String(part || '').trim()).filter(Boolean).join('\n'), secrets);
    const tail = output.split(/\r?\n/u).slice(-12).join('\n').trim();
    const failure = new Error(this.failureMessage(error, output));
    failure.engineCause = repositoryProbeCause(output).cause;
    failure.engineName = this.name;
    failure.engineOutput = tail || null;
    return failure;
  }

  // The conditions an owner can actually act on are said in their own terms;
  // everything else keeps the engine's sentence, because a vague message about
  // an unknown failure helps nobody. The full output is on the error either
  // way, for a support panel.
  // A named cause beats the fact that the command was eventually stopped:
  // restic keeps retrying a rejected key until it is killed, so reporting the
  // timeout would tell an owner to wait longer for something that will never
  // work.
  failureMessage(error, output) {
    const named = repositoryProbeCause(output);
    if (named.message) return named.message;
    if (/no space left on device|quota exceeded/iu.test(output)) return 'The backup destination ran out of space while the backup was being written. Free space on it, then run a new backup.';
    if (/permission denied|operation not permitted/iu.test(output)) return 'The backup drive refused to be written to. Check that it is not write-protected, then try again.';
    if (/input\/output error/iu.test(output)) return 'The backup drive reported a read or write error. The drive may be failing; try another drive.';
    if (error?.code === 'ETIMEDOUT') return 'The backup storage engine did not answer in time and was stopped. If this is object storage, check the endpoint address and this server\'s connection.';
    const reason = significantLine(output);
    return `The backup storage engine reported a problem: ${reason || 'no further detail was reported'}.`;
  }

  // `discardStdout` streams the engine's stdout to nowhere instead of
  // buffering it — for operations whose output is the data itself (a dump used
  // as a read-everything integrity check), where capturing it would buffer
  // gigabytes. `input` feeds stdin, for the one write whose source is a string
  // rather than a directory.
  environmentFor(env = {}) {
    const environment = { ...process.env, HOME: this.agentStateDir, RESTIC_PASSWORD: ensureRepositoryKey(this.keyFile) };
    // A repository that carries no credentials is addressed with none: without
    // this, a stray AWS key in the agent's own environment would be signed onto
    // requests for a destination that never asked for it.
    for (const key of AWS_ENVIRONMENT_KEYS) delete environment[key];
    return Object.assign(environment, env);
  }

  run(args, { cwd, discardStdout = false, env = {}, input, secrets = [], timeout = DEFAULT_TIMEOUT_MS } = {}) {
    this.assertInstalled();
    ensureDir(this.cacheDir());
    try {
      return execFileSync(this.binaryPath, args, {
        cwd: cwd || this.agentStateDir,
        encoding: 'utf8',
        env: this.environmentFor(env),
        ...(input === undefined ? {} : { input }),
        maxBuffer: 256 * 1024 * 1024,
        stdio: [input === undefined ? 'ignore' : 'pipe', discardStdout ? 'ignore' : 'pipe', 'pipe'],
        timeout,
      }) || '';
    } catch (error) {
      throw this.describeFailure(error, secrets);
    }
  }

  // Every repository-addressed command goes through here so the credentials and
  // the masking travel with the repository instead of with each call site.
  runFor(repository, args, options = {}) {
    return this.run(args, { ...options, env: repository.env || {}, secrets: repository.secrets || [] });
  }

  // A local repository's stored size is measured from its directory: the CLI
  // reports it in a form not worth a version-sensitive parser when the truth is
  // on disk. A bucket has no directory to walk, so there the engine is asked —
  // one call, and the only place its stats output is parsed.
  async repositoryStats({ repository }) {
    if (repository.localPath) return { storedBytes: treeBytes(repository.localPath) };
    try {
      const parsed = JSON.parse(this.runFor(repository, ['stats', '--mode', 'raw-data', '--json', ...this.repositoryFlags(repository)], { timeout: PROBE_TIMEOUT_MS * 5 }) || '{}');
      return { storedBytes: Number.isFinite(parsed.total_size) ? parsed.total_size : null };
    } catch {
      return { storedBytes: null };
    }
  }

  repositoryFlags(repository) {
    return [`--repo=${repository.location}`, `--cache-dir=${this.cacheDir()}`];
  }

  repositoryInitialized(repositoryPath) {
    return fs.existsSync(path.join(repositoryPath, 'config'));
  }

  // Runs a command and stops it as soon as its output has said something
  // conclusive, rather than waiting for it to finish. restic answers a failing
  // storage request by printing the reason and then sleeping 13-20 seconds
  // before trying the same thing again, so waiting for the exit code means an
  // owner stares at a dialog for half a minute after the answer already
  // arrived.
  runStreaming(args, { decisive = () => false, env = {}, timeout = PROBE_TIMEOUT_MS } = {}) {
    this.assertInstalled();
    ensureDir(this.cacheDir());
    return new Promise((resolve) => {
      const child = spawn(this.binaryPath, args, { cwd: this.agentStateDir, env: this.environmentFor(env), stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false;
      let stderr = '';
      let stdout = '';
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.status === null) child.kill('SIGKILL');
        resolve({ stderr, stdout, ...result });
      };
      const timer = setTimeout(() => finish({ status: null, timedOut: true }), timeout);
      const watch = () => { if (decisive(`${stderr}\n${stdout}`)) finish({ decided: true, status: null, timedOut: false }); };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; watch(); });
      child.stderr.on('data', (chunk) => { stderr += chunk; watch(); });
      child.on('error', () => finish({ status: -1, timedOut: false }));
      child.on('close', (status) => finish({ status: status ?? -1, timedOut: false }));
    });
  }

  // Answers whether a repository can be opened at all, without creating one.
  // The connection test and the create path both need this, and neither may
  // guess: `absent` is the only verdict that permits writing to the location.
  async probeRepository({ env = {}, location, secrets = [] }) {
    const result = await this.runStreaming(['cat', 'config', `--repo=${location}`, `--cache-dir=${this.cacheDir()}`], {
      decisive: (text) => repositoryProbeCause(text).cause !== 'unknown',
      env,
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.status === 0) {
      try {
        return { cause: 'open', repositoryId: JSON.parse(result.stdout || '{}').id || null, state: 'open' };
      } catch {}
    }
    const output = maskSecrets(`${result.stderr}\n${result.stdout}`.trim(), secrets);
    const named = repositoryProbeCause(output);
    return {
      cause: named.cause,
      message: named.message || this.failureMessage({ code: result.timedOut ? 'ETIMEDOUT' : null }, output),
      output: output.split(/\r?\n/u).slice(-12).join('\n').trim() || null,
      state: named.cause === 'absent' ? 'absent' : 'unreachable',
    };
  }

  async openOrCreateRepository({ create = true, env = {}, localPath = null, location, missingMessage, secrets = [] }) {
    const repository = { engineName: this.name, env, localPath, location, secrets };
    // A local repository is judged by its config file, which is free and exact.
    // A remote one has to be asked, and a refusal that is not "there is nothing
    // here" must never be answered by creating a second repository.
    const probe = localPath
      ? { state: this.repositoryInitialized(localPath) ? 'open' : 'absent' }
      : await this.probeRepository({ env, location, secrets });
    if (probe.state === 'unreachable') throw Object.assign(new Error(probe.message), { engineName: this.name, engineOutput: probe.output || null });
    const created = probe.state === 'absent';
    if (created) {
      // Flagged, because "there is no repository here yet" is a normal answer
      // for a destination nothing has been written to and a fatal one for a
      // backup being read back. Only the caller knows which it is asking.
      if (!create) throw Object.assign(new Error(missingMessage || 'The encrypted backup store is missing from this destination, so this backup cannot be read.'), { repositoryAbsent: true });
      if (localPath) fs.mkdirSync(localPath, { recursive: true });
      this.runFor(repository, ['init', ...this.repositoryFlags(repository)], { timeout: 600_000 });
    } else {
      if (localPath) this.runFor(repository, ['cat', 'config', ...this.repositoryFlags(repository)], { timeout: 600_000 });
      this.clearStaleLocks(repository);
    }
    // A local destination is identified by the descriptor MOS writes beside the
    // repository, so only a remote one needs the engine's own id — and asking
    // for it costs a request against the bucket.
    const repositoryId = localPath ? null : probe.repositoryId || this.repositoryConfigId(repository);
    return { ...repository, created, repositoryId };
  }

  // restic's own repository id, which identifies the store independently of
  // where it is addressed from. A bucket therefore needs no descriptor file of
  // MOS's own to be recognisable after its endpoint or prefix is re-entered.
  repositoryConfigId(repository) {
    try {
      return JSON.parse(this.runFor(repository, ['cat', 'config', ...this.repositoryFlags(repository)], { timeout: PROBE_TIMEOUT_MS }) || '{}').id || null;
    } catch {
      return null;
    }
  }

  // A backup killed by a power loss or a stopped worker leaves its lock
  // behind, and a measured run on the lab VM showed the next integrity check
  // refusing the repository over that lock rather than over anything wrong
  // with the data. MOS runs one backup job at a time and is the repository's
  // only writer, so a lock left by a process that is gone is always stale.
  // Plain `unlock` removes exactly those and leaves a live one alone.
  clearStaleLocks(repository) {
    try {
      this.runFor(repository, ['unlock', ...this.repositoryFlags(repository)], { timeout: 300_000 });
    } catch {}
  }

  tagFlags(tags = {}) {
    return Object.entries(tags).filter(([, value]) => value !== undefined && value !== null)
      .flatMap(([key, value]) => ['--tag', `${key}:${sanitizeTagValue(value)}`]);
  }

  async snapshotTree({ repository, sourceDir, tags = {} }) {
    const output = this.runFor(repository, ['backup', sourceDir, ...this.repositoryFlags(repository), '--json', ...this.tagFlags(tags)], { timeout: DATA_TIMEOUT_MS });
    return { snapshotId: this.snapshotIdFromBackup(output, repository), sourcePath: path.resolve(sourceDir) };
  }

  // Stores a small document as its own snapshot. This is how a destination
  // with no filesystem keeps the files that surround a repository — a restore
  // point's manifest, an owner's note — inside the repository itself, where
  // they inherit its encryption and its authentication instead of needing a
  // second protocol to put a plain file next to it.
  async snapshotDocument({ content, filename, repository, tags = {} }) {
    const output = this.runFor(repository, ['backup', '--stdin', '--stdin-filename', filename, ...this.repositoryFlags(repository), '--json', ...this.tagFlags(tags)], { input: content, timeout: DEFAULT_TIMEOUT_MS });
    return { snapshotId: this.snapshotIdFromBackup(output, repository) };
  }

  async readDocument({ filename, repository, snapshotId }) {
    return this.runFor(repository, ['dump', snapshotId, `/${filename}`, ...this.repositoryFlags(repository)], { timeout: DEFAULT_TIMEOUT_MS });
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
    const latest = this.listJson(repository, ['snapshots', ...this.repositoryFlags(repository), '--json', '--latest', '1']).pop();
    if (!latest?.id) throw new Error('The backup storage engine did not report a snapshot for the data it just stored.');
    return latest.id;
  }

  listJson(repository, args) {
    const output = this.runFor(repository, args).trim();
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
    this.runFor(repository, ['restore', selector, '--target', targetDir, ...this.repositoryFlags(repository)], { timeout: DATA_TIMEOUT_MS });
  }

  async listSnapshots({ repository }) {
    return this.listJson(repository, ['snapshots', ...this.repositoryFlags(repository), '--json'])
      .map((entry) => ({ createdAt: entry.time || null, snapshotId: entry.id, sourcePath: (entry.paths || [])[0] || null, tags: entry.tags || [] }));
  }

  async forgetSnapshots({ repository, snapshotIds }) {
    if (!snapshotIds.length) return;
    this.runFor(repository, ['forget', ...snapshotIds, ...this.repositoryFlags(repository)]);
  }

  async maintainRepository({ repository }) {
    this.runFor(repository, ['prune', ...this.repositoryFlags(repository)], { timeout: DATA_TIMEOUT_MS });
  }

  // restic has no per-snapshot deep verify, and its structural check reads
  // indexes rather than data — measured on the real binary, a flipped byte in
  // a pack file passes `check --no-cache` untouched. Streaming each snapshot
  // through `dump` to nowhere reads, decrypts, and authenticates every blob
  // the restore point needs and nothing else, which is the scoped guarantee
  // MOS wants: the same flipped byte makes it refuse.
  async verifySnapshots({ repository, snapshotIds }) {
    this.runFor(repository, ['check', '--no-cache', `--repo=${repository.location}`], { timeout: DATA_TIMEOUT_MS });
    for (const snapshotId of snapshotIds) {
      this.runFor(repository, ['dump', snapshotId, '/', '--no-cache', ...this.repositoryFlags(repository)], { discardStdout: true, timeout: DATA_TIMEOUT_MS });
    }
  }

  async verifyRepository({ deep = true, repository }) {
    this.runFor(repository, ['check', `--repo=${repository.location}`, '--no-cache', ...(deep ? ['--read-data'] : [])], { timeout: DATA_TIMEOUT_MS });
  }
}

module.exports = {
  DATA_TIMEOUT_MS,
  ENGINE_BINARY_DIR,
  ensureRepositoryKey,
  maskSecrets,
  PROBE_TIMEOUT_MS,
  REPOSITORY_KEY_FILENAME,
  repositoryProbeCause,
  repositoryProbeVerdict,
  ResticEngine,
  significantLine,
  treeBytes,
};
