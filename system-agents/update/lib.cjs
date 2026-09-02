const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const { CommandFailure, describeFailure, runCommand: runCaptured } = require('../lib/command-output.cjs');

const DEFAULT_REPO = 'rpuls/my-own-suite';
// No apply step has a reason to run this long; one that does is stuck, and a
// stuck step used to hold the job open forever.
const STEP_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_BRANCH_REF = 'main';
const SAFE_BRANCH_REF = /^[A-Za-z0-9._/-]+$/u;
const SAFE_RELEASE_VERSION = /^\d+\.\d+\.\d+$/u;

function now() {
  return new Date().toISOString();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function repoRootFrom(startDir = process.cwd()) {
  const resolved = path.resolve(startDir);
  return resolved;
}

function buildPaths(repoRoot = repoRootFrom(process.cwd()), stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos') {
  const updateStateDir = process.env.MOS_UPDATE_AGENT_STATE_DIR || path.join(stateRoot, 'update-agent');
  return {
    changelogPath: path.join(repoRoot, 'CHANGELOG.md'),
    configPath: path.join(updateStateDir, 'config.json'),
    currentJobPath: path.join(updateStateDir, 'current-job.json'),
    jobsDir: path.join(updateStateDir, 'jobs'),
    packageJsonPath: path.join(repoRoot, 'package.json'),
    repoRoot,
    stateRoot,
    updateStateDir,
    rootPackageJsonPath: path.join(repoRoot, 'package.json'),
    versionFilePath: path.join(repoRoot, 'VERSION'),
  };
}

function runCommand(cwd, command, args, options = {}) {
  const result = execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  return typeof result === 'string' ? result.trim() : '';
}

function safeRunCommand(cwd, command, args) {
  try {
    return { ok: true, value: runCommand(cwd, command, args) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false, value: null };
  }
}

// Why an apply step failed, in one sentence, with the tail of what the step
// wrote kept apart from it for the job record.
class StepFailure extends Error {
  constructor(reason, output = '') {
    super(reason);
    this.name = 'StepFailure';
    this.output = output;
  }
}

// One step of the apply: streamed to the journal, as before, and captured so
// the last lines travel with a failure. The label names the command line, which
// is safe here in a way it is not for app containers — nothing the updater runs
// takes a secret as an argument.
async function runStep(cwd, what, command, args) {
  try {
    await runCaptured(command, args, { cwd, echo: true, timeoutMs: STEP_TIMEOUT_MS });
  } catch (error) {
    throw new StepFailure(describeFailure(error, what)[0], error instanceof CommandFailure ? error.output : '');
  }
}

function runNpm(paths, args, log) {
  const what = `npm ${args.join(' ')}`;
  log(what);
  if (process.platform === 'win32') return runStep(paths.repoRoot, what, 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]);
  return runStep(paths.repoRoot, what, 'npm', args);
}

function runNode(paths, scriptPath, args, log) {
  const what = `node ${scriptPath} ${args.join(' ')}`.trim();
  log(what);
  return runStep(paths.repoRoot, what, process.execPath, [scriptPath, ...args]);
}

// The shape of a job that leaves the agent: what the status endpoint reports
// as the current job and what the worker mirrors into it.
function summarizeJob(job) {
  if (!job) return null;
  return {
    completedAt: job.completedAt || null,
    error: typeof job.error === 'string' ? job.error : null,
    id: job.id,
    logs: Array.isArray(job.logs) ? job.logs.slice(-30) : [],
    output: typeof job.output === 'string' && job.output ? job.output : null,
    stage: job.stage || null,
    status: job.status || null,
    target: job.target || null,
    updatedAt: job.updatedAt || null,
  };
}

function currentGitState(repoRoot) {
  const branch = safeRunCommand(repoRoot, 'git', ['branch', '--show-current']);
  const commit = safeRunCommand(repoRoot, 'git', ['rev-parse', 'HEAD']);
  return {
    branch: branch.ok && branch.value ? branch.value : null,
    commit: commit.ok && commit.value ? commit.value : null,
  };
}

function shortCommit(value) {
  return value ? value.slice(0, 12) : null;
}

function normalizeTrack(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'stable') return 'stable';
  if (normalized === 'branch') return 'branch';
  return null;
}

function normalizeRef(track, value) {
  if (track === 'stable') return 'main';
  return String(value || '').trim() || DEFAULT_BRANCH_REF;
}

function trackLabel(track, ref) {
  if (track === 'stable') return 'Stable releases';
  if (ref === 'main') return 'Main branch';
  if (ref === 'staging') return 'Staging branch';
  return `Branch: ${ref}`;
}

function readConfig(paths) {
  try { return readJson(paths.configPath); } catch { return null; }
}

