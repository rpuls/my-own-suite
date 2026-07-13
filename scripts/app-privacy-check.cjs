#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const { digestAppPackage } = require('../suite-manager/backend/src/apps/package-contracts.cjs');
const { discoverAppPackages } = require('../suite-manager/backend/src/apps/package-manifest.cjs');

const repoRoot = path.resolve(__dirname, '..');
const errors = [];
for (const entry of discoverAppPackages(path.join(repoRoot, 'apps'))) {
  const reviewPath = path.join(entry.packageDir, 'privacy-review.json');
  if (!fs.existsSync(reviewPath)) continue;
  try {
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    const expectedDigest = digestAppPackage(entry.packageDir, { manifest: entry.manifest });
    if (review.schemaVersion !== 1) errors.push(`${entry.manifest.id}: privacy schemaVersion must be 1.`);
    if (review.appId !== entry.manifest.id) errors.push(`${entry.manifest.id}: privacy appId does not match manifest.`);
    if (review.scope?.packageVersion !== entry.manifest.version) errors.push(`${entry.manifest.id}: privacy packageVersion does not match manifest.`);
    if (review.scope?.packageDigest !== expectedDigest) errors.push(`${entry.manifest.id}: privacy packageDigest does not match package contents.`);
    if (!['official-git', 'external-git', 'local'].includes(review.scope?.source?.kind)) errors.push(`${entry.manifest.id}: privacy source kind is invalid.`);
    if (!Array.isArray(review.scope?.components) || review.scope.components.length === 0) errors.push(`${entry.manifest.id}: privacy review must identify upstream components.`);
    if (!review.provenance?.model) errors.push(`${entry.manifest.id}: privacy review must record the auditing model.`);
  } catch (error) {
    errors.push(`${entry.manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
}
