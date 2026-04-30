const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const defaultRepo = 'rpuls/my-own-suite';

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function parseVersion(value) {
  const normalized = normalizeVersion(value);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  if (!leftParts || !rightParts) {
    return 0;
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }

  return 0;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveCommand(command, args) {
  if (process.platform !== 'win32') {
    return {
      args,
      command,
    };
  }

  if (command === 'git' || command === 'docker') {
    return {
      args: ['/c', command, ...args],
      command: 'cmd.exe',
    };
  }

  return {
    args,
    command,
  };
}

function runCommand(repoRoot, command, args, options = {}) {
  const resolved = resolveCommand(command, args);
  const result = execFileSync(resolved.command, resolved.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  return typeof result === 'string' ? result.trim() : '';
}

function runNpmScript(repoRoot, scriptName, extraArgs = []) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  runCommand(repoRoot, npmCommand, ['run', scriptName, ...extraArgs], { stdio: 'inherit' });
}

function runNodeScript(repoRoot, scriptPath, extraArgs = []) {
  const nodeCommand = process.execPath;
  runCommand(repoRoot, nodeCommand, [scriptPath, ...extraArgs], { stdio: 'inherit' });
}

function runCompose(repoRoot, args) {
  runNodeScript(repoRoot, 'scripts/mos-compose.cjs', args);
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function safeRunCommand(repoRoot, command, args, options = {}) {
  try {
    return {
      ok: true,
      value: runCommand(repoRoot, command, args, options),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      value: null,
    };
  }
}

function readLocalStableManifest(stableManifestPath) {
  if (!fs.existsSync(stableManifestPath)) {
    return null;
  }

  const manifest = readJson(stableManifestPath);
  if (!manifest.version) {
    return null;
  }

  return {
    channel: manifest.channel || 'stable',
    notesUrl: manifest.notesUrl || null,
    publishedAt: manifest.publishedAt || null,
    source: 'local-manifest',
    version: normalizeVersion(manifest.version),
  };
}

function readGitHubRepo(packageJsonPath) {
  const packageJson = readJson(packageJsonPath);
  const repoUrl = packageJson?.repository?.url || '';
  const match = String(repoUrl).match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return process.env.MOS_UPDATER_GITHUB_REPO || (match ? match[1] : defaultRepo);
}

function fetchLatestGitHubRelease(repo) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'mos-updater',
        },
        hostname: 'api.github.com',
        path: `/repos/${repo}/releases/latest`,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GitHub release check failed with status ${response.statusCode}.`));
            return;
          }

          try {
            const parsed = JSON.parse(body);
            const tagName =
              typeof parsed.tag_name === 'string'
                ? parsed.tag_name
                : typeof parsed.name === 'string'
                  ? parsed.name
                  : '';
            const version = normalizeVersion(tagName);

            if (!version) {
              reject(new Error('Latest GitHub release did not include a usable tag.'));
              return;
            }

            resolve({
              channel: 'stable',
              notesUrl: typeof parsed.html_url === 'string' ? parsed.html_url : null,
              publishedAt: typeof parsed.published_at === 'string' ? parsed.published_at : null,
              source: 'github-release',
              version,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on('error', reject);
    request.setTimeout(10_000, () => {
      request.destroy(new Error('GitHub release check timed out.'));
    });
  });
}

function readInstalledVersion(versionFilePath) {
  if (!fs.existsSync(versionFilePath)) {
    return null;
  }

  return normalizeVersion(fs.readFileSync(versionFilePath, 'utf8'));
}

function readUpdaterConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.mos-updater', 'config.json');
  if (!fs.existsSync(configPath)) {
    return {
      config: null,
      path: configPath,
    };
  }

  try {
    return {
      config: readJson(configPath),
      path: configPath,
    };
  } catch {
    return {
      config: null,
      path: configPath,
    };
  }
}

function normalizeTrack(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'branch') {
    return 'branch';
  }

  return normalized === 'stable' ? 'stable' : null;
}

function readCurrentGitState(repoRoot) {
  const branchResult = safeRunCommand(repoRoot, 'git', ['branch', '--show-current']);
  const commitResult = safeRunCommand(repoRoot, 'git', ['rev-parse', 'HEAD']);

  return {
    branch: branchResult.ok && branchResult.value ? branchResult.value : null,
    commit: commitResult.ok && commitResult.value ? commitResult.value : null,
  };
}

function buildTrackLabel(track, ref) {
  if (track === 'stable') {
    return 'Stable releases';
  }

  if (ref === 'staging') {
    return 'Staging branch';
  }

  if (ref === 'main') {
    return 'Main branch';
  }

  return `Feature branch: ${ref}`;
}

function resolveUpdateTrack(repoRoot) {
  const gitState = readCurrentGitState(repoRoot);
  const { config, path: configPath } = readUpdaterConfig(repoRoot);
  const envTrack = normalizeTrack(process.env.MOS_UPDATE_TRACK);
  const configTrack = normalizeTrack(config?.track);

  let track = envTrack || configTrack;
  if (!track) {
    track = gitState.branch && gitState.branch !== 'main' ? 'branch' : 'stable';
  }

  const ref =
    String(process.env.MOS_UPDATE_REF || '').trim() ||
    String(config?.ref || '').trim() ||
    (track === 'branch' ? gitState.branch || 'staging' : 'main');

  return {
    configPath,
    currentBranch: gitState.branch,
    currentCommit: gitState.commit,
    label: buildTrackLabel(track, ref),
    ref,
    track,
  };
}

function readLocalRemoteBranchHead(repoRoot, ref) {
  const remoteRef = `refs/remotes/origin/${ref}`;
  const result = safeRunCommand(repoRoot, 'git', ['rev-parse', '--verify', '--quiet', remoteRef]);
  return result.ok && result.value ? result.value : null;
}

function refreshRemoteBranch(repoRoot, ref) {
  const fetchResult = safeRunCommand(repoRoot, 'git', ['fetch', '--quiet', 'origin', ref], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    error: fetchResult.ok ? null : fetchResult.error,
    latestCommit: readLocalRemoteBranchHead(repoRoot, ref),
  };
}

function ensureCleanWorkingTree(repoRoot, fail) {
  const porcelain = runCommand(repoRoot, 'git', ['status', '--porcelain']);
  if (porcelain.trim()) {
    fail('Working tree is not clean. Commit or stash changes before applying an update.');
  }
}

function ensureUpdaterPrerequisites(paths, fail) {
  if (!fs.existsSync(paths.packageJsonPath)) {
    fail('Run mos-updater from the repository root.');
  }

  if (!fs.existsSync(paths.vpsComposePath)) {
    fail('deploy/vps/docker-compose.yml was not found.');
  }
}

function resolveApplyTarget(flags, latestRelease, fail) {
  const rawTarget = flags.target ? String(flags.target) : 'latest';
  if (rawTarget === 'latest') {
    if (!latestRelease?.version) {
      fail('Unable to resolve latest release version for apply.');
    }

    return latestRelease.version;
  }

  const normalized = normalizeVersion(rawTarget);
  if (!parseVersion(normalized)) {
    fail(`Target version must look like X.Y.Z or latest. Received "${rawTarget}".`);
  }

  return normalized;
}

function fetchGitMetadata(repoRoot, targetVersion, log, fail) {
  log('Fetching git tags from origin');
  runCommand(repoRoot, 'git', ['fetch', '--tags', 'origin'], { stdio: 'inherit' });

  const tagName = `v${targetVersion}`;
  try {
    runCommand(repoRoot, 'git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`]);
  } catch {
    fail(`Git tag ${tagName} was not found after fetch.`);
  }

  return tagName;
}

