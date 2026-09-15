#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const {
  digestAppPackage,
  validatePrivacyAssessment,
  validatePrivacyAssessmentDocument,
  validatePrivacyBinding,
} = require('../suite-manager/backend/src/apps/package-contracts.cjs');
const { discoverAppPackages } = require('../suite-manager/backend/src/apps/package-manifest.cjs');

const repoRoot = path.resolve(__dirname, '..');
const officialRepository = 'https://github.com/rpuls/my-own-suite';

// The image the package's primary service builds from, named the way a review's
// component inventory names it: full registry path, no tag, no digest.
function primaryImage(packageDir) {
  const dockerfile = fs.readFileSync(path.join(packageDir, 'Dockerfile'), 'utf8');
  const from = dockerfile.split(/\r?\n/u).find((line) => /^FROM\s+/iu.test(line));
  if (!from) return null;
  const parts = from.split(/\s+/u)[1].replace(/@.*$/u, '').replace(/:[^/:]+$/u, '').split('/');
  if (parts.length === 1 || !/[.:]|^localhost$/u.test(parts[0])) parts.unshift('docker.io');
  if (parts.length === 2) parts.splice(1, 0, 'library');
  return parts.join('/');
}

// A manifest's appVersion and the review's entry for the primary image are both
// authored by hand, so an official package is held to keep them in agreement.
function appVersionErrors(entry, review) {
  const { appVersion } = entry.manifest;
  if (!appVersion) return ['manifest must declare appVersion.'];
  const image = primaryImage(entry.packageDir);
  const component = (review.scope?.components || []).find((item) => item?.artifact === image);
  if (!component) return [`privacy review lists no component for the primary image ${image}.`];
  if (component.version !== appVersion) return [`manifest appVersion ${appVersion} does not match the review's ${component.version} for ${image}.`];
  return [];
}

// Every authored review is checked three ways: its document shape, its binding
// to the package it ships with, and the semantics of the assessment itself.
// All three are enforced by package-contracts, which is also what the running
// platform validates against, so a review cannot pass here and fail there.
const errors = [];
for (const entry of discoverAppPackages(path.join(repoRoot, 'apps'))) {
  const reviewPath = path.join(entry.packageDir, 'privacy-review.json');
  if (!fs.existsSync(reviewPath)) continue;
  try {
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    const expectedDigest = digestAppPackage(entry.packageDir, { manifest: entry.manifest });
    const source = {
      kind: 'official-git',
      path: `apps/${entry.manifest.id}`,
      repository: officialRepository,
      revision: review.scope?.source?.revision,
      trust: 'mos-reviewed',
    };
    for (const error of [
      ...validatePrivacyAssessmentDocument(review),
      ...validatePrivacyBinding(review, { manifest: entry.manifest, packageDigest: expectedDigest, source }),
      ...validatePrivacyAssessment(review),
      ...appVersionErrors(entry, review),
    ]) {
      errors.push(`${entry.manifest.id}: ${error}`);
    }
  } catch (error) {
    errors.push(`${entry.manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
}
