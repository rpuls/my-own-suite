#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const repoRoot = process.cwd();
const updaterDir = path.join(repoRoot, '.mos-updater');
const updaterStatePath = path.join(updaterDir, 'state.json');
const versionFilePath = path.join(repoRoot, 'VERSION');
const stableManifestPath = path.join(repoRoot, 'releases', 'stable.json');
const packageJsonPath = path.join(repoRoot, 'package.json');
const vpsComposePath = path.join(repoRoot, 'deploy', 'vps', 'docker-compose.yml');
const defaultRepo = 'rpuls/my-own-suite';

function log(message) {
  console.log(`[mos-updater] ${message}`);
}

function fail(message) {
  console.error(`[mos-updater] ERROR: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

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

function readInstalledVersion() {
  if (!fs.existsSync(versionFilePath)) {
    return null;
  }

  return normalizeVersion(fs.readFileSync(versionFilePath, 'utf8'));
}

function readLocalStableManifest() {
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

function readGitHubRepo() {
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

function readUpdaterState() {
  if (!fs.existsSync(updaterStatePath)) {
    return null;
  }

  return readJson(updaterStatePath);
}

function writeUpdaterState(patch) {
  const current = readUpdaterState() || {};
  writeJson(updaterStatePath, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

function parseArgs(argv) {
  const [command = 'check', ...rest] = argv;
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) {
      continue;
    }

    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { command, flags };
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

function runCommand(command, args, options = {}) {
  const resolved = resolveCommand(command, args);
  const result = execFileSync(resolved.command, resolved.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  return typeof result === 'string' ? result.trim() : '';
}

function runNpmScript(scriptName, extraArgs = []) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  runCommand(npmCommand, ['run', scriptName, ...extraArgs], { stdio: 'inherit' });
}

function ensureCleanWorkingTree() {
  const porcelain = runCommand('git', ['status', '--porcelain']);
  if (porcelain.trim()) {
    fail('Working tree is not clean. Commit or stash changes before applying an update.');
  }
}

function ensureUpdaterPrerequisites() {
  if (!fs.existsSync(packageJsonPath)) {
    fail('Run mos-updater from the repository root.');
  }

  if (!fs.existsSync(vpsComposePath)) {
    fail('deploy/vps/docker-compose.yml was not found.');
  }
}

function resolveApplyTarget(flags, latestRelease) {
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

function fetchGitMetadata(targetVersion) {
  log('Fetching git tags from origin');
  runCommand('git', ['fetch', '--tags', 'origin'], { stdio: 'inherit' });

  const tagName = `v${targetVersion}`;
  try {
    runCommand('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`]);
  } catch {
    fail(`Git tag ${tagName} was not found after fetch.`);
  }

  return tagName;
}

function checkoutTag(tagName) {
  log(`Checking out ${tagName}`);
  runCommand('git', ['checkout', tagName], { stdio: 'inherit' });
}

async function collectStatus() {
  ensureUpdaterPrerequisites();

  const installedVersion = readInstalledVersion();
  const localRelease = readLocalStableManifest();
  const githubRepo = readGitHubRepo();

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
    stateFile: updaterStatePath,
    updateAvailable: compareVersions(installedVersion, latestRelease?.version || null) < 0,
  };

  writeUpdaterState({
    kind: 'idle',
    lastCheck: status.checkedAt,
    lastCheckError: error,
    lastKnownInstalledVersion: installedVersion,
    lastKnownLatestVersion: latestRelease?.version || null,
    updateAvailable: status.updateAvailable,
  });

  return status;
}

function printStatus(status) {
  console.log(JSON.stringify(status, null, 2));
}

async function runApply(flags) {
  ensureUpdaterPrerequisites();
  ensureCleanWorkingTree();

  const status = await collectStatus();
  const targetVersion = resolveApplyTarget(flags, status.latestRelease);

  if (!flags.yes) {
    fail(
      `Refusing to apply ${targetVersion} without explicit confirmation. Re-run with --yes after reviewing the plan.`,
    );
  }

  if (status.installedVersion && compareVersions(status.installedVersion, targetVersion) >= 0) {
    fail(`Installed version ${status.installedVersion} is not behind target ${targetVersion}.`);
  }

  writeUpdaterState({
    kind: 'applying',
    targetVersion,
    startedAt: new Date().toISOString(),
  });

  try {
    const tagName = fetchGitMetadata(targetVersion);
    checkoutTag(tagName);

    log('Running release metadata validation');
    runNpmScript('release:check');

    log('Rendering and validating VPS env files');
    runNpmScript('vps:init');
    runNpmScript('vps:doctor');

    log('Validating Docker Compose config');
    runCommand('docker', ['compose', '-f', 'deploy/vps/docker-compose.yml', '--project-directory', 'deploy/vps', 'config', '-q'], {
      stdio: 'inherit',
    });

    log('Applying stack update');
    runNpmScript('vps:up');

    writeUpdaterState({
      completedAt: new Date().toISOString(),
      kind: 'succeeded',
      lastAppliedVersion: targetVersion,
      targetVersion,
    });

    log(`Update applied successfully to ${targetVersion}`);
  } catch (caughtError) {
    writeUpdaterState({
      completedAt: new Date().toISOString(),
      error: caughtError instanceof Error ? caughtError.message : String(caughtError),
      kind: 'failed',
      targetVersion,
    });
    throw caughtError;
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === 'check') {
    printStatus(await collectStatus());
    return;
  }

  if (command === 'status') {
    const state = readUpdaterState();
    if (!state) {
      fail('No updater state has been recorded yet. Run `npm run update:check` first.');
    }
    printStatus(state);
    return;
  }

  if (command === 'apply') {
    await runApply(flags);
    return;
  }

  fail(`Unsupported command "${command}". Use check, status, or apply.`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
