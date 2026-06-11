import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadCatalogManifests } from './manifest.ts';
import { InstalledCatalogStateStore } from './state-store.ts';

test('stores installed catalog app state from manifest metadata', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-installed-apps-'));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const catalog = await loadCatalogManifests();
  const stirlingPdf = catalog.apps.find((app) => app.id === 'stirling-pdf');
  assert.ok(stirlingPdf);

  const store = new InstalledCatalogStateStore(stateDir);
  const state = store.markInstalled(stirlingPdf, new Date('2026-06-11T12:00:00.000Z'));

  assert.equal(state.version, 1);
  assert.equal(state.apps.length, 1);
  assert.equal(state.apps[0]?.appId, 'stirling-pdf');
  assert.deepEqual(state.apps[0]?.serviceNames, ['stirling-pdf']);
  assert.deepEqual(state.apps[0]?.routeHosts, ['stirling-pdf']);
  assert.equal(state.apps[0]?.status, 'pending-apply');
  assert.equal(state.apps[0]?.lastApply?.status, 'pending');
  assert.equal(state.apps[0]?.installPlan?.composeProfile, 'stirling-pdf');

  const loaded = store.load();
  assert.equal(loaded.apps[0]?.appId, state.apps[0]?.appId);
  assert.equal(loaded.apps[0]?.status, 'pending-apply');
  assert.equal(loaded.apps[0]?.installPlan?.composeProfile, 'stirling-pdf');
  assert.deepEqual(loaded.apps[0]?.installPlan?.routes, [
    {
      host: 'stirling-pdf',
      upstream: 'stirling-pdf:8080',
    },
  ]);
});

test('records install apply failures without losing app metadata', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-installed-apps-'));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const catalog = await loadCatalogManifests();
  const stirlingPdf = catalog.apps.find((app) => app.id === 'stirling-pdf');
  assert.ok(stirlingPdf);

  const store = new InstalledCatalogStateStore(stateDir);
  store.markInstalled(stirlingPdf, new Date('2026-06-11T12:00:00.000Z'));
  const state = store.updateApplyResult(
    'stirling-pdf',
    {
      message: 'compose validation failed',
      status: 'failed',
    },
    new Date('2026-06-11T12:01:00.000Z'),
  );

  assert.equal(state.apps[0]?.status, 'failed');
  assert.equal(state.apps[0]?.lastApply?.message, 'compose validation failed');
  assert.deepEqual(state.apps[0]?.volumeNames, stirlingPdf.compose.volumes);
});
