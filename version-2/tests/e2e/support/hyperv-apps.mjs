import { expect } from '@playwright/test';

import { apiJson } from './hyperv-api.mjs';
import { waitForHomepageAvailable } from './hyperv-homepage.mjs';
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

function escapeRegex(value) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/gu, '\\$&');
}

export async function listPackages(page) {
  return (await apiJson(page, '/suite-manager/api/apps/packages')).packages;
}

function expectHomepageHref(app, page, href) {
  expect(href || '', `${app.id} Homepage tile should have an app URL`).toContain(`${app.routes[0]?.host}.${baseHostFromPage(page)}`);
  if (app.id === 'vaultwarden') {
    expect(new URL(href).protocol, 'Vaultwarden Homepage tile should use HTTPS').toBe('https:');
  }
}

function interactiveAppIds(packages) {
  return packages
    .filter((item) => ['radicale', 'seafile', 'stirling-pdf', 'vaultwarden'].includes(item.id) && item.instance && item.homepage && projectionApplied(item, 'homepage'))
    .map((item) => item.id)
    .sort();
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
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

async function waitForRouteAvailable(page, app, url) {
  const deadline = Date.now() + 3 * 60 * 1000;
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

    await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/refresh-runtime-status`, { method: 'POST' }).catch(() => undefined);
    await page.waitForTimeout(5000);
  }

  if (lastError) throw new Error(`${app.id} route ${url} did not become reachable. Last error: ${lastError.message}`);
  throw new Error(`${app.id} route ${url} should not be a server error. Last status: ${lastStatus}`);
}

async function openAppDetails(page, app) {
  await page.getByLabel('Search apps').fill(app.name);
  await page.getByRole('button', { name: new RegExp(escapeRegex(app.name), 'iu') }).first().click();
  const details = page.getByRole('dialog', { name: `${app.name} details` });
  await expect(details).toBeVisible({ timeout: 30000 });
  return details;
}

async function installAppViaUi(page, app, env) {
  const details = await openAppDetails(page, app);
  const config = setupConfigFor(app, env);
  const prepare = details.getByRole('button', { name: /^Prepare$/iu });
  if (await prepare.isVisible().catch(() => false)) await prepare.click();

  for (const [fieldId, value] of Object.entries(config)) {
    const field = app.setup?.fields?.find((item) => item.id === fieldId);
    if (!field || field.generated) continue;
    const input = details.getByLabel(new RegExp(`^${escapeRegex(field.label)}`, 'iu')).first();
    if (await input.isVisible().catch(() => false)) await input.fill(value);
  }

  const shortcut = details.getByLabel('Add shortcut to Homepage');
  if (await shortcut.isVisible().catch(() => false)) await shortcut.check();

  const install = details.getByRole('button', { name: /^Install$/iu });
  if (await install.isVisible().catch(() => false)) {
    await install.click();
    await expect(details.getByText(/Starting containers|Add shortcut|Ready to open|Install complete|Preparing app/i).first()).toBeVisible({ timeout: 30000 });
  }

  const running = await waitForRunning(page, app.id);
  await details.getByLabel('Close app details').click();
  await expect(details).toBeHidden({ timeout: 30000 });
  return running;
}

export async function verifyAppsPage(page, entryUrl = '/') {
  await openSuiteManager(page, 'Apps', entryUrl);
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
  await expect(page.getByLabel('Search apps')).toBeVisible();
}

export async function installCatalogApps(page, env, ids = env.appIds, entryUrl = '/') {
  await verifyAppsPage(page, entryUrl);
  const installed = [];
  for (const id of ids) {
    let app = await packageById(page, id);
    expect(app.validation.valid, `${id} manifest should be valid`).toBe(true);
    if (!appRunning(app) || (app.homepage && !projectionApplied(app, 'homepage'))) {
      app = await installAppViaUi(page, app, env);
    }
    if (app.homepage && !projectionApplied(app, 'homepage')) {
      await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/add-to-homepage`, { method: 'POST' });
      app = await packageById(page, id);
    }
    installed.push(app);
  }
  return installed;
}

export async function connectSeafileOnlyOffice(page) {
  const packages = await listPackages(page);
  const installedIds = new Set(packages.filter((item) => item.instance || item.installStatus === 'installed').map((item) => item.id));
  if (!installedIds.has('seafile') || !installedIds.has('onlyoffice')) return;

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
    const response = await waitForRouteAvailable(page, app, url);
    expect(response.status(), `${app.id} route ${url} should not be a server error`).toBeLessThan(500);
  }
}

