#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.cwd();
const versionFilePath = path.join(rootDir, 'VERSION');
const stableManifestPath = path.join(rootDir, 'releases', 'stable.json');

// Two modes on purpose. Without --release this runs on every branch as part of
// `npm test` and only asks that the metadata agree with itself, so ordinary work
// is not blocked by a changelog section that has not been written yet. With
// --release it is the gate a published release must pass: every warning becomes
// a failure, and the checks that only matter when cutting a tag switch on.
// The release pipeline runs this exact command, so a tag cannot reach the
// publish step by skipping something the maintainer would have caught locally.
function readReleaseTarget(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--release');
  if (index < 0) return '';

  const value = (argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) {
    console.error('--release requires a version, e.g. --release v0.16.0');
    process.exit(1);
  }
  return value;
}

const releaseTarget = readReleaseTarget();
const releaseMode = Boolean(releaseTarget);

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function normalizeVersion(value) {
  const trimmed = String(value || '').trim();
  return trimmed.replace(/^v/i, '');
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

const errors = [];
const warnings = [];

for (const requiredPath of [versionFilePath, stableManifestPath]) {
  if (!fs.existsSync(requiredPath)) {
    errors.push(`Missing required release metadata file: ${path.relative(rootDir, requiredPath)}`);
  }
}

if (errors.length === 0) {
  const version = normalizeVersion(readText(versionFilePath));
  const stableManifest = readJson(stableManifestPath);

  const stableVersion = normalizeVersion(stableManifest.version);

  if (!isSemver(version)) {
    errors.push(`VERSION must contain plain X.Y.Z SemVer. Found: "${version}"`);
  }

  if (!isSemver(stableVersion)) {
    errors.push(`releases/stable.json version must contain plain X.Y.Z SemVer. Found: "${stableManifest.version}"`);
  }

  if (version !== stableVersion) {
    errors.push(`VERSION (${version}) does not match releases/stable.json (${stableVersion}).`);
  }

  if ((stableManifest.channel || '').trim() !== 'stable') {
    errors.push(`releases/stable.json channel must be "stable". Found: "${stableManifest.channel}"`);
  }

  const changelog = readText(path.join(rootDir, 'CHANGELOG.md'));
  if (!changelog.includes(`## [${version}]`)) {
    warnings.push(`CHANGELOG.md has no "## [${version}]" section for the current stable version.`);
  }

  if (releaseMode) {
    const target = normalizeVersion(releaseTarget);

    if (!isSemver(target)) {
      errors.push(`--release must name a plain vX.Y.Z or X.Y.Z version. Found: "${releaseTarget}"`);
    }

    // The tag is what installed suites compare themselves against, so a tag that
    // disagrees with VERSION would tell every box it is out of date forever, or
    // never.
    if (isSemver(target) && target !== version) {
      errors.push(`Release tag v${target} does not match VERSION (${version}). Run: npm run release:prepare -- ${target}`);
    }

    const expectedNotesUrl = `https://github.com/rpuls/my-own-suite/releases/tag/v${target}`;
    if ((stableManifest.notesUrl || '').trim() !== expectedNotesUrl) {
      errors.push(`releases/stable.json notesUrl must be ${expectedNotesUrl}. Found: "${stableManifest.notesUrl}"`);
    }

    if (!Date.parse(stableManifest.publishedAt || '')) {
      errors.push(`releases/stable.json publishedAt must be an ISO timestamp. Found: "${stableManifest.publishedAt}"`);
    }

    // Anything still sitting under Unreleased at tag time is work that shipped in
    // this release without being described in it.
    const unreleased = changelog.split(/^## \[/mu).find((section) => section.startsWith('Unreleased]')) || '';
    const strandedEntries = unreleased.split(/\r?\n/u).filter((line) => line.trimStart().startsWith('- '));
    if (strandedEntries.length > 0) {
      errors.push(
        `CHANGELOG.md still has ${strandedEntries.length} entr${strandedEntries.length === 1 ? 'y' : 'ies'} under [Unreleased]. `
        + `Move them under [${target}] — release:prepare does this for you.`,
      );
    }
  }
}

// A release carries the public key every installed MOS checks the catalog
// against, so a release whose catalog signature does not verify is one that every
// box will refuse to refresh from — and it would fail on their machines, not on
// the machine that cut it. Checked here because that is the last point where it
// is still cheap to fix.
try {
  const { readSigningPublicKey, verifyCatalogSignature } = require('../suite-manager/backend/src/apps/catalog-signature.cjs');
  const publicKey = readSigningPublicKey(readText(path.join(rootDir, 'trust', 'official-catalog.pub')));
  for (const name of ['catalog.json', 'advisories.json']) {
    const signed = path.join(rootDir, 'apps', name);
    const signature = path.join(rootDir, 'apps', `${name}.sig`);
    if (!fs.existsSync(signature)) {
      errors.push(`apps/${name}.sig is missing. Sign the catalog: npm run apps:catalog:sign (prompts for the publisher key)`);
    } else if (!verifyCatalogSignature({ bytes: fs.readFileSync(signed), publicKey, signature: readText(signature) })) {
      errors.push(`apps/${name} is not signed by trust/official-catalog.pub. Re-sign it: npm run apps:catalog:sign (prompts for the publisher key)`);
    }
  }
} catch (error) {
  errors.push(`Official catalog signing key is unusable: ${error instanceof Error ? error.message : String(error)}`);
}

// Stable release-track managed updates compare the root VERSION file against
// the newest GitHub release, so VERSION agreeing with the tag (checked above)
// is what keeps installed-versus-latest truthful. A separate Suite Manager
// release metadata file is only needed again if a packaged distribution
// without the repo root returns. See RELEASING.md.

// A warning is advice while work is in progress and a defect at tag time. The
// same finding therefore changes severity with the mode rather than being
// reported twice or silently tolerated by the pipeline.
if (releaseMode) {
  errors.push(...warnings.splice(0, warnings.length));
}

if (warnings.length > 0) {
  console.log('Warnings:');
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
  console.log('');
}

if (errors.length > 0) {
  console.error(releaseMode ? `Release gate failed for ${releaseTarget}:` : 'Release metadata check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(releaseMode ? `Release gate passed for ${releaseTarget}.` : 'Release metadata check passed.');
