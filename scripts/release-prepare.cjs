#!/usr/bin/env node

// The single command that prepares a release. It creates the release branch,
// edits every file that has to agree about the version, moves the changelog
// forward, and then runs the same gate the pipeline runs — so the answer to
// "did I remember everything?" is never a checklist someone reads, it is an
// exit code.
//
// It writes files and stops. Committing, tagging and pushing stay manual and
// reviewable, because those are the steps that are hard to undo.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = process.cwd();
const versionFilePath = path.join(rootDir, 'VERSION');
const stableManifestPath = path.join(rootDir, 'releases', 'stable.json');
const changelogPath = path.join(rootDir, 'CHANGELOG.md');
const releaseNotesUrlFor = (version) => `https://github.com/rpuls/my-own-suite/releases/tag/v${version}`;

function fail(message) {
  console.error(`Release prepare failed: ${message}`);
  process.exit(1);
}

function readTarget() {
  const raw = (process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '').trim();
  if (!raw) {
    fail('name the version to prepare, e.g. npm run release:prepare -- 0.16.0');
  }
  const version = raw.replace(/^v/iu, '');
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    fail(`"${raw}" is not a plain X.Y.Z version.`);
  }
  return version;
}

function git(args) {
  return spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
}

function currentBranch() {
  const result = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.status === 0 ? String(result.stdout).trim() : '';
}

// One command, one branch. Asking for the branch to be created first makes it a
// step that can be forgotten, and forgetting it prepares a release on whatever
// branch someone happened to be standing on.
function ensureReleaseBranch(version) {
  const target = `release/v${version}`;
  const current = currentBranch();
  if (current === target) {
    return target;
  }

  if (current === 'main') {
    fail('releases are prepared from the branch holding the batch you are releasing, usually staging — never from main. See RELEASING.md.');
  }

  // Uncommitted work would follow you onto the release branch and be swept into
  // the release commit unnoticed. That commit is the one that has to contain the
  // release and nothing else, because it is what the tag points at.
  if (git(['status', '--porcelain']).stdout.trim()) {
    fail(`the working tree has uncommitted changes. Commit or stash them first — ${target} has to start from a clean ${current || 'HEAD'}.`);
  }

  const checkout = git(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`]).status === 0
    ? git(['checkout', target])
    : git(['checkout', '-b', target]);
  if (checkout.status !== 0) {
    fail(`could not switch to ${target}: ${String(checkout.stderr).trim()}`);
  }

  console.log(`Switched to ${target}, branched from ${current || 'detached HEAD'}.`);
  return target;
}

// Every entry under Unreleased becomes the new version's section, and Unreleased
// is left empty and ready. Doing it here rather than by hand is what makes the
// gate's "nothing stranded under Unreleased" check something that passes by
// construction instead of something to remember.
function rollChangelog(changelog, version, today) {
  const heading = `## [${version}] - ${today}`;
  if (changelog.includes(`## [${version}]`)) {
    return { changed: false, next: changelog };
  }

  const unreleasedIndex = changelog.indexOf('## [Unreleased]');
  if (unreleasedIndex < 0) {
    fail('CHANGELOG.md has no "## [Unreleased]" section to roll forward.');
  }

  const afterUnreleased = changelog.slice(unreleasedIndex + '## [Unreleased]'.length);
  const nextSectionOffset = afterUnreleased.search(/^## \[/mu);
  const body = (nextSectionOffset < 0 ? afterUnreleased : afterUnreleased.slice(0, nextSectionOffset)).trim();

  if (!body) {
    fail('CHANGELOG.md has nothing under [Unreleased]. A release needs release notes.');
  }

  const tail = nextSectionOffset < 0 ? '' : afterUnreleased.slice(nextSectionOffset);
  return {
    changed: true,
    next: `${changelog.slice(0, unreleasedIndex)}## [Unreleased]\n\n${heading}\n\n${body}\n\n${tail}`,
  };
}

function main() {
  const version = readTarget();
  const branch = ensureReleaseBranch(version);

  const today = new Date().toISOString().slice(0, 10);
  const written = [];

  const previousVersion = fs.readFileSync(versionFilePath, 'utf8').trim();
  if (previousVersion !== version) {
    fs.writeFileSync(versionFilePath, `${version}\n`, 'utf8');
    written.push(`VERSION  ${previousVersion} -> ${version}`);
  }

  const stableManifest = JSON.parse(fs.readFileSync(stableManifestPath, 'utf8'));
  const nextManifest = {
    ...stableManifest,
    channel: 'stable',
    notesUrl: releaseNotesUrlFor(version),
    publishedAt: new Date().toISOString(),
    version,
  };
  fs.writeFileSync(stableManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
  written.push(`releases/stable.json  -> ${version}`);

  const changelog = rollChangelog(fs.readFileSync(changelogPath, 'utf8'), version, today);
  if (changelog.changed) {
    fs.writeFileSync(changelogPath, changelog.next, 'utf8');
    written.push(`CHANGELOG.md  [Unreleased] -> [${version}] - ${today}`);
  }

  console.log(`Prepared release v${version} on branch ${branch}:`);
  for (const line of written) console.log(`  ${line}`);
  console.log('');

  // The point of the whole script: prepared and unverified is not a state this
  // command is allowed to leave behind.
  const gate = spawnSync(process.execPath, [path.join(rootDir, 'scripts', 'release-check.cjs'), '--release', `v${version}`], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (gate.status !== 0) {
    fail('the release gate rejected the prepared files above. Fix them and run this again.');
  }

  console.log('');
  console.log('Next:');
  console.log('  1. Review the changes above, then commit them on this branch.');
  console.log('  2. Open the PR into main and merge it (merge commit, never squash).');
  console.log(`  3. git tag v${version} && git push origin v${version}`);
  console.log('');
  console.log('Pushing the tag is what builds the installer image, uploads it, and');
  console.log('publishes the GitHub Release. Nothing else is manual, and the pipeline');
  console.log('re-runs this same gate before it publishes anything.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

module.exports = { rollChangelog };
