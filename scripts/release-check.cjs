#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.cwd();
const versionFilePath = path.join(rootDir, 'VERSION');
const stableManifestPath = path.join(rootDir, 'releases', 'stable.json');
const suiteManagerReleasePath = path.join(rootDir, 'apps', 'suite-manager', 'release.json');

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

for (const requiredPath of [versionFilePath, stableManifestPath, suiteManagerReleasePath]) {
  if (!fs.existsSync(requiredPath)) {
    errors.push(`Missing required release metadata file: ${path.relative(rootDir, requiredPath)}`);
  }
}

if (errors.length === 0) {
  const version = normalizeVersion(readText(versionFilePath));
  const stableManifest = readJson(stableManifestPath);
  const suiteManagerRelease = readJson(suiteManagerReleasePath);

  const stableVersion = normalizeVersion(stableManifest.version);
  const suiteManagerVersion = normalizeVersion(suiteManagerRelease.version);

  if (!isSemver(version)) {
    errors.push(`VERSION must contain plain X.Y.Z SemVer. Found: "${version}"`);
  }

  if (!isSemver(stableVersion)) {
    errors.push(`releases/stable.json version must contain plain X.Y.Z SemVer. Found: "${stableManifest.version}"`);
  }

  if (!isSemver(suiteManagerVersion)) {
    errors.push(
      `apps/suite-manager/release.json version must contain plain X.Y.Z SemVer. Found: "${suiteManagerRelease.version}"`,
    );
  }

  if (version !== stableVersion) {
    errors.push(`VERSION (${version}) does not match releases/stable.json (${stableVersion}).`);
  }

  if (version !== suiteManagerVersion) {
    errors.push(`VERSION (${version}) does not match apps/suite-manager/release.json (${suiteManagerVersion}).`);
  }

  if ((stableManifest.channel || '').trim() !== 'stable') {
    errors.push(`releases/stable.json channel must be "stable". Found: "${stableManifest.channel}"`);
  }

  if ((suiteManagerRelease.channel || '').trim() !== 'stable') {
    errors.push(`apps/suite-manager/release.json channel must be "stable". Found: "${suiteManagerRelease.channel}"`);
  }

  if (
    stableManifest.notesUrl &&
    suiteManagerRelease.notesUrl &&
    String(stableManifest.notesUrl).trim() !== String(suiteManagerRelease.notesUrl).trim()
  ) {
    warnings.push('Release notes URL differs between releases/stable.json and apps/suite-manager/release.json.');
  }

  if (
    stableManifest.publishedAt &&
    suiteManagerRelease.publishedAt &&
    String(stableManifest.publishedAt).trim() !== String(suiteManagerRelease.publishedAt).trim()
  ) {
    warnings.push('Published timestamp differs between releases/stable.json and apps/suite-manager/release.json.');
  }
}

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
