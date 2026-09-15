const fs = require('node:fs');
const path = require('node:path');

const { discoverAppPackages } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');

// Everything this checker knows, derived from files the repository already
// keeps. No rule may hold a fact of its own: a checker with its own copy of the
// truth is one more place for the truth to rot, which is the problem it exists
// to solve.
function collectFacts(repoRoot) {
  const version = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
  const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'catalog.json'), 'utf8'));
  const stable = JSON.parse(fs.readFileSync(path.join(repoRoot, 'releases', 'stable.json'), 'utf8'));
  const packages = discoverAppPackages(path.join(repoRoot, 'apps')).map((entry) => ({
    category: entry.manifest.category,
    id: entry.manifest.id,
    name: entry.manifest.name,
  }));

  return {
    catalogIds: Object.keys(catalog.packages || {}).sort(),
    categories: [...new Set(packages.map((entry) => entry.category))].sort(),
    packages,
    stableVersion: stable.version,
    version,
  };
}

module.exports = { collectFacts };