function checkoutTag(repoRoot, tagName, log) {
  log(`Checking out ${tagName}`);
  runCommand(repoRoot, 'git', ['checkout', tagName], { stdio: 'inherit' });
}

function checkoutBranch(repoRoot, ref, log) {
  const currentBranch = safeRunCommand(repoRoot, 'git', ['branch', '--show-current']);
  if (currentBranch.ok && currentBranch.value === ref) {
    return;
  }

  log(`Checking out ${ref}`);
  runCommand(repoRoot, 'git', ['checkout', ref], { stdio: 'inherit' });
}

function updateTrackedBranch(repoRoot, ref, log) {
  log(`Fetching latest commit for ${ref}`);
  runCommand(repoRoot, 'git', ['fetch', 'origin', ref], { stdio: 'inherit' });
  checkoutBranch(repoRoot, ref, log);

  log(`Fast-forwarding ${ref}`);
  runCommand(repoRoot, 'git', ['pull', '--ff-only', 'origin', ref], { stdio: 'inherit' });
}

function writeUpdaterState(updaterStatePath, patch) {
  const current = fs.existsSync(updaterStatePath) ? readJson(updaterStatePath) : {};
  writeJson(updaterStatePath, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

function buildPaths(repoRoot) {
  const updaterDir = path.join(repoRoot, '.mos-updater');
  return {
    packageJsonPath: path.join(repoRoot, 'package.json'),
    repoRoot,
    stableManifestPath: path.join(repoRoot, 'releases', 'stable.json'),
    updaterDir,
    updaterStatePath: path.join(updaterDir, 'state.json'),
    versionFilePath: path.join(repoRoot, 'VERSION'),
    vpsComposePath: path.join(repoRoot, 'deploy', 'vps', 'docker-compose.yml'),
  };
}

function readShortCommit(repoRoot) {
  const result = safeRunCommand(repoRoot, 'git', ['rev-parse', '--short', 'HEAD']);
  return result.ok && result.value ? result.value : 'unknown';
}

const STACK_PROFILES = ['vaultwarden', 'seafile', 'onlyoffice', 'stirling-pdf', 'radicale', 'immich'];

function buildProfileArgs() {
  return STACK_PROFILES.flatMap((profile) => ['--profile', profile]);
}

function buildStackImages(repoRoot) {
  const profileArgs = buildProfileArgs();

  runCompose(repoRoot, [...profileArgs, 'build', '--pull']);
}

function recreateStackContainers(repoRoot) {
  const profileArgs = buildProfileArgs();

  runCompose(repoRoot, [...profileArgs, 'up', '-d', '--force-recreate']);
}

async function collectStatus(context) {
  const { fail, paths } = context;
  ensureUpdaterPrerequisites(paths, fail);

  const installedVersion = readInstalledVersion(paths.versionFilePath);
  const localRelease = readLocalStableManifest(paths.stableManifestPath);
  const githubRepo = readGitHubRepo(paths.packageJsonPath);
  const resolvedTrack = resolveUpdateTrack(paths.repoRoot);

  if (resolvedTrack.track === 'branch') {
    const cachedRemoteCommit = readLocalRemoteBranchHead(paths.repoRoot, resolvedTrack.ref);
    const refreshed = refreshRemoteBranch(paths.repoRoot, resolvedTrack.ref);
    const latestCommit = refreshed.latestCommit || cachedRemoteCommit;

    const status = {
      checkedAt: new Date().toISOString(),
      error:
        refreshed.error && latestCommit
          ? `Unable to refresh origin/${resolvedTrack.ref}; using cached remote ref. ${refreshed.error}`
          : refreshed.error,
      githubRepo,
      installedVersion,
      latestRelease: localRelease,
      latestRevision: latestCommit,
      stateFile: paths.updaterStatePath,
      track: {
        currentBranch: resolvedTrack.currentBranch,
        currentCommit: resolvedTrack.currentCommit,
        label: resolvedTrack.label,
        ref: resolvedTrack.ref,
        source: resolvedTrack.configPath,
        type: 'branch',
      },
      updateAvailable: Boolean(
        resolvedTrack.currentCommit && latestCommit && resolvedTrack.currentCommit !== latestCommit,
      ),
    };

    writeUpdaterState(paths.updaterStatePath, {
      kind: 'idle',
      lastCheck: status.checkedAt,
      lastCheckError: status.error,
      lastKnownInstalledVersion: installedVersion,
      lastKnownLatestVersion: localRelease?.version || null,
      lastKnownLatestRevision: latestCommit,
      track: status.track,
      updateAvailable: status.updateAvailable,
    });

    return status;
  }

  let latestRelease = localRelease;
  let error = null;

  try {
    latestRelease = await fetchLatestGitHubRelease(githubRepo);
  } catch (caughtError) {
    error = caughtError instanceof Error ? caughtError.message : String(caughtError);
  }

  const status = {
    checkedAt: new Date().toISOString(),
    error,
    githubRepo,
    installedVersion,
    latestRelease,
    latestRevision: null,
    stateFile: paths.updaterStatePath,
    track: {
      currentBranch: resolvedTrack.currentBranch,
      currentCommit: resolvedTrack.currentCommit,
      label: resolvedTrack.label,
      ref: resolvedTrack.ref,
      source: resolvedTrack.configPath,
      type: 'stable',
    },
    updateAvailable: compareVersions(installedVersion, latestRelease?.version || null) < 0,
  };

  writeUpdaterState(paths.updaterStatePath, {
    kind: 'idle',
    lastCheck: status.checkedAt,
    lastCheckError: error,
    lastKnownInstalledVersion: installedVersion,
    lastKnownLatestVersion: latestRelease?.version || null,
    lastKnownLatestRevision: null,
    track: status.track,
    updateAvailable: status.updateAvailable,
  });

  return status;
}

async function runApply(context, flags) {
  const { fail, log, paths } = context;
  ensureUpdaterPrerequisites(paths, fail);
  ensureCleanWorkingTree(paths.repoRoot, fail);

  log(`Updater implementation: explicit-compose-build-v1`);
  log(`Repository before update: ${readShortCommit(paths.repoRoot)}`);

  const status = await collectStatus(context);

  if (!flags.yes) {
    fail('Refusing to apply without explicit confirmation. Re-run with --yes after reviewing the plan.');
  }

  const stableTargetVersion =
    status.track.type === 'stable' ? resolveApplyTarget(flags, status.latestRelease, fail) : null;

  writeUpdaterState(paths.updaterStatePath, {
    kind: 'applying',
    startedAt: new Date().toISOString(),
    targetRevision: status.track.type === 'branch' ? status.latestRevision || null : null,
    targetVersion: stableTargetVersion,
    track: status.track,
  });

  try {
    if (status.track.type === 'branch') {
      if (!status.latestRevision) {
        fail(`Unable to resolve the latest commit for ${status.track.ref}.`);
      }

      if (!status.updateAvailable) {
        fail(`Installed commit already matches the latest known commit for ${status.track.ref}.`);
      }

      updateTrackedBranch(paths.repoRoot, status.track.ref, log);
      log(`Repository after checkout: ${readShortCommit(paths.repoRoot)}`);
    } else {
      if (status.installedVersion && compareVersions(status.installedVersion, stableTargetVersion) >= 0) {
        fail(`Installed version ${status.installedVersion} is not behind target ${stableTargetVersion}.`);
      }

      const tagName = fetchGitMetadata(paths.repoRoot, stableTargetVersion, log, fail);
      checkoutTag(paths.repoRoot, tagName, log);
      log(`Repository after checkout: ${readShortCommit(paths.repoRoot)}`);
    }

    log('Running release metadata validation');
    runNpmScript(paths.repoRoot, 'release:check');

    log('Applying own-infra system migrations');
    runNpmScript(paths.repoRoot, 'system:migrate');

    log('Rendering and validating VPS env files');
    runNpmScript(paths.repoRoot, 'vps:init');
    runNpmScript(paths.repoRoot, 'vps:doctor');

    log('Validating Docker Compose config');
    log(formatCommand('node scripts/mos-compose.cjs', ['config', '-q']));
    runCompose(paths.repoRoot, ['config', '-q']);

    log('Building stack images');
    log(formatCommand('node scripts/mos-compose.cjs', [...buildProfileArgs(), 'build', '--pull']));
    buildStackImages(paths.repoRoot);

    log('Recreating stack containers');
    log(formatCommand('node scripts/mos-compose.cjs', [...buildProfileArgs(), 'up', '-d', '--force-recreate']));
    recreateStackContainers(paths.repoRoot);

    writeUpdaterState(paths.updaterStatePath, {
      completedAt: new Date().toISOString(),
      kind: 'succeeded',
      lastAppliedRevision: status.track.type === 'branch' ? status.latestRevision || null : null,
      lastAppliedVersion: status.track.type === 'stable' ? stableTargetVersion : null,
      track: status.track,
    });

    if (status.track.type === 'branch') {
      log(`Update applied successfully from branch ${status.track.ref}`);
    } else {
      log(`Update applied successfully to ${stableTargetVersion}`);
    }
  } catch (caughtError) {
    writeUpdaterState(paths.updaterStatePath, {
      completedAt: new Date().toISOString(),
      error: caughtError instanceof Error ? caughtError.message : String(caughtError),
      kind: 'failed',
      track: status.track,
    });
    throw caughtError;
  }
}

module.exports = {
  buildPaths,
  collectStatus,
  compareVersions,
  normalizeVersion,
  parseVersion,
  readJson,
  runApply,
};