function readInstalledVersion(paths) {
  const value = readText(paths.versionFilePath).trim();
  return SAFE_RELEASE_VERSION.test(value) ? value : null;
}

function resolveTrack(paths) {
  const gitState = currentGitState(paths.repoRoot);
  const config = readConfig(paths);
  // Without an explicit choice, a detached checkout (how the installer leaves
  // fresh machines) follows Stable releases; a named branch checkout follows
  // that branch, so development installs keep tracking what they sit on.
  const track = normalizeTrack(process.env.MOS_UPDATE_TRACK) || normalizeTrack(config?.track) || (gitState.branch ? 'branch' : 'stable');
  const ref = String(process.env.MOS_UPDATE_REF || '').trim() || normalizeRef(track, config?.ref || gitState.branch);
  return {
    currentBranch: gitState.branch,
    currentCommit: gitState.commit,
    label: trackLabel(track, ref),
    ref,
    source: paths.configPath,
    type: track,
  };
}

function writeUpdateTrack(paths, input) {
  const track = normalizeTrack(input?.track);
  if (!track) throw new Error('Update track must be stable or branch.');
  const ref = normalizeRef(track, input?.ref);
  if (track === 'branch' && !SAFE_BRANCH_REF.test(ref)) throw new Error('Branch ref contains unsupported characters.');
  const next = { ref, track, updatedAt: now() };
  writeJson(paths.configPath, next);
  return { label: trackLabel(track, ref), ref, source: paths.configPath, type: track };
}

function readRemoteBranchHead(repoRoot, ref) {
  const result = safeRunCommand(repoRoot, 'git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`]);
  return result.ok && result.value ? result.value : null;
}

function refreshRemoteBranch(repoRoot, ref) {
  const fetch = safeRunCommand(repoRoot, 'git', ['fetch', '--quiet', 'origin', ref]);
  return {
    error: fetch.ok ? null : fetch.error,
    latestCommit: readRemoteBranchHead(repoRoot, ref),
  };
}

function parsePackageRepo(paths) {
  try {
    const packageJson = readJson(paths.packageJsonPath);
    const url = String(packageJson.repository?.url || '');
    const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/iu);
    return match ? match[1] : DEFAULT_REPO;
  } catch {
    return DEFAULT_REPO;
  }
}

function fetchLatestRelease(repo) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mos-update-agent' },
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases/latest`,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub release check failed with status ${response.statusCode}.`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const tagName = String(parsed.tag_name || parsed.name || '').replace(/^v/iu, '');
          resolve({
            channel: 'stable',
            notesUrl: typeof parsed.html_url === 'string' ? parsed.html_url : null,
            publishedAt: typeof parsed.published_at === 'string' ? parsed.published_at : null,
            source: 'github-release',
            version: tagName || null,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('GitHub release check timed out.')));
  });
}

