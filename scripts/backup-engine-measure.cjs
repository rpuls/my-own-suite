#!/usr/bin/env node

// Measures a backup storage engine on the four axes that decide which one MOS
// keeps: peak memory on a small machine, restore fidelity, refusal to restore
// corrupted data, and recovery from repository plus key alone.
//
// It drives the real engine modules rather than the CLIs directly, so what is
// measured is what the backup agent will actually run. Peak memory is captured
// by putting a /usr/bin/time wrapper on PATH under the engine's own binary
// name, which needs no measurement code inside the engine itself.
//
// Usage:
//   node scripts/backup-engine-measure.cjs --engine kopia \
//     --binary-dir /home/mos/engines/bin --work-dir /home/mos/measure \
//     --destination /media/mos-backup/measure --corpus /home/mos/corpus

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createEngine } = require('../system-agents/backup/engines/engine.cjs');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const engineName = arg('engine', 'kopia');
const realBinaryDir = arg('binary-dir', '/usr/local/libexec/mos');
const workDir = arg('work-dir', path.join(os.tmpdir(), 'mos-engine-measure'));
const destination = arg('destination', path.join(workDir, 'destination'));
const corpusDir = arg('corpus', path.join(workDir, 'corpus'));

const wrapperDir = path.join(workDir, 'wrappers', engineName);
const timeLog = path.join(workDir, `${engineName}-time.log`);
const agentStateDir = path.join(workDir, 'agent-state', engineName);
const repositoryPath = path.join(destination, engineName, 'repository');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function sh(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

// The wrapper carries the engine's own name so the engine module finds it
// exactly where it expects its binary.
function installWrapper() {
  ensureDir(wrapperDir);
  const wrapper = path.join(wrapperDir, engineName);
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/time -v -a -o ${timeLog} ${path.join(realBinaryDir, engineName)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
}

function resetTimeLog() { fs.writeFileSync(timeLog, ''); }

function peakBytesFromLog() {
  let peak = 0;
  for (const line of fs.readFileSync(timeLog, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
    if (match) peak = Math.max(peak, Number(match[1]) * 1024);
  }
  return peak;
}

async function measure(label, run) {
  resetTimeLog();
  const startedAt = process.hrtime.bigint();
  let failure = null;
  try {
    await run();
  } catch (error) {
    failure = error.message;
  }
  const wallMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  return { error: failure, label, peakBytes: peakBytesFromLog(), wallMs };
}

function treeBytes(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) total += treeBytes(absolute);
    else if (entry.isFile()) total += fs.lstatSync(absolute).size;
  }
  return total;
}

// A corpus shaped like real app data: many small files, a few large ones that
// compress and a few that cannot, plus the metadata a restore has to carry
// back — modes, symlinks, timestamps, an empty directory.
function buildCorpus() {
  if (fs.existsSync(path.join(corpusDir, '.built'))) return;
  ensureDir(corpusDir);
  for (let bucket = 0; bucket < 20; bucket += 1) {
    const dir = path.join(corpusDir, 'small', `bucket-${bucket}`);
    ensureDir(dir);
    for (let index = 0; index < 500; index += 1) {
      const size = 512 + ((bucket * 37 + index * 11) % 7680);
      fs.writeFileSync(path.join(dir, `file-${index}.dat`), Buffer.alloc(size, (index % 251) + 1));
    }
  }
  ensureDir(path.join(corpusDir, 'large'));
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(path.join(corpusDir, 'large', `compressible-${index}.log`), Buffer.alloc(100 * 1024 * 1024, 0x41));
    sh('dd', ['if=/dev/urandom', `of=${path.join(corpusDir, 'large', `random-${index}.bin`)}`, 'bs=1M', 'count=100', 'status=none']);
  }
  ensureDir(path.join(corpusDir, 'empty-dir'));
  fs.writeFileSync(path.join(corpusDir, 'executable.sh'), '#!/bin/sh\necho hello\n', { mode: 0o750 });
  fs.chmodSync(path.join(corpusDir, 'executable.sh'), 0o750);
  fs.writeFileSync(path.join(corpusDir, 'private.key'), 'not-a-real-key\n', { mode: 0o600 });
  fs.chmodSync(path.join(corpusDir, 'private.key'), 0o600);
  fs.symlinkSync('../large/compressible-0.log', path.join(corpusDir, 'small', 'link-to-large'));
  fs.utimesSync(path.join(corpusDir, 'executable.sh'), new Date('2021-03-04T05:06:07Z'), new Date('2021-03-04T05:06:07Z'));
  fs.writeFileSync(path.join(corpusDir, '.built'), 'ok\n');
}

function describeTree(root) {
  const entries = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      entries.set(relative, {
        gid: stat.gid,
        kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : 'file',
        mode: stat.mode & 0o7777,
        mtime: Math.floor(stat.mtimeMs / 1000),
        size: entry.isDirectory() ? 0 : stat.size,
        target: entry.isSymbolicLink() ? fs.readlinkSync(absolute) : null,
        uid: stat.uid,
      });
      if (entry.isDirectory()) walk(absolute);
    }
  };
  walk(root);
  return entries;
}

function compareTrees(source, restored) {
  const left = describeTree(source);
  const right = describeTree(restored);
  const differences = [];
  for (const [relative, expected] of left) {
    if (relative === '.built') continue;
    const actual = right.get(relative);
    if (!actual) { differences.push({ field: 'missing', path: relative }); continue; }
    for (const field of ['gid', 'kind', 'mode', 'mtime', 'size', 'target', 'uid']) {
      if (expected[field] !== actual[field]) differences.push({ actual: actual[field], expected: expected[field], field, path: relative });
    }
  }
  for (const relative of right.keys()) {
    if (!left.has(relative) && relative !== '.built') differences.push({ field: 'unexpected', path: relative });
  }
  return { differences: differences.slice(0, 25), differenceCount: differences.length, entriesCompared: left.size };
}

