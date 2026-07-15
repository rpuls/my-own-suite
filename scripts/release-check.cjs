#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.cwd();
const versionFilePath = path.join(rootDir, 'VERSION');
const stableManifestPath = path.join(rootDir, 'releases', 'stable.json');

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
      errors.push(`apps/${name}.sig is missing. Sign the catalog: MOS_CATALOG_SIGNING_KEY=<key path> npm run apps:catalog:sign`);
    } else if (!verifyCatalogSignature({ bytes: fs.readFileSync(signed), publicKey, signature: readText(signature) })) {
      errors.push(`apps/${name} is not signed by trust/official-catalog.pub. Re-sign it: MOS_CATALOG_SIGNING_KEY=<key path> npm run apps:catalog:sign`);
    }
  }
} catch (error) {
  errors.push(`Official catalog signing key is unusable: ${error instanceof Error ? error.message : String(error)}`);
}

// When MOS2 gains stable release-track managed updates, a Suite Manager
// release metadata file should be added back here so packaged installs can
// report their installed version without the repo root. See RELEASING.md.

if (warnings.length > 0) {
  console.log('Warnings:');
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
  console.log('');
}

if (errors.length > 0) {
  console.error('Release metadata check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Release metadata check passed.');
