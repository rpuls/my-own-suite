const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const DEFAULT_REPO = 'rpuls/my-own-suite';
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

function runNpm(paths, args, log) {
  log(`npm ${args.join(' ')}`);
  if (process.platform === 'win32') {
    runCommand(paths.repoRoot, 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { stdio: 'inherit' });
    return;
  }
  runCommand(paths.repoRoot, 'npm', args, { stdio: 'inherit' });
}

function runNode(paths, scriptPath, args, log) {
  log(`node ${scriptPath} ${args.join(' ')}`.trim());
  runCommand(paths.repoRoot, process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
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

function recoverKnownMutableFiles(paths, dirtyPaths) {
  const knownMutablePaths = new Set(['package-lock.json']);
  if (!dirtyPaths.length || dirtyPaths.some((dirtyPath) => !knownMutablePaths.has(dirtyPath))) return false;
  runCommand(paths.repoRoot, 'git', ['checkout', '--', ...dirtyPaths], { stdio: 'inherit' });
  return true;
}

function ensureCleanWorkingTree(paths) {
  let result = runCommand(paths.repoRoot, 'git', ['status', '--porcelain']);
  if (result.trim()) {
    const dirtyPaths = dirtyPathsFromPorcelain(result);
    if (recoverKnownMutableFiles(paths, dirtyPaths)) {
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

function checkoutBranch(paths, ref, log) {
  log(`Fetching latest commit for ${ref}`);
  runCommand(paths.repoRoot, 'git', ['fetch', 'origin', ref], { stdio: 'inherit' });
  // checkout -B lands exactly on the remote head even when the local branch
  // diverged (for example after the tracked branch was force-rewritten); the
  // checkout is platform-owned and the working tree was verified clean above.
  log(`Checking out ${ref} at origin/${ref}`);
  runCommand(paths.repoRoot, 'git', ['checkout', '-B', ref, `refs/remotes/origin/${ref}`], { stdio: 'inherit' });
}

function checkoutReleaseTag(paths, version, log) {
  if (!SAFE_RELEASE_VERSION.test(String(version || ''))) {
    throw new Error('The latest stable release version is missing or not plain X.Y.Z, so the release tag cannot be checked out.');
  }
  const tag = `v${version}`;
  log(`Fetching release tag ${tag}`);
  runCommand(paths.repoRoot, 'git', ['fetch', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { stdio: 'inherit' });
  log(`Checking out release tag ${tag}`);
  runCommand(paths.repoRoot, 'git', ['checkout', '--detach', `refs/tags/${tag}`], { stdio: 'inherit' });
}

async function runApply(paths, { log = () => {}, releaseLookup } = {}) {
  ensurePrerequisites(paths);
  ensureCleanWorkingTree(paths);
  const status = await collectStatus(paths, { releaseLookup });
  if (!status.updateAvailable) throw new Error('This machine is already up to date on its current track.');

  log(`Repository before update: ${shortCommit(status.track.currentCommit) || 'unknown'}`);
  if (status.track.type === 'stable') {
    checkoutReleaseTag(paths, status.latestRelease?.version, log);
  } else {
    checkoutBranch(paths, status.track.ref, log);
  }
  log(`Repository after checkout: ${shortCommit(currentGitState(paths.repoRoot).commit) || 'unknown'}`);
  log('Installing dependencies from lockfile, including build tooling');
  runNpm(paths, ['ci', '--include=dev'], log);
  log('Building Suite Manager frontend');
  runNpm(paths, ['run', 'build:client'], log);
  log('Reconciling MOS host services and agents');
  runNode(paths, path.join('scripts', 'reconcile-system.cjs'), [], log);
  log('Managed core update completed; installed app runtimes remain bound to their package snapshots');
  return collectStatus(paths, { releaseLookup });
}

module.exports = {
  buildPaths,
  collectStatus,
  currentGitState,
  readJson,
  repoRootFrom,
  runApply,
  shortCommit,
  writeJson,
  writeUpdateTrack,
};
