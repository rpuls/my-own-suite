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
