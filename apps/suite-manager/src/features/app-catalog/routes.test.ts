import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../../app.ts';
import type { SuiteManagerConfig } from '../../config.ts';
import { createSessionValue } from '../auth/session.ts';
import { loadCatalogManifests } from './manifest.ts';
import { InstalledCatalogStateStore } from './state-store.ts';

function createConfig(stateDir: string): SuiteManagerConfig {
  return {
    appUrls: {
      immich: '',
      radicale: '',
      seafile: '',
      stirlingPdf: '',
      suiteManager: 'http://suite-manager.localhost/setup',
      vaultwarden: '',
    },
    backupAgent: {
      socketPath: '',
      tokenFile: '',
    },
    checkIntervalMs: 1000,
    domain: 'localhost',
    generatedAccounts: {
      radicale: null,
      seafile: null,
    },
    homepageConfigDir: stateDir,
    homepageConfigSyncToken: '',
    homepageDefaultConfigDir: '',
    homepageUrl: '',
    ownerEmail: 'owner@example.com',
    ownerName: 'Owner',
    ownerPassword: 'password',
    port: 0,
    requestTimeoutMs: 1000,
    runOnce: false,
    serviceAgent: {
      socketPath: '',
      tokenFile: '',
    },
    sessionCookieName: 'mos-test-session',
    sessionMaxAgeSeconds: 60 * 60,
    sessionSecret: 'test-session-secret',
    setupBasePath: '/setup',
    stateDir,
    tlsMode: 'off',
    updates: {
      agentSocketPath: '',
      agentTokenFile: '',
      enabled: true,
      githubRepo: '',
      latestVersionOverride: '',
    },
    urlScheme: 'http',
    vaultwardenDatabaseUrl: '',
  };
}

function createOnboardingServiceStub() {
  return {
    buildModel: async () => ({
      currentAction: null,
      currentStepId: null,
      generatedAt: new Date().toISOString(),
      groups: [],
      homepageUrl: '/',
      observations: {
        importedCredentialCount: null,
        importStatus: 'blocked',
        importStatusSource: 'none',
        observedImportTargetCount: 0,
        vaultwardenAccountStatus: 'pending',
      },
      owner: {
        email: 'owner@example.com',
        name: 'Owner',
      },
      steps: [],
      title: 'My Own Suite Setup',
    }),
    getStateFilePath: () => '',
    triggerAction: () => ({
      completedSteps: [],
      updatedAt: null,
      vaultwardenImportBaselineCipherCount: null,
    }),
  };
}

test('catalog API requires an authenticated setup session', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-app-catalog-route-'));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const config = createConfig(stateDir);
  const app = createApp(config, createOnboardingServiceStub() as never);

  const response = await app.request('/setup/api/app-catalog');
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error, 'Authentication required.');
});