export async function verifyHomepageAppTiles(page, homeUrl = '/') {
  const packages = await listPackages(page);
  await waitForHomepageAvailable(page, homeUrl);
  for (const app of packages.filter((item) => item.homepage && projectionApplied(item, 'homepage'))) {
    await expect(page.getByText(app.homepage.name)).toBeVisible({ timeout: 60000 });
    const link = page.getByRole('link', { name: new RegExp(app.homepage.name.replace(/[-/\\^$*+?.()|[\]{}]/gu, '\\$&')) }).first();
    const href = await link.getAttribute('href');
    expectHomepageHref(app, page, href);
  }
}

async function expectLoadedAppPage(page, app) {
  if (app.id === 'stirling-pdf') {
    await expect(page.locator('body')).toContainText(/Stirling|PDF/i, { timeout: 60000 });
    return;
  }

  if (app.id === 'radicale') {
    await expect(page.locator('body')).toContainText(/Radicale|Collection management|Sign in|Username|Authentication|Unauthorized/i, { timeout: 60000 });
    return;
  }

  if (app.id === 'vaultwarden') {
    await expect(page.locator('body')).toContainText(/Vaultwarden|Bitwarden|Log in|Create account/i, { timeout: 90000 });
    return;
  }

  if (app.id === 'seafile') {
    await expect(page.locator('body')).toContainText(/Seafile|Email|Password|Log in/i, { timeout: 90000 });
    return;
  }

  await expect(page.locator('body')).not.toBeEmpty({ timeout: 60000 });
}

async function loginToSeafile(page, env) {
  await expect(page.locator('body'), 'Seafile page should load its login surface before sign-in').toContainText(/Seafile|Email|Password|Log in/i, { timeout: 90000 });
  const email = page.locator('input[name="login"], input[type="email"]').first();
  const password = page.locator('input[name="password"], input[type="password"]').first();
  await expect(email, 'Seafile email field should be visible for sign-in').toBeVisible({ timeout: 30000 });
  await expect(password, 'Seafile password field should be visible for sign-in').toBeVisible({ timeout: 30000 });

  await email.fill(env.seafile.adminEmail);
  await password.fill(env.seafile.adminPassword);
  await page.getByRole('button', { name: /log in|sign in/i }).click();
  await expect(page.locator('body')).toContainText(/Libraries|My Libraries|Files|Seafile/i, { timeout: 90000 });
}

async function loginToStirling(page) {
  await expect(page.locator('body'), 'Stirling PDF should load before sign-in').toContainText(/Stirling|PDF|Login/i, { timeout: 90000 });
  if (await page.locator('body').getByText(/Default Login Credentials|Please change your password|Login/i).first().isVisible().catch(() => false)) {
    const username = page.locator('input[name="username"], input[type="text"], input[type="email"]').first();
    const password = page.locator('input[name="password"], input[type="password"]').first();
    await expect(username, 'Stirling username field should be visible for sign-in').toBeVisible({ timeout: 30000 });
    await expect(password, 'Stirling password field should be visible for sign-in').toBeVisible({ timeout: 30000 });
    await username.fill('admin');
    await password.fill('stirling');
    await page.getByRole('button', { name: /login|log in|sign in/i }).click();
  }
  await expect(page.locator('body'), 'Stirling PDF should reach the signed-in app surface').toContainText(/Merge|Split|Compress|Convert|Pipeline|Tools/i, { timeout: 90000 });
}

async function loginToRadicale(page, env) {
  await expect(page.locator('#loginscene:not(.hidden)'), 'Radicale login form should be visible').toBeVisible({ timeout: 60000 });
  await page.locator('input[data-name="user"]').fill(env.radicale.username);
  await page.locator('input[data-name="password"]').fill(env.radicale.password);
  await page.locator('form[data-name="form"] button[type="submit"]').click();
  await expect(
    page.locator(
      '#logoutview:not(.hidden) [data-name="user"], #logoutview:not(.hidden) [data-name="refresh"], #logoutview:not(.hidden) [data-name="logout"]',
    ).first(),
    'Radicale should show signed-in user, refresh, or logout controls',
  ).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#collectionsscene:not(.hidden)'), 'Radicale should reach the signed-in collections view').toBeVisible({ timeout: 60000 });
  await page.waitForTimeout(2000);
}