// Flipping a byte in the largest stored object is the closest stand-in for the
// bit rot and half-written blocks a drive actually produces.
function corruptLargestRepositoryObject() {
  const candidates = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) candidates.push({ path: absolute, size: fs.statSync(absolute).size });
    }
  };
  walk(repositoryPath);
  const target = candidates.sort((left, right) => right.size - left.size)[0];
  // restic stores pack files read-only; bit rot does not ask permission.
  fs.chmodSync(target.path, 0o644);
  const handle = fs.openSync(target.path, 'r+');
  try {
    const offset = Math.floor(target.size / 2);
    const buffer = Buffer.alloc(1);
    fs.readSync(handle, buffer, 0, 1, offset);
    buffer[0] ^= 0xff;
    fs.writeSync(handle, buffer, 0, 1, offset);
  } finally {
    fs.closeSync(handle);
  }
  return { bytes: target.size, path: target.path };
}

async function main() {
  ensureDir(workDir);
  ensureDir(agentStateDir);
  installWrapper();
  buildCorpus();
  const corpusBytes = treeBytes(corpusDir);

  const engine = createEngine({ agentStateDir, binaryDir: wrapperDir, name: engineName });
  const results = { corpusBytes, engine: engineName, host: os.hostname(), startedAt: new Date().toISOString(), totalMemoryBytes: os.totalmem() };

  const repository = await engine.openOrCreateRepository({ repositoryPath });
  results.initial = await measure('initial backup', () => engine.snapshotTree({ repository, sourceDir: corpusDir, tags: { mosrole: 'measure' } }));
  const firstSnapshot = (await engine.listSnapshots({ repository })).pop();
  results.repositoryBytesAfterInitial = treeBytes(repositoryPath);

  // A second backup after a small change is the shape of every backup after
  // the first, so it is measured separately.
  fs.writeFileSync(path.join(corpusDir, 'small', 'bucket-0', 'file-0.dat'), Buffer.alloc(4096, 9));
  sh('dd', ['if=/dev/urandom', `of=${path.join(corpusDir, 'large', 'random-0.bin')}`, 'bs=1M', 'count=20', 'conv=notrunc', 'status=none']);
  results.incremental = await measure('incremental backup', () => engine.snapshotTree({ repository, sourceDir: corpusDir, tags: { mosrole: 'measure' } }));
  const secondSnapshot = (await engine.listSnapshots({ repository })).pop();
  results.repositoryBytesAfterIncremental = treeBytes(repositoryPath);

  const restoreTarget = path.join(workDir, 'restored', engineName);
  fs.rmSync(restoreTarget, { force: true, recursive: true });
  results.restore = await measure('restore', () => engine.restoreSnapshot({ repository, snapshotId: secondSnapshot.snapshotId, sourcePath: path.resolve(corpusDir), targetDir: restoreTarget }));
  results.fidelity = compareTrees(corpusDir, restoreTarget);
  results.fidelityCaveat = process.getuid && process.getuid() !== 0 ? 'Ran unprivileged: every file was owned by one user, so uid/gid restoration across owners is not proven here.' : null;

  // Replacement machine: nothing carried over but the repository on the drive
  // and the key, in a state directory that has never seen this repository.
  const replacementState = path.join(workDir, 'replacement', engineName);
  fs.rmSync(replacementState, { force: true, recursive: true });
  ensureDir(replacementState);
  fs.copyFileSync(path.join(agentStateDir, 'engine-key'), path.join(replacementState, 'engine-key'));
  const replacementEngine = createEngine({ agentStateDir: replacementState, binaryDir: wrapperDir, name: engineName });
  const replacementTarget = path.join(workDir, 'replacement-restore', engineName);
  fs.rmSync(replacementTarget, { force: true, recursive: true });
  results.replacementRecovery = await measure('replacement-machine restore', async () => {
    const reopened = await replacementEngine.openOrCreateRepository({ repositoryPath });
    if (reopened.created) throw new Error('The repository was recreated instead of reopened.');
    await replacementEngine.restoreSnapshot({ repository: reopened, snapshotId: firstSnapshot.snapshotId, sourcePath: path.resolve(corpusDir), targetDir: replacementTarget });
  });
  results.replacementRecovery.restoredEntries = fs.existsSync(replacementTarget) ? describeTree(replacementTarget).size : 0;

  // Deleting is the owner-facing operation with the least-understood memory
  // shape — forget is cheap but the reclaiming maintenance pass is the
  // engines' historical worst case — so it is measured, not assumed. The
  // first snapshot is sacrificed; everything after here uses the second.
  results.deleteAndMaintain = await measure('forget + reclaim (maintenance)', async () => {
    await engine.forgetSnapshots({ repository, snapshotIds: [firstSnapshot.snapshotId] });
    await engine.maintainRepository({ repository });
  });
  results.repositoryBytesAfterMaintenance = treeBytes(repositoryPath);

  // Destructive, so it runs last: everything above needs an intact repository.
  results.verifyClean = await measure('verify (intact)', () => engine.verifyRepository({ deep: true, repository }));
  const corrupted = corruptLargestRepositoryObject();
  results.corruption = await measure('verify (corrupted)', () => engine.verifyRepository({ deep: true, repository }));
  results.corruption.corruptedObject = { bytes: corrupted.bytes, path: path.relative(repositoryPath, corrupted.path) };
  results.corruption.refused = Boolean(results.corruption.error);

  results.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
