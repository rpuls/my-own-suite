#!/usr/bin/env node

// Repository-level resilience checks for a backup storage engine: what a
// killed backup and a full destination leave behind.
//
// These sit below the MOS drills, which cover the same events at the level of
// the whole machine. What is asked here is narrower and is the engine's own
// responsibility: after a backup is killed mid-write or refused for space, is
// the repository still openable, still honest about what it holds, and still
// able to accept the next backup?
//
// Usage:
//   node scripts/backup-engine-resilience.cjs --engine restic \
//     --binary-dir /home/mos/engines/bin --work-dir /home/mos/resilience \
//     --destination /media/mos-backup/resilience --corpus /home/mos/corpus

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createEngine } = require('../system-agents/backup/engines/engine.cjs');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const engineName = arg('engine', 'kopia');
const binaryDir = arg('binary-dir', '/usr/local/libexec/mos');
const workDir = arg('work-dir', path.join(os.tmpdir(), 'mos-engine-resilience'));
const destination = arg('destination', path.join(workDir, 'destination'));
const corpusDir = arg('corpus', path.join(workDir, 'corpus'));
const mode = arg('mode', 'all');

const agentStateDir = path.join(workDir, 'agent-state', engineName);
const repositoryPath = path.join(destination, engineName, 'repository');
const fillerPath = path.join(destination, 'filler.bin');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function engine() { return createEngine({ agentStateDir, binaryDir, name: engineName }); }
function freeBytes(dir) { const stat = fs.statfsSync(dir); return stat.bavail * stat.bsize; }

// Deduplication makes a repeat of known data almost free, which would let a
// full destination look survivable when it is not. Every scenario that needs
// the engine to actually write bytes gets data the repository has never seen.
function unseenData(name, megabytes) {
  const dir = path.join(workDir, 'unseen', name);
  fs.rmSync(dir, { force: true, recursive: true });
  ensureDir(dir);
  execFileSync('dd', ['if=/dev/urandom', `of=${path.join(dir, 'blob.bin')}`, 'bs=1M', `count=${megabytes}`, 'status=none'], { timeout: 600_000 });
  return dir;
}

// Run as a child so it can be killed outright; the engine itself runs
// synchronously inside its own process, exactly as the backup agent runs it.
async function snapshotOnly() {
  const active = engine();
  const repository = await active.openOrCreateRepository({ repositoryPath });
  await active.snapshotTree({ repository, sourceDir: arg('source', corpusDir), tags: { mosrole: 'resilience' } });
}

// The question is whether a killed backup damages backups already taken, so
// there has to be one to damage.
async function seedRepository() {
  const active = engine();
  const repository = await active.openOrCreateRepository({ repositoryPath });
  await active.snapshotTree({ repository, sourceDir: corpusDir, tags: { mosrole: 'baseline' } });
  return (await active.listSnapshots({ repository })).length;
}

function killedMidBackup(afterMs, sourceDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, '--mode', 'snapshot-only', '--engine', engineName, '--binary-dir', binaryDir, '--work-dir', workDir, '--destination', destination, '--corpus', corpusDir, '--source', sourceDir], {
      detached: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, afterMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function afterKillReport() {
  const report = {};
  const active = engine();
  try {
    const repository = await active.openOrCreateRepository({ repositoryPath });
    report.reopened = true;
    report.recreatedInsteadOfReopened = repository.created === true;
    report.snapshotsListed = (await active.listSnapshots({ repository })).length;
    try {
      await active.verifyRepository({ deep: true, repository });
      report.verifyAfterKill = 'passed';
    } catch (error) {
      report.verifyAfterKill = `refused: ${error.message}`;
    }
    try {
      const next = await active.snapshotTree({ repository, sourceDir: unseenData('after-kill', 50), tags: { mosrole: 'after-kill' } });
      report.nextBackupAccepted = Boolean(next.snapshotId);
      report.snapshotsAfterNextBackup = (await active.listSnapshots({ repository })).length;
    } catch (error) {
      report.nextBackupAccepted = false;
      report.nextBackupError = error.message;
    }
  } catch (error) {
    report.reopened = false;
    report.reopenError = error.message;
  }
  return report;
}

// fallocate reserves the space without writing it, so the destination can be
// taken to the edge in a second rather than by copying gigabytes.
function fillDestination(leaveBytes) {
  const available = freeBytes(destination);
  const size = Math.max(0, available - leaveBytes);
  execFileSync('fallocate', ['-l', String(size), fillerPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  return { filledBytes: size, freeAfter: freeBytes(destination) };
}

async function outOfSpaceReport() {
  const report = {};
  const active = engine();
  const repository = await active.openOrCreateRepository({ repositoryPath });
  const source = unseenData('out-of-space', 300);
  report.filler = fillDestination(24 * 1024 * 1024);
  try {
    await active.snapshotTree({ repository, sourceDir: source, tags: { mosrole: 'out-of-space' } });
    report.refused = false;
  } catch (error) {
    report.refused = true;
    report.message = error.message;
    report.engineOutputTail = (error.engineOutput || '').split(/\r?\n/u).slice(-2).join(' | ');
  }
  fs.rmSync(fillerPath, { force: true });
  report.freeAfterCleanup = freeBytes(destination);
  try {
    const reopened = await active.openOrCreateRepository({ repositoryPath });
    await active.verifyRepository({ deep: true, repository: reopened });
    report.repositoryUsableAfterwards = true;
  } catch (error) {
    report.repositoryUsableAfterwards = false;
    report.repositoryError = error.message;
  }
  return report;
}

async function main() {
  ensureDir(workDir);
  ensureDir(agentStateDir);
  ensureDir(destination);

  if (mode === 'snapshot-only') { await snapshotOnly(); return; }

  const results = { engine: engineName, startedAt: new Date().toISOString() };
  results.baselineSnapshots = await seedRepository();
  // Large enough that both engines are still writing when the kill lands: a
  // snapshot that finished first proves nothing about an interrupted one.
  const killSource = unseenData('killed', Number(arg('kill-source-mb', '1500')));
  const killed = await killedMidBackup(Number(arg('kill-after-ms', '2000')), killSource);
  results.killedMidBackup = { exit: killed, ...(await afterKillReport()) };
  results.baselineSurvived = results.killedMidBackup.snapshotsListed >= results.baselineSnapshots;
  results.outOfSpace = await outOfSpaceReport();
  results.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
