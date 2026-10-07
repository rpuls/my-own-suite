import { expect } from '@playwright/test';

import { apiJson } from './api.mjs';
import { openSuiteManager } from './navigation.mjs';

const runtimeKinds = ['compose', 'caddy', 'health'];

// No escaped dash: unicode-mode patterns refuse `\-` outside a character class.
export function escapeRegex(value) {
  return value.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&');
}

export function projectionApplied(app, kind) {
  const projection = app.instance?.projections?.find((item) => item.kind === kind);
  return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
}

export function appRunning(app) {
  return Boolean(app.instance && runtimeKinds.every((kind) => projectionApplied(app, kind)));
}

export function isInstalled(app) {
  return Boolean(app.instance || app.installStatus === 'installed');
}

export function hasTile(app) {
  return Boolean(app.homepage && projectionApplied(app, 'homepage'));
}

export async function listPackages(page) {
  return (await apiJson(page, '/suite-manager/api/apps/packages')).packages;
}

export async function packageById(page, id) {
  const app = (await listPackages(page)).find((item) => item.id === id);
  if (!app) throw new Error(`App package ${id} is not available in the catalog.`);
  return app;
}

export async function installedPackages(page) {
  return (await listPackages(page)).filter(isInstalled);
}

export function routeUrl(homeUrl, app) {
  const route = app.routes?.[0];
  if (!route?.host) return '';
  const home = new URL(homeUrl);
  const baseHost = home.hostname.startsWith('home.') ? home.hostname.slice(5) : home.hostname;
  return `${home.protocol}//${route.host}.${baseHost}/`;
}

async function refreshRuntimeStatus(page, id) {
  await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/refresh-runtime-status`, { method: 'POST' }).catch(() => undefined);
}

export async function waitForRunning(page, id, { minutes = 12, version = null } = {}) {
  const deadline = Date.now() + minutes * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await packageById(page, id);
    if (appRunning(last) && (!version || last.instance?.packageVersion === version)) return last;
    if (last.instance) await refreshRuntimeStatus(page, id);
    await page.waitForTimeout(5000);
  }
  throw new Error(`${id} did not reach Running state${version ? ` on ${version}` : ''}. Last status: ${JSON.stringify(last?.instance?.projections || [])}`);
}

export async function waitForRouteAvailable(page, app, url, { minutes = 3 } = {}) {
  const deadline = Date.now() + minutes * 60 * 1000;
  let lastStatus = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await page.request.get(url, { timeout: 60000 });
      lastStatus = response.status();
      lastError = null;
      if (lastStatus < 500) return response;
    } catch (error) {
      lastError = error;
    }
    await refreshRuntimeStatus(page, app.id);
    await page.waitForTimeout(5000);
  }
  if (lastError) throw new Error(`${app.id} route ${url} did not become reachable. Last error: ${lastError.message}`);
  throw new Error(`${app.id} route ${url} should not be a server error. Last status: ${lastStatus}`);
}

export async function openAppsScreen(page, homeUrl) {
  await openSuiteManager(page, 'Apps', homeUrl);
  await expect(page.getByRole('heading', { exact: true, level: 1, name: 'Apps' })).toBeVisible();
  await expect(page.getByLabel('Search apps')).toBeVisible();
}

export async function openAppDetails(page, app) {
  await page.getByLabel('Search apps').fill(app.name);
  await page.getByRole('button', { name: new RegExp(escapeRegex(app.name), 'iu') }).first().click();
  const details = page.getByRole('dialog', { name: `${app.name} details` });
  await expect(details).toBeVisible({ timeout: 30000 });
  return details;
}

export async function closeAppDetails(details) {
  await details.getByLabel('Close app details').click();
  await expect(details).toBeHidden({ timeout: 30000 });
}

export function tileLink(page, app) {
  return page.getByRole('link', { name: new RegExp(escapeRegex(app.homepage.name)) }).first();
}

// A managed tile carries no address: it links to Suite Manager's own redirect,
// which resolves the app against whichever door the request arrived on.
export async function expectTileRedirect(page, homeUrl, app, href, { needsHttps = false } = {}) {
  expect(href || '', `${app.id} Homepage tile should link to the Suite Manager app redirect`).toMatch(/^\/suite-manager\/open\/[0-9a-f-]{36}$/u);
  const redirect = await page.request.get(new URL(href, page.url()).toString(), { maxRedirects: 0, timeout: 60000 });
  expect(redirect.status(), `${app.id} tile should redirect`).toBe(302);
  expect(redirect.headers().location, `${app.id} tile should resolve to its address on this door`).toBe(routeUrl(homeUrl, app));
  if (needsHttps) expect(new URL(redirect.headers().location).protocol, `${app.id} needs HTTPS and must resolve to it`).toBe('https:');
}