async function dismissVaultwardenExtensionPrompt(page, fallbackUrl) {
  const dismissControlNames = /skip(?: to web app| for now)?|add it later|maybe later|not now|continue to web app|go to web app/i;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (fallbackUrl && page.url().toLowerCase() === fallbackUrl.toLowerCase()) return;
    const control = page.locator('button, a, [role="button"], [role="link"]').filter({ hasText: dismissControlNames }).first();
    if (await visible(control)) {
      await control.click({ timeout: 1000 }).catch(() => undefined);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
    if (fallbackUrl && /setup-extension/i.test(page.url())) {
      await page.goto(fallbackUrl);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      return;
    }
    await page.waitForTimeout(250);
  }
  if (fallbackUrl && /setup-extension/i.test(page.url())) await page.goto(fallbackUrl);
}

function uniqueVaultwardenEmail(email) {
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return email;
  return `${email.slice(0, separator)}+e2e-${Date.now().toString(36)}${email.slice(separator)}`;
}

async function signInToVaultwardenIfNeeded(page, env, emailAddress = env.vaultwarden.email) {
  if (!/#\/login/i.test(page.url()) && !(await visible(page.getByRole('button', { name: /log in|continue|forts.t/i }).first()))) return;
  const email = page.getByRole('textbox').first();
  await expect(email, 'Vaultwarden login email field should be visible').toBeVisible({ timeout: 30000 });
  await email.fill(emailAddress);
  await page.getByRole('button', { name: /log ind|log in|continue|forts.t/i }).last().click();
  const password = page.locator('input[type="password"]').first();
  await expect(password, 'Vaultwarden login password field should be visible').toBeVisible({ timeout: 30000 });
  await password.fill(env.vaultwarden.password);
  await page.getByRole('button', { name: /log ind|log in|continue|forts.t/i }).last().click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  const loginBody = await page.locator('body').innerText().catch(() => '');
  if (/invalid master password/i.test(loginBody)) {
    throw new Error('Vaultwarden rejected the E2E master password. The account already exists with different state, so the lab reset did not clear the Vaultwarden data volume.');
  }
}

async function waitForVaultwardenSignupOutcome(page) {
  const body = page.locator('body');
  const deadline = Date.now() + 90000;
  let lastBody = '';
  let lastUrl = page.url();

  while (Date.now() < deadline) {
    lastUrl = page.url();
    lastBody = await body.innerText().catch(() => '');
    if (/already exists|already been taken|allerede/i.test(lastBody)) return 'already-exists';
    if (/new account has been created|konto er oprettet/i.test(lastBody)) return 'created';
    if (/#\/(?:finish-signup|setup-extension|vault)/i.test(lastUrl) && !/#\/signup/i.test(lastUrl)) return 'created';
    await page.waitForTimeout(500);
  }

  throw new Error(`Vaultwarden account creation did not complete. Last URL: ${lastUrl}. Last body: ${lastBody.slice(0, 300)}`);
}

async function openVaultwardenSignup(page) {
  if (/#\/signup/i.test(page.url())) return;
  const origin = new URL(page.url()).origin;
  await expect(page.locator('body'), 'Vaultwarden login page should expose the Create account link').toContainText(/Create account/i, { timeout: 30000 });
  const signupLink = page.locator('a[href="#/signup"], a[routerlink="/signup"]').first();
  await expect(signupLink, 'Vaultwarden Create account link should be visible before signup').toBeVisible({ timeout: 30000 });
  await signupLink.click();
  await expect(page, 'Vaultwarden should navigate to the signup route after clicking Create account').toHaveURL(/#\/signup/i, { timeout: 30000 });
  if (!/#\/signup/i.test(page.url())) await page.goto(`${origin}/#/signup`);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await expect(page, 'Vaultwarden signup route should stay open before filling account fields').toHaveURL(/#\/signup/i, { timeout: 30000 });
}

async function fillVaultwardenSignupEmail(page, emailAddress) {
  const email = page.getByRole('textbox').first();
  await expect(email, 'Vaultwarden account email field should be visible').toBeVisible({ timeout: 30000 });
  await email.fill(emailAddress);
  const continueButton = page.getByRole('button', { name: /continue|create account|submit|sign up|forts.t/i }).first();
  if (await visible(continueButton)) await continueButton.click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
}

async function loginToVaultwarden(page, env) {
  const body = page.locator('body');
  await expect(body).toContainText(/Vaultwarden|Bitwarden|Log in|Create account/i, { timeout: 90000 });
  const vaultUrl = `${new URL(page.url()).origin}/#/vault`;

  await openVaultwardenSignup(page);

  let emailAddress = env.vaultwarden.email;
  await fillVaultwardenSignupEmail(page, emailAddress);
  if (/#\/login/i.test(page.url())) {
    emailAddress = uniqueVaultwardenEmail(env.vaultwarden.email);
    await openVaultwardenSignup(page);
    await fillVaultwardenSignupEmail(page, emailAddress);
  }

  const name = page.locator('input[name="name"], input[autocomplete="name"]').first();
  if (await visible(name)) await name.fill(env.vaultwarden.name);
  const password = page.locator('input[type="password"]').nth(0);
  const confirmPassword = page.locator('input[type="password"]').nth(1);
  await expect(password, 'Vaultwarden account password field should be visible').toBeVisible({ timeout: 30000 });
  await expect(confirmPassword, 'Vaultwarden confirm password field should be visible').toBeVisible({ timeout: 30000 });
  await password.fill(env.vaultwarden.password);
  await confirmPassword.fill(env.vaultwarden.password);
  await page.getByRole('button', { name: /create account|opret konto|submit|continue|sign up/i }).click();
  await waitForVaultwardenSignupOutcome(page);
  if (!/#\/vault/i.test(page.url())) await page.goto(vaultUrl);
  await signInToVaultwardenIfNeeded(page, env, emailAddress);
  await dismissVaultwardenExtensionPrompt(page, vaultUrl);
  await expect(page).toHaveURL(/#\/vault/i, { timeout: 90000 });
}

export async function clickHomepageAppTiles(page, env, homeUrl = '/', options = {}) {
  const { ids = null } = options;
  const packages = await listPackages(page);
  const allowedIds = ids ? new Set(ids) : null;
  const clickableApps = packages.filter((item) => (!allowedIds || allowedIds.has(item.id)) && item.homepage && projectionApplied(item, 'homepage') && item.routes?.length);
  const requiredInteractiveIds = interactiveAppIds(packages).filter((id) => !allowedIds || allowedIds.has(id));
  const exercisedInteractiveIds = new Set();

  for (const app of clickableApps) {
    await waitForHomepageAvailable(page, homeUrl);
    const link = page.getByRole('link', { name: new RegExp(app.homepage.name.replace(/[-/\\^$*+?.()|[\]{}]/gu, '\\$&')) }).first();
    await expect(link, `${app.id} Homepage tile should be clickable`).toBeVisible({ timeout: 60000 });
    const href = await link.getAttribute('href');
    expectHomepageHref(app, page, href);
    if (href) await waitForRouteAvailable(page, app, href);
    const beforeClickUrl = page.url();
    const popupPromise = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await link.click();
    const appPage = (await popupPromise) || page;
    await appPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => undefined);
    if (appPage.url() === beforeClickUrl && href) await appPage.goto(href, { waitUntil: 'domcontentloaded' });

    await expectLoadedAppPage(appPage, app);
    if (app.id === 'stirling-pdf') {
      await loginToStirling(appPage);
      exercisedInteractiveIds.add(app.id);
    }
    if (app.id === 'radicale') {
      await loginToRadicale(appPage, env);
      exercisedInteractiveIds.add(app.id);
    }
    if (app.id === 'seafile') {
      await loginToSeafile(appPage, env);
      exercisedInteractiveIds.add(app.id);
    }
    if (app.id === 'vaultwarden') {
      await loginToVaultwarden(appPage, env);
      exercisedInteractiveIds.add(app.id);
    }

    if (appPage !== page) {
      await appPage.close();
      await page.bringToFront();
    }
  }

  await waitForHomepageAvailable(page, homeUrl);
  expect([...exercisedInteractiveIds].sort(), 'Homepage tile click-through should sign in to every installed interactive app').toEqual(requiredInteractiveIds);
}

export async function expectNoInstalledApps(page) {
  const packages = await listPackages(page);
  const installed = packages.filter((item) => item.instance || item.installStatus === 'installed');
  expect(installed.map((item) => item.id), 'Restore checkpoint should not include apps installed after the backup').toEqual([]);
}

export async function expectInstalledAppIds(page, expectedIds) {
  const packages = await listPackages(page);
  const installed = packages
    .filter((item) => item.instance || item.installStatus === 'installed')
    .map((item) => item.id)
    .sort();
  expect(installed, 'Restore checkpoint should match the app state captured by the backup').toEqual([...expectedIds].sort());
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