test('catalog API returns app manifests and installed state', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-app-catalog-route-'));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const config = createConfig(stateDir);
  const catalog = await loadCatalogManifests();
  const stirlingPdf = catalog.apps.find((app) => app.id === 'stirling-pdf');
  assert.ok(stirlingPdf);
  new InstalledCatalogStateStore(stateDir).markInstalled(
    stirlingPdf,
    new Date('2026-06-11T12:00:00.000Z'),
  );
  const app = createApp(config, createOnboardingServiceStub() as never);
  const session = createSessionValue(config);

  const response = await app.request('/setup/api/app-catalog', {
    headers: {
      Cookie: `${config.sessionCookieName}=${session}`,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.controlPlane.id, 'control-plane');
  assert.equal(body.apps.length, 6);

  const appIds = body.apps.map((catalogApp: { id: string }) => catalogApp.id);
  assert.deepEqual(appIds, ['immich', 'onlyoffice', 'radicale', 'seafile', 'stirling-pdf', 'vaultwarden']);

  const stirlingResponse = body.apps.find((catalogApp: { id: string }) => catalogApp.id === 'stirling-pdf');
  assert.equal(stirlingResponse.provisioning.mode, 'automatic');
  assert.equal(stirlingResponse.installed.status, 'pending-apply');
  assert.equal(stirlingResponse.installed.installedAt, '2026-06-11T12:00:00.000Z');
  assert.deepEqual(stirlingResponse.compose.services, ['stirling-pdf']);
  assert.deepEqual(stirlingResponse.routes, [
    {
      host: 'stirling-pdf',
      upstream: 'stirling-pdf:8080',
    },
  ]);

  const seafileResponse = body.apps.find((catalogApp: { id: string }) => catalogApp.id === 'seafile');
  assert.deepEqual(seafileResponse.dependencies, [
    {
      id: 'onlyoffice',
      kind: 'recommended',
    },
  ]);
  assert.equal(seafileResponse.installed.status, 'not-installed');
});

test('catalog install API requires an authenticated setup session', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-app-catalog-route-'));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const config = createConfig(stateDir);
  const app = createApp(config, createOnboardingServiceStub() as never);

  const response = await app.request('/setup/api/app-catalog/apps/stirling-pdf/install', {
    method: 'POST',
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error, 'Authentication required.');
});

test('catalog install API records an idempotent Stirling PDF install plan', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-app-catalog-route-'));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const config = createConfig(stateDir);
  const app = createApp(config, createOnboardingServiceStub() as never);
  const session = createSessionValue(config);
  const request = () =>
    app.request('/setup/api/app-catalog/apps/stirling-pdf/install', {
      headers: {
        Cookie: `${config.sessionCookieName}=${session}`,
      },
      method: 'POST',
    });

  const firstResponse = await request();
  const firstBody = await firstResponse.json();
  const secondResponse = await request();
  const secondBody = await secondResponse.json();

  assert.equal(firstResponse.status, 202);
  assert.equal(secondResponse.status, 202);
  assert.equal(firstBody.plan.composeProfile, 'stirling-pdf');
  assert.deepEqual(firstBody.composeSelection.profiles, ['stirling-pdf']);
  assert.deepEqual(firstBody.plan.composeServices, ['stirling-pdf']);

  const firstStirling = firstBody.apps.find((catalogApp: { id: string }) => catalogApp.id === 'stirling-pdf');
  const secondStirling = secondBody.apps.find((catalogApp: { id: string }) => catalogApp.id === 'stirling-pdf');
  assert.equal(firstStirling.installed.status, 'pending-apply');
  assert.equal(secondStirling.installed.status, 'pending-apply');
  assert.equal(secondBody.installed.apps.length, 1);
  assert.equal(secondStirling.installed.installedAt, firstStirling.installed.installedAt);

  const selection = JSON.parse(
    await fs.readFile(path.join(stateDir, 'app-catalog', 'compose-selection.json'), 'utf8'),
  ) as { profiles: string[] };
  const yaml = await fs.readFile(path.join(stateDir, 'app-catalog', 'docker-compose.catalog.yml'), 'utf8');
  assert.deepEqual(selection.profiles, ['stirling-pdf']);
  assert.match(yaml, /selectedProfiles:/);
});

test('catalog install API rejects unknown and not-yet-enabled apps clearly', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-app-catalog-route-'));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const config = createConfig(stateDir);
  const app = createApp(config, createOnboardingServiceStub() as never);
  const session = createSessionValue(config);
  const headers = {
    Cookie: `${config.sessionCookieName}=${session}`,
  };

  const unknownResponse = await app.request('/setup/api/app-catalog/apps/not-real/install', {
    headers,
    method: 'POST',
  });
  const unknownBody = await unknownResponse.json();
  assert.equal(unknownResponse.status, 404);
  assert.equal(unknownBody.error, 'Catalog app not found: not-real');

  const seafileResponse = await app.request('/setup/api/app-catalog/apps/seafile/install', {
    headers,
    method: 'POST',
  });
  const seafileBody = await seafileResponse.json();
  assert.equal(seafileResponse.status, 409);
  assert.match(seafileBody.error, /not enabled/);
});
