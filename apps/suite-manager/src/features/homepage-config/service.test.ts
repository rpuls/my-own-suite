import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SuiteManagerConfig } from '../../config.ts';
import { HomepageConfigService } from './service.ts';

async function createService(): Promise<{ configDir: string; service: HomepageConfigService }> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-homepage-config-'));
  const appRoot = path.resolve(import.meta.dirname, '../../..');
  const config: SuiteManagerConfig = {
    appUrls: {
      immich: '',
      radicale: '',
      seafile: '',
      stirlingPdf: '',
      suiteManager: '',
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
    homepageConfigDir: configDir,
    homepageConfigSyncToken: '',
    homepageDefaultConfigDir: path.join(appRoot, 'homepage-default-config'),
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
    stateDir: configDir,
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

  return { configDir, service: new HomepageConfigService(config) };
}

test('adds a managed external service without dropping existing Homepage tiles', async (t) => {
  const { configDir, service } = await createService();
  t.after(() => fs.rm(configDir, { force: true, recursive: true }));

  const result = await service.addExternalService({
    description: 'Smart home control',
    group: 'My External Services',
    href: 'https://homeassistant.home.example.com',
    icon: 'home-assistant',
    proxyEnabled: true,
    title: 'Home Assistant',
    upstream: 'http://192.168.30.4:8123',
  });

  assert.equal(result.defaultDomain, 'localhost');
  assert.equal(result.defaultUrlScheme, 'http');
  assert.equal(result.services.length, 1);
  assert.equal(result.services[0]?.title, 'Home Assistant');
  assert.equal(result.services[0]?.proxyEnabled, true);

  const { content } = await service.readFile('services.template.yaml');
  assert.match(content, /Seafile/);
  assert.match(content, /My External Services/);
  assert.match(content, /kind: external/);
  assert.match(content, /managed: true/);
  assert.match(
    content,
    /- Home Assistant:\s+href: https:\/\/homeassistant\.home\.example\.com\s+description: Smart home control\s+icon: home-assistant\s+mos:/,
  );

  const preview = await service.getCaddyProxyPreview();
  assert.equal(preview.valid, true);
  assert.equal(preview.routes[0]?.host, 'homeassistant.home.example.com');
});

test('updates and removes only the selected managed external service', async (t) => {
  const { configDir, service } = await createService();
  t.after(() => fs.rm(configDir, { force: true, recursive: true }));
  const added = await service.addExternalService({
    group: 'My External Services',
    href: 'https://nas.home.example.com',
    proxyEnabled: false,
    title: 'NAS',
  });
  const id = added.services[0]?.id || '';

  const updated = await service.updateExternalService(id, {
    description: 'Storage console',
    group: 'My Bookmarks',
    href: 'https://truenas.home.example.com',
    proxyEnabled: true,
    title: 'TrueNAS',
    upstream: 'https://192.168.30.3',
    upstreamTlsInsecureSkipVerify: true,
  });

  assert.equal(updated.services[0]?.title, 'TrueNAS');
  assert.equal(updated.services[0]?.group, 'My Bookmarks');
  assert.equal(updated.services[0]?.upstreamTlsInsecureSkipVerify, true);

  const removed = await service.removeExternalService(id);
  assert.equal(removed.services.length, 0);

  const { content } = await service.readFile('services.template.yaml');
  assert.match(content, /Example Bookmark/);
  assert.doesNotMatch(content, /TrueNAS/);
});
