#!/usr/bin/env node
// Stale-review and changed-policy monitoring for shipped app privacy reviews.
//
// This complements scripts/app-privacy-check.cjs (which validates the review
// binding). Here we watch for reviews that have gone stale or that a published
// advisory has invalidated, so the repository review of the current package is
// refreshed rather than silently trusted. Installed instances keep displaying
// their own snapshot review; this only guards the latest repository package.
//
// Warnings (age/expiry) do not fail CI on their own; a published advisory that
// invalidates the currently shipped review version is a blocking error, because
// the repository would otherwise present a review the advisory says is wrong.
const fs = require('node:fs');
const path = require('node:path');

const { advisoriesForVersion } = require('../suite-manager/backend/src/apps/package-contracts.cjs');
const { discoverAppPackages } = require('../suite-manager/backend/src/apps/package-manifest.cjs');

const repoRoot = path.resolve(__dirname, '..');
const appsDir = path.join(repoRoot, 'apps');
const MAX_REVIEW_AGE_DAYS = 365;
// MOS_PRIVACY_NOW keeps the monitor deterministic in tests; real runs use now.
const nowMs = process.env.MOS_PRIVACY_NOW ? Date.parse(process.env.MOS_PRIVACY_NOW) : Date.now();

function loadAdvisoryIndex() {
  const advisoriesPath = path.join(appsDir, 'advisories.json');
  if (!fs.existsSync(advisoriesPath)) return { advisories: [], schemaVersion: 1 };
  try { return JSON.parse(fs.readFileSync(advisoriesPath, 'utf8')); }
  catch { return { advisories: [], schemaVersion: 1 }; }
}

function monitorPrivacyReviews() {
  const advisoryIndex = loadAdvisoryIndex();
  const warnings = [];
  const errors = [];
  for (const entry of discoverAppPackages(appsDir)) {
    const reviewPath = path.join(entry.packageDir, 'privacy-review.json');
    if (!fs.existsSync(reviewPath)) continue;
    let review;
    try { review = JSON.parse(fs.readFileSync(reviewPath, 'utf8')); }
    catch (error) { errors.push(`${entry.manifest.id}: privacy review is unreadable: ${error instanceof Error ? error.message : String(error)}`); continue; }
    const { id, version } = entry.manifest;

    if (review.expiresAt && Number.isFinite(Date.parse(review.expiresAt)) && Date.parse(review.expiresAt) < nowMs) {
      warnings.push(`${id}: privacy review expired on ${review.expiresAt}; refresh it with the assess-app-privacy skill.`);
    } else if (review.reviewedAt && Number.isFinite(Date.parse(review.reviewedAt))) {
      const ageDays = Math.round((nowMs - Date.parse(review.reviewedAt)) / 86_400_000);
      if (ageDays > MAX_REVIEW_AGE_DAYS) warnings.push(`${id}: privacy review is ${ageDays} days old; consider a refresh.`);
    }

    for (const advisory of advisoriesForVersion(advisoryIndex, id, version)) {
      if (['package-withdrawn', 'policy-change', 'privacy-review-invalidated'].includes(advisory.type)) {
        errors.push(`${id}: advisory ${advisory.id} (${advisory.type}) applies to the shipped review version ${version}; refresh the review or withdraw the package.`);
      }
    }
  }
  return { errors, warnings };
}

function main() {
  const { errors, warnings } = monitorPrivacyReviews();
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const error of errors) process.stderr.write(`error: ${error}\n`);
  if (errors.length) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Privacy monitor: ${warnings.length} warning(s), 0 blocking issue(s).\n`);
}

if (require.main === module) main();

module.exports = { monitorPrivacyReviews };
