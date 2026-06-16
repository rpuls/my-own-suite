const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { getCatalogDir, loadCatalogApps } = require('./app-catalog-packages.cjs');

const repoRoot = path.resolve(__dirname, '..');

function readText(filePath) {
  return fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function collectFiles(dirPath) {
  const absoluteDir = path.join(repoRoot, dirPath);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(child);
    }
    return entry.isFile() ? [child] : [];
  });
}

function convertedCatalogAppIds() {
  return loadCatalogApps(getCatalogDir(repoRoot))
    .filter((app) => app.package.source.endsWith('/manifest.json'))
    .map((app) => app.id)
    .sort();
}

test('converted catalog apps do not leak back into suite-level defaults', () => {
  const appIds = convertedCatalogAppIds();
  assert.deepEqual(appIds, ['radicale', 'stirling-pdf']);

  const caddyfile = readText('deploy/vps/Caddyfile');
  const homepageEnvTemplate = readText('deploy/vps/services/homepage/.env.template');
  const onboardingFiles = collectFiles('apps/suite-manager/src/features/onboarding')
    .concat(collectFiles('apps/suite-manager/frontend/src/features/onboarding'))
    .filter((file) => /\.(ts|tsx)$/.test(file));

  for (const appId of appIds) {
    assert.doesNotMatch(caddyfile, new RegExp(appId, 'i'), `${appId} should not be hardcoded in deploy/vps/Caddyfile`);
    assert.doesNotMatch(
      homepageEnvTemplate,
      new RegExp(appId.replace(/-/g, '[-_]').toUpperCase(), 'i'),
      `${appId} should not be seeded in the global Homepage env template`,
    );

    for (const file of onboardingFiles) {
      assert.doesNotMatch(
        readText(file),
        new RegExp(appId, 'i'),
        `${appId} package behavior should not live in suite-level onboarding (${file})`,
      );
    }
  }
});

test('converted app setup helper components live under app packages', () => {
  const legacyHelperDir = path.join(repoRoot, 'apps/suite-manager/frontend/src/features/app-catalog/setup-helpers');
  const legacyHelperFiles = collectFiles('apps/suite-manager/frontend/src/features/app-catalog/setup-helpers');
  assert.equal(fs.existsSync(legacyHelperDir), false);
  assert.deepEqual(legacyHelperFiles, []);

  assert.equal(
    fs.existsSync(path.join(repoRoot, 'apps/suite-manager/catalog/apps/radicale/setup-helper/frontend/DeviceGuide.tsx')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'apps/suite-manager/catalog/apps/radicale/setup-helper/frontend/DeviceSelector.tsx')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'apps/suite-manager/catalog/apps/radicale/setup-helper/frontend/SetupHelperPanel.tsx')),
    true,
  );
});

test('converted app extension points stay package-driven', () => {
  const convertedAppIds = convertedCatalogAppIds();
  const files = [
    'apps/suite-manager/src/features/app-catalog/routes.ts',
    'apps/suite-manager/src/features/app-catalog/setup-helper-registry.ts',
    'apps/suite-manager/frontend/src/features/app-catalog/setup-helper-registry.tsx',
    'scripts/vps-doctor.cjs',
  ];

  for (const file of files) {
    const content = readText(file);
    for (const appId of convertedAppIds) {
      assert.doesNotMatch(
        content,
        new RegExp(appId, 'i'),
        `${file} should use package metadata instead of branching on ${appId}`,
      );
    }
  }
});
