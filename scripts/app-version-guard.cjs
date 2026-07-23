#!/usr/bin/env node
// Refuses a catalog that changes what a package contains without changing the
// version number that package is published under.
//
// A MOS box installs an official app from its own checkout and afterwards only
// ever learns about newer packages by version: the catalog's job is to say "there
// is a 0.2.0 and you have 0.1.0". So a package whose contents change while its
// version stays put is invisible. Every installed box keeps running the old
// contents with no signal that anything is available, and no way to ask for it —
// the improvement is published and unreachable.
//
// This is the rule that was missing when every app gained a privacy review under
// an unchanged version number. `npm run apps:catalog:check` could not catch it: it
// only proves catalog.json matches the working tree, which was true. Catching it
// needs a comparison against what has already been published, which is what this
// does.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const catalogPath = path.join(repoRoot, 'apps', 'catalog.json');
// Published state lives on the branch installed boxes read their catalog from.
const DEFAULT_BASELINE_REFS = ['origin/main', 'main'];

function readBaselineCatalog(refs) {
  const attempts = [];
  for (const ref of refs) {
    try {
      const text = execFileSync('git', ['show', `${ref}:apps/catalog.json`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { catalog: JSON.parse(text), ref };
    } catch (error) {
      attempts.push(`${ref}: ${error instanceof Error ? error.message.trim().split('\n')[0] : String(error)}`);
    }
  }
  return { attempts, catalog: null, ref: null };
}

function main(args = process.argv.slice(2)) {
  const explicit = String(process.env.MOS_CATALOG_BASELINE_REF || '').trim();
  const refs = explicit ? [explicit] : DEFAULT_BASELINE_REFS;
  const { attempts, catalog: baseline, ref } = readBaselineCatalog(refs);
  if (!baseline) {
    // A checkout without the published branch cannot answer the question. That is
    // ordinary on a developer machine and a misconfiguration in CI, so it is a
    // skip locally and a failure where the check is the point.
    const message = `Cannot resolve a published catalog to compare against (tried ${refs.join(', ')}).\n${attempts.join('\n')}\n`;
    if (args.includes('--require-baseline')) {
      process.stderr.write(message);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${message}Skipping the app version guard. Fetch the baseline branch to run it.\n`);
    return;
  }

  const current = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const errors = compareCatalogs(baseline, current);

  if (errors.length) {
    process.stderr.write(`App packages changed without a version bump (compared against ${ref}):\n${errors.join('\n')}\n\nAfter bumping, run npm run apps:catalog and re-stamp each privacy review's scope.packageVersion.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`App package versions are consistent with ${ref}.\n`);
}

// A package absent from the baseline is new and has nothing to be compared
// against; a package absent from the current catalog was removed, which this
// check has no opinion about.
function compareCatalogs(baseline, current) {
  const errors = [];
  for (const [packageId, published] of Object.entries(baseline?.packages || {})) {
    const candidate = current?.packages?.[packageId];
    if (!candidate) continue;
    if (candidate.packageDigest !== published.packageDigest && candidate.packageVersion === published.packageVersion) {
      errors.push(`${packageId}: contents changed but packageVersion is still ${published.packageVersion}. Bump apps/${packageId}/manifest.json so installed boxes can be offered the change.`);
    }
    if (compare(candidate.packageVersion, published.packageVersion) < 0) {
      errors.push(`${packageId}: packageVersion moves backwards, from ${published.packageVersion} to ${candidate.packageVersion}. Installed boxes never downgrade, so the newer package would become unreachable.`);
    }
  }
  return errors;
}

// Local, deliberately minimal: catalog versions are plain X.Y.Z, which
// validateCatalog already enforces before this runs.
function compare(left, right) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

if (require.main === module) main();

module.exports = { compareCatalogs, main };
