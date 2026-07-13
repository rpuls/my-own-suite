#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const { digestAppPackage, validateCatalog } = require('../suite-manager/backend/src/apps/package-contracts.cjs');
const { discoverAppPackages } = require('../suite-manager/backend/src/apps/package-manifest.cjs');

const repoRoot = path.resolve(__dirname, '..');
const appsDir = path.join(repoRoot, 'apps');
const catalogPath = path.join(appsDir, 'catalog.json');

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

function main(args = process.argv.slice(2)) {
  const generated = generateCatalog();
  const validationErrors = validateCatalog(generated);
  if (validationErrors.length) throw new Error(`Generated catalog is invalid:\n${validationErrors.join('\n')}`);
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
}

if (require.main === module) main();

module.exports = { generateCatalog, serializeCatalog };
