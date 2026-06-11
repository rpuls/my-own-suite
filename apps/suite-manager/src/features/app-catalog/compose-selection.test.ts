import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadCatalogManifests } from './manifest.ts';
import { buildInstallPlan, InstalledCatalogStateStore } from './state-store.ts';
import { buildComposeSelection, writeComposeSelection } from './compose-selection.ts';

test('builds selected Compose profiles from pending catalog app state', async () => {
  const catalog = await loadCatalogManifests();
  const stirlingPdf = catalog.apps.find((app) => app.id === 'stirling-pdf');
  assert.ok(stirlingPdf);

  const selection = buildComposeSelection(
    {
      apps: [
        {
          appId: stirlingPdf.id,
          installedAt: '2026-06-11T12:00:00.000Z',
          installPlan: buildInstallPlan(stirlingPdf),
          lastApply: null,
          manifestVersion: 1,
          routeHosts: ['stirling-pdf'],
          serviceNames: ['stirling-pdf'],
          status: 'pending-apply',
          volumeNames: stirlingPdf.compose.volumes,
        },
      ],
      updatedAt: '2026-06-11T12:00:00.000Z',
      version: 1,
    },
    new Date('2026-06-11T12:01:00.000Z'),
  );

  assert.deepEqual(selection.profiles, ['stirling-pdf']);
  assert.deepEqual(selection.apps, [
    {
      id: 'stirling-pdf',
      services: ['stirling-pdf'],
      status: 'pending-apply',
    },
  ]);
});

test('writes generated Compose selection JSON and YAML under Suite Manager state', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-compose-selection-'));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const catalog = await loadCatalogManifests();
  const stirlingPdf = catalog.apps.find((app) => app.id === 'stirling-pdf');
  assert.ok(stirlingPdf);

  const store = new InstalledCatalogStateStore(stateDir);
  const state = store.markPendingApply(
    stirlingPdf,
    buildInstallPlan(stirlingPdf),
    new Date('2026-06-11T12:00:00.000Z'),
  );
  const written = writeComposeSelection(stateDir, state, new Date('2026-06-11T12:01:00.000Z'));

  const json = JSON.parse(await fs.readFile(written.jsonPath, 'utf8')) as { profiles: string[] };
  const yaml = await fs.readFile(written.yamlPath, 'utf8');

  assert.deepEqual(json.profiles, ['stirling-pdf']);
  assert.match(yaml, /selectedProfiles:/);
  assert.match(yaml, /stirling-pdf/);
});
