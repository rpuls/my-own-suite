#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const {
  EXTERNAL_ROUTE_HOST_PREFIX,
  digestAppPackage,
  parseNamespacedPackageId,
  validateAdvisoryIndex,
  validateCatalog,
} = require('../suite-manager/backend/src/apps/package-contracts.cjs');
const { discoverAppPackages } = require('../suite-manager/backend/src/apps/package-manifest.cjs');

const repoRoot = path.resolve(__dirname, '..');
const appsDir = path.join(repoRoot, 'apps');
const catalogPath = path.join(appsDir, 'catalog.json');
const advisoriesPath = path.join(appsDir, 'advisories.json');

function generateCatalog() {
  const packages = {};
  for (const entry of discoverAppPackages(appsDir)) {
    const privacyReviewPath = path.join(entry.packageDir, 'privacy-review.json');
    let privacy = { status: 'review-required' };
    if (fs.existsSync(privacyReviewPath)) {
      const review = JSON.parse(fs.readFileSync(privacyReviewPath, 'utf8'));
      privacy = { posture: review.posture, status: 'reviewed' };
    }
    packages[entry.manifest.id] = {
      minimumMosVersion: entry.manifest.minimumMosVersion,
      packageDigest: digestAppPackage(entry.packageDir, { manifest: entry.manifest }),
      packageVersion: entry.manifest.version,
      path: `apps/${entry.manifest.id}`,
      privacy,
    };
  }
  return { packages, schemaVersion: 1 };
}

function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

// The advisory feed is authored, not generated. Validate its structure and that
// every advisory targets a real catalog package so the committed feed cannot
// drift into an invalid or orphaned state.
function validateAdvisoriesFile(catalog) {
  if (!fs.existsSync(advisoriesPath)) return [];
  let index;
  try { index = JSON.parse(fs.readFileSync(advisoriesPath, 'utf8')); }
  catch (error) { return [`apps/advisories.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]; }
  const errors = validateAdvisoryIndex(index);
  for (const advisory of Array.isArray(index?.advisories) ? index.advisories : []) {
    if (advisory?.packageId && !catalog.packages[advisory.packageId]) {
      errors.push(`advisory ${advisory.id || '(unknown)'} targets unknown package ${advisory.packageId}.`);
    }
  }
  return errors;
}

// MOS reserves two shapes for itself and must never ship an official package
// that occupies either.
//
// `ext-` is the route host namespace every external package is placed under. It
// exists because MOS cannot enumerate the names of its own future apps, and so
// cannot maintain a denylist protecting them: instead external hosts are confined
// to a prefix MOS promises not to use. An official app taking an `ext-` host would
// break that promise and could be shadowed by an external package. The promise is
// only worth anything if it is mechanical, which is what this is.
//
// `x-<8 hex>-` is the namespaced-id shape that marks a package as external, and
// which decides whether the `ext-` prefix is applied. An official id of that shape
// would be treated as external and silently renamed.
function validateReservedNames(entries) {
  const errors = [];
  for (const { manifest } of entries) {
    if (parseNamespacedPackageId(manifest.id).namespaced) {
      errors.push(`official package ${manifest.id} uses the reserved external id shape x-<8 hex>-<id>.`);
    }
    for (const route of Array.isArray(manifest.routes) ? manifest.routes : []) {
      if (String(route?.host || '').startsWith(EXTERNAL_ROUTE_HOST_PREFIX)) {
        errors.push(`official package ${manifest.id} claims route host ${route.host}, which is reserved for external packages by the ${EXTERNAL_ROUTE_HOST_PREFIX} prefix.`);
      }
    }
  }
  return errors;
}

function main(args = process.argv.slice(2)) {
  const reservedErrors = validateReservedNames(discoverAppPackages(appsDir));
  if (reservedErrors.length) throw new Error(`Official packages use reserved names:\n${reservedErrors.join('\n')}`);
  const generated = generateCatalog();
  const validationErrors = validateCatalog(generated);
  if (validationErrors.length) throw new Error(`Generated catalog is invalid:\n${validationErrors.join('\n')}`);
  const advisoryErrors = validateAdvisoriesFile(generated);
  if (advisoryErrors.length) throw new Error(`apps/advisories.json is invalid:\n${advisoryErrors.join('\n')}`);
  const expected = serializeCatalog(generated);
  if (args.includes('--check')) {
    const actual = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8').replace(/\r\n?/gu, '\n') : '';
    if (actual !== expected) {
      process.stderr.write('apps/catalog.json is stale. Run npm run apps:catalog.\n');
      process.exitCode = 1;
    }
    return;
  }
  fs.writeFileSync(catalogPath, expected);
  process.stdout.write(`Wrote ${path.relative(repoRoot, catalogPath)}.\n`);
  // Rewriting the catalog invalidates the signature every installed MOS checks
  // it against, and a catalog that no longer verifies is one they all refuse. The
  // failure would otherwise surface on their boxes rather than on this one.
  process.stdout.write('The catalog signature is now stale. Re-sign before committing:\n  npm run apps:catalog:sign   (prompts you to paste the key; input stays hidden)\n');
}

if (require.main === module) main();

module.exports = { generateCatalog, serializeCatalog };
