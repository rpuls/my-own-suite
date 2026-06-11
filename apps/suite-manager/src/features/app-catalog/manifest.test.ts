import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getDefaultCatalogDir, loadCatalogManifests, validateCatalogAgainstRepo } from './manifest.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../../../..');

test('loads app catalog manifests in stable id order', async () => {
  const catalog = await loadCatalogManifests(getDefaultCatalogDir());

  assert.equal(catalog.controlPlane.id, 'control-plane');
  assert.deepEqual(
    catalog.apps.map((app) => app.id),
    ['immich', 'onlyoffice', 'radicale', 'seafile', 'stirling-pdf', 'vaultwarden'],
  );
  assert.equal(catalog.apps.find((app) => app.id === 'stirling-pdf')?.provisioning.mode, 'automatic');
});

test('catalog manifests match current compose services, volumes, and env templates', async () => {
  const catalog = await loadCatalogManifests(getDefaultCatalogDir());
  const errors = await validateCatalogAgainstRepo(repoRoot, catalog);

  assert.deepEqual(errors, []);
});
