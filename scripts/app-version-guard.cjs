#!/usr/bin/env node
// Refuses a catalog that changes what a package contains without changing the
// version number that package is published under, or that drops a storage folder
// its published version declared.
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

function baselineRefs() {
  const explicit = String(process.env.MOS_CATALOG_BASELINE_REF || '').trim();
  return explicit ? [explicit] : DEFAULT_BASELINE_REFS;
}

function main(args = process.argv.slice(2)) {
  const refs = baselineRefs();
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
  const folderErrors = compareStorageFolders(readPublishedManifests(ref, baseline), readCurrentManifests(current));

  if (errors.length) {
    process.stderr.write(`App packages changed without a version bump (compared against ${ref}):\n${errors.join('\n')}\n\nAfter bumping, run npm run apps:catalog and re-stamp each privacy review's scope.packageVersion.\n`);
  }
  if (folderErrors.length) {
    process.stderr.write(`App packages drop storage folders their published version declared (compared against ${ref}):\n${folderErrors.join('\n')}\n`);
  }
  if (errors.length || folderErrors.length) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`App package versions and storage folders are consistent with ${ref}.\n`);
}

function readPublishedManifests(ref, catalog) {
  return Object.fromEntries(Object.entries(catalog.packages || {}).map(([packageId, entry]) => [
    packageId,
    JSON.parse(execFileSync('git', ['show', `${ref}:${entry.path}/manifest.json`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })),
  ]));
}

function readCurrentManifests(catalog) {
  return Object.fromEntries(Object.entries(catalog.packages || {}).map(([packageId, entry]) => [
    packageId,
    JSON.parse(fs.readFileSync(path.join(repoRoot, entry.path, 'manifest.json'), 'utf8')),
  ]));
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

// A storage folder holds the owner's library on their drive, and a version that stops
// declaring it stops mounting it, so the library looks lost after the update. Folders
// are therefore additive: a rename adds the new folder and keeps the old one.
function compareStorageFolders(publishedManifests, currentManifests) {
  const errors = [];
  for (const [packageId, published] of Object.entries(publishedManifests)) {
    const candidate = currentManifests[packageId];
    if (!candidate) continue;
    const kept = new Set(storageFolderNames(candidate));
    const dropped = storageFolderNames(published).filter((name) => !kept.has(name));
    if (dropped.length) {
      errors.push(`${packageId}: no longer declares the storage folder ${dropped.join(', ')}. Installed apps keep files there, so keep it; a rename adds the new folder beside it, and the release note tells owners to move their files.`);
    }
  }
  return errors;
}

function storageFolderNames(manifest) {
  return Array.isArray(manifest?.storage?.folders) ? manifest.storage.folders.map((folder) => folder.name) : [];
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

module.exports = { baselineRefs, compareCatalogs, compareStorageFolders, main, readBaselineCatalog };
