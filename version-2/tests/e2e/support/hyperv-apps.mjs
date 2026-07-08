import { expect } from '@playwright/test';

import { apiJson } from './hyperv-api.mjs';
import { openSuiteManager } from './hyperv-navigation.mjs';

const runtimeKinds = new Set(['compose', 'caddy', 'health']);

function projectionApplied(app, kind) {
  const projection = app.instance?.projections?.find((item) => item.kind === kind);
  return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
}

function appRunning(app) {
  return Boolean(app.instance && [...runtimeKinds].every((kind) => projectionApplied(app, kind)));
}

function baseHostFromPage(page) {
  const host = new URL(page.url()).hostname;
  return host.startsWith('home.') ? host.slice(5) : host;
}

function routeUrl(page, app) {
  const route = app.routes?.[0];
  if (!route?.host) return '';
  return `${new URL(page.url()).protocol}//${route.host}.${baseHostFromPage(page)}/`;
}

function setupConfigFor(app, env) {
  const config = {};
  for (const field of app.setup?.fields || []) {
    if (field.generated) continue;
    if (app.id === 'radicale' && field.id === 'adminUsername') config[field.id] = env.radicale.username;
    else if (app.id === 'radicale' && field.id === 'adminPassword') config[field.id] = env.radicale.password;
    else if (app.id === 'seafile' && field.id === 'adminEmail') config[field.id] = env.seafile.adminEmail;
    else if (app.id === 'seafile' && field.id === 'adminPassword') config[field.id] = env.seafile.adminPassword;
    else if (field.type === 'email') config[field.id] = env.owner.email;
    else if (field.type === 'password') config[field.id] = `${app.id}-${field.id}-test-password`;
    else config[field.id] = typeof field.default === 'string' ? field.default : `e2e-${field.id}`;
  }
  return config;
}

export async function listPackages(page) {
  return (await apiJson(page, '/suite-manager/api/apps/packages')).packages;
}

async function packageById(page, id) {
  const packages = await listPackages(page);
  const app = packages.find((item) => item.id === id);
  if (!app) throw new Error(`App package ${id} is not available in the catalog.`);
  return app;
}

async function waitForRunning(page, id) {
  const deadline = Date.now() + 12 * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await packageById(page, id);
    if (appRunning(last)) return last;
    if (last.instance && last.instance.status !== 'uninstalled') {
      await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/refresh-runtime-status`, { method: 'POST' }).catch(() => undefined);
    }
    await page.waitForTimeout(5000);
  }
  throw new Error(`${id} did not reach Running state. Last status: ${JSON.stringify(last?.instance?.projections || [])}`);
}

export async function verifyAppsPage(page) {
  await openSuiteManager(page, 'Apps');
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
  await expect(page.getByLabel('Search apps')).toBeVisible();
}

export async function installCatalogApps(page, env) {
  await verifyAppsPage(page);
  const installed = [];
  for (const id of env.appIds) {
    let app = await packageById(page, id);
    expect(app.validation.valid, `${id} manifest should be valid`).toBe(true);
    if (app.installStatus !== 'installed') {
      await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/install`, {
        body: JSON.stringify({ config: setupConfigFor(app, env) }),
        method: 'POST',
      });
    }
    app = await packageById(page, id);
    if (!appRunning(app)) {
      await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/apply-runtime`, { method: 'POST' });
    }
    app = await waitForRunning(page, id);
    if (app.homepage && !projectionApplied(app, 'homepage')) {
      await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/add-to-homepage`, { method: 'POST' });
      app = await packageById(page, id);
    }
    installed.push(app);
  }
  return installed;
}

export async function connectSeafileOnlyOffice(page) {
  const seafile = await packageById(page, 'seafile');
  const connection = seafile.compatibility?.connections?.find((item) => item.provider.id === 'onlyoffice');
  if (!connection) throw new Error('Seafile does not expose an ONLYOFFICE connection.');
  if (connection.relationship?.status === 'active') return;
  expect(connection.ready, 'Seafile + ONLYOFFICE should be ready to connect').toBe(true);
  await apiJson(page, '/suite-manager/api/apps/integrations/connect', {
    body: JSON.stringify({
      consumerPackageId: connection.consumerPackageId,
      providerCapabilityId: connection.capabilityId,
      providerPackageId: connection.provider.id,
      slotId: connection.slotId,
    }),
    method: 'POST',
  });
  const updated = await packageById(page, 'seafile');
  const active = updated.compatibility?.connections?.find((item) => item.provider.id === 'onlyoffice');
  expect(active?.relationship?.status).toBe('active');
}

export async function verifyAppRoutes(page) {
  const packages = await listPackages(page);
  for (const app of packages.filter((item) => item.instance && item.routes?.length && item.role !== 'capability-provider')) {
    const url = routeUrl(page, app);
    if (app.id === 'vaultwarden' && new URL(url).protocol !== 'https:') continue;
    const response = await page.request.get(url, { timeout: 60000 });
    expect(response.status(), `${app.id} route ${url} should not be a server error`).toBeLessThan(500);
  }
}

export async function verifyHomepageAppTiles(page, homeUrl = '/') {
  const packages = await listPackages(page);
  await page.goto(homeUrl);
  for (const app of packages.filter((item) => item.homepage && projectionApplied(item, 'homepage'))) {
    await expect(page.getByText(app.homepage.name)).toBeVisible({ timeout: 60000 });
    const link = page.getByRole('link', { name: new RegExp(app.homepage.name.replace(/[-/\\^$*+?.()|[\]{}]/gu, '\\$&')) }).first();
    const href = await link.getAttribute('href');
    expect(href || '').toContain(`${app.routes[0]?.host}.${baseHostFromPage(page)}`);
  }
}

export async function lifecycleSmoke(page, env) {
  if (!env.enableLifecycle) return;
  const id = env.appIds.includes('stirling-pdf') ? 'stirling-pdf' : env.appIds[0];
  if (!id) return;
  await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  let app = await packageById(page, id);
  expect(app.instance?.enabled).toBe(false);
  await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/enable`, { method: 'POST' });
  app = await waitForRunning(page, id);
  expect(appRunning(app)).toBe(true);
}