function extractChangelogSection(changelog, headingName) {
  const heading = new RegExp(`^## \\[${headingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'iu');
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return [];
  const items = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) items.push(line.slice(2).trim());
  }
  return items.slice(0, 6);
}

function buildChangeSummary(paths, track, latestRelease) {
  const changelog = readText(paths.changelogPath);
  if (track === 'branch') {
    return { items: extractChangelogSection(changelog, 'Unreleased'), source: 'CHANGELOG.md [Unreleased]', title: 'Upcoming MOS changes' };
  }
  const version = latestRelease?.version || '';
  return { items: version ? extractChangelogSection(changelog, version) : [], source: version ? `CHANGELOG.md [${version}]` : null, title: version ? `Changes in ${version}` : 'Release changes' };
}

function ensurePrerequisites(paths) {
  if (!fs.existsSync(paths.rootPackageJsonPath)) throw new Error('This does not look like a MOS checkout.');
}

function dirtyPathsFromPorcelain(value) {
  return value.trim().split(/\r?\n/u).filter(Boolean).map((line) => line.slice(2).trim());
}

async function recoverKnownMutableFiles(paths, dirtyPaths) {
  const knownMutablePaths = new Set(['package-lock.json']);
  if (!dirtyPaths.length || dirtyPaths.some((dirtyPath) => !knownMutablePaths.has(dirtyPath))) return false;
  await runStep(paths.repoRoot, `git checkout -- ${dirtyPaths.join(' ')}`, 'git', ['checkout', '--', ...dirtyPaths]);
  return true;
}

async function ensureCleanWorkingTree(paths) {
  let result = runCommand(paths.repoRoot, 'git', ['status', '--porcelain']);
  if (result.trim()) {
    const dirtyPaths = dirtyPathsFromPorcelain(result);
    if (await recoverKnownMutableFiles(paths, dirtyPaths)) {
      result = runCommand(paths.repoRoot, 'git', ['status', '--porcelain']);
    }
  }
  if (result.trim()) {
    throw new Error(`Working tree is not clean. Commit or stash changes before applying an update. Dirty paths: ${dirtyPathsFromPorcelain(result).join(', ')}`);
  }
}

async function collectStatus(paths = buildPaths(), { releaseLookup = fetchLatestRelease } = {}) {
  ensurePrerequisites(paths);
  const track = resolveTrack(paths);
  const githubRepo = parsePackageRepo(paths);
  const installedVersion = readInstalledVersion(paths);
  let latestRelease = null;
  let latestRevision = null;
  const errors = [];

  if (track.type === 'branch') {
    const cached = readRemoteBranchHead(paths.repoRoot, track.ref);
    const refreshed = refreshRemoteBranch(paths.repoRoot, track.ref);
    latestRevision = refreshed.latestCommit || cached;
    if (refreshed.error) errors.push(refreshed.error);
    if (process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP !== '1') {
      try { latestRelease = await releaseLookup(githubRepo); } catch (error) { errors.push(`Stable release lookup: ${error.message}`); }
    }
  } else {
    if (process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP !== '1') {
      try { latestRelease = await releaseLookup(githubRepo); } catch (error) { errors.push(error.message); }
    }
  }

  const status = {
    checkedAt: now(),
    changeSummary: buildChangeSummary(paths, track.type, latestRelease),
    error: errors.length ? errors.join(' ') : null,
    githubRepo,
    installedVersion,
    latestRelease,
    latestRevision,
    service: 'mos-update-agent',
    track,
    updateAvailable: track.type === 'branch'
      ? Boolean(track.currentCommit && latestRevision && track.currentCommit !== latestRevision)
      : Boolean(latestRelease?.version && latestRelease.version !== installedVersion),
  };
  writeJson(path.join(paths.updateStateDir, 'state.json'), status);
  return status;
}

async function checkoutBranch(paths, ref, log) {
  log(`Fetching latest commit for ${ref}`);
  await runStep(paths.repoRoot, `git fetch origin ${ref}`, 'git', ['fetch', 'origin', ref]);
  // checkout -B lands exactly on the remote head even when the local branch
  // diverged (for example after the tracked branch was force-rewritten); the
  // checkout is platform-owned and the working tree was verified clean above.
  log(`Checking out ${ref} at origin/${ref}`);
  await runStep(paths.repoRoot, `git checkout -B ${ref} origin/${ref}`, 'git', ['checkout', '-B', ref, `refs/remotes/origin/${ref}`]);
}

async function checkoutReleaseTag(paths, version, log) {
  if (!SAFE_RELEASE_VERSION.test(String(version || ''))) {
    throw new Error('The latest stable release version is missing or not plain X.Y.Z, so the release tag cannot be checked out.');
  }
  const tag = `v${version}`;
  log(`Fetching release tag ${tag}`);
  await runStep(paths.repoRoot, `git fetch origin ${tag}`, 'git', ['fetch', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  log(`Checking out release tag ${tag}`);
  await runStep(paths.repoRoot, `git checkout ${tag}`, 'git', ['checkout', '--detach', `refs/tags/${tag}`]);
}

async function runApply(paths, { log = () => {}, releaseLookup } = {}) {
  ensurePrerequisites(paths);
  await ensureCleanWorkingTree(paths);
  const status = await collectStatus(paths, { releaseLookup });
  if (!status.updateAvailable) throw new Error('This machine is already up to date on its current track.');

  log(`Repository before update: ${shortCommit(status.track.currentCommit) || 'unknown'}`);
  if (status.track.type === 'stable') {
    await checkoutReleaseTag(paths, status.latestRelease?.version, log);
  } else {
    await checkoutBranch(paths, status.track.ref, log);
  }
  log(`Repository after checkout: ${shortCommit(currentGitState(paths.repoRoot).commit) || 'unknown'}`);
  log('Installing dependencies from lockfile, including build tooling');
  await runNpm(paths, ['ci', '--include=dev'], log);
  log('Building Suite Manager frontend');
  await runNpm(paths, ['run', 'build:client'], log);
  log('Reconciling MOS host services and agents');
  await runNode(paths, path.join('scripts', 'reconcile-system.cjs'), [], log);
  log('Managed core update completed; installed app runtimes remain bound to their package snapshots');
  return collectStatus(paths, { releaseLookup });
}

module.exports = {
  StepFailure,
  buildPaths,
  collectStatus,
  currentGitState,
  readJson,
  repoRootFrom,
  runApply,
  shortCommit,
  summarizeJob,
  writeJson,
  writeUpdateTrack,
};
