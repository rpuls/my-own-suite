import assert from 'node:assert/strict';
import test from 'node:test';

import type { SuiteManagerConfig } from '../../config.ts';
import type { ServiceCapabilityStatus } from '../service-agent/service.ts';
import { createSettingsRouter } from './routes.ts';

function createConfig(overrides: Partial<SuiteManagerConfig> = {}): SuiteManagerConfig {
  return {
    appUrls: {
      immich: '',
      radicale: '',
      seafile: '',
      stirlingPdf: '',
      suiteManager: 'http://suite-manager.mos.home/setup',
      vaultwarden: '',
    },
    backupAgent: {
      socketPath: '',
      tokenFile: '',
    },
    checkIntervalMs: 1000,
    domain: 'mos.home',
    generatedAccounts: {
      radicale: null,
      seafile: null,
    },
    homepageConfigDir: '',
    homepageConfigSyncToken: '',
    homepageDefaultConfigDir: '',
    homepageUrl: '',
    ownerEmail: '',
    ownerName: '',
    ownerPassword: '',
    port: 0,
    requestTimeoutMs: 1000,
    runOnce: false,
    serviceAgent: {
      socketPath: '',
      tokenFile: '',
    },
    sessionCookieName: '',
    sessionMaxAgeSeconds: 0,
    sessionSecret: '',
    setupBasePath: '/setup',
    stateDir: '',
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
    ...overrides,
  };
}

function createServiceAgent(overrides: {
  applyLocalHttps?: (input: { acmeEmail: string; cloudflareApiToken: string; domain: string }) => Promise<unknown>;
  capabilities?: Partial<ServiceCapabilityStatus>;
} = {}) {
  const capabilities: ServiceCapabilityStatus = {
    caddyExternalProxyApplyAvailable: false,
    error: null,
    homepageRestartAvailable: false,
    localHttpsApplyAvailable: true,
    serviceAvailable: true,
    ...overrides.capabilities,
  };

  return {
    applyLocalHttps:
      overrides.applyLocalHttps ||
      (async () => ({
        applied: true,
        restartScheduled: true,
      })),
    getCapabilities: async () => capabilities,
  };
}

test('reports local HTTPS apply capability in status payload', async () => {
  const router = createSettingsRouter(
    createConfig({ domain: 'mos.example.com', tlsMode: 'cloudflare-dns01', urlScheme: 'https' }),
    createServiceAgent(),
  );

  const response = await router.request('/settings/local-https');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.localHttpsApplyAvailable, true);
  assert.equal(body.localHttpsReady, true);
  assert.equal(body.realDomain, true);
});

test('rejects local HTTPS apply for local-only domains', async () => {
  const router = createSettingsRouter(createConfig(), createServiceAgent());

  const response = await router.request('/settings/local-https/apply', {
    body: JSON.stringify({
      acmeEmail: 'owner@example.com',
      cloudflareApiToken: 'token',
      domain: 'mos.home',
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /real Cloudflare-managed domain/);
});

test('passes valid local HTTPS apply payload to service agent', async () => {
  let received: { acmeEmail: string; cloudflareApiToken: string; domain: string } | null = null;
  const router = createSettingsRouter(
    createConfig(),
    createServiceAgent({
      applyLocalHttps: async (input) => {
        received = input;
        return { applied: true, restartScheduled: true };
      },
    }),
  );

  const response = await router.request('/settings/local-https/apply', {
    body: JSON.stringify({
      acmeEmail: 'owner@example.com',
      cloudflareApiToken: 'secret-token',
      domain: 'MOS.Example.COM',
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.applied, true);
  assert.deepEqual(received, {
    acmeEmail: 'owner@example.com',
    cloudflareApiToken: 'secret-token',
    domain: 'mos.example.com',
  });
});
