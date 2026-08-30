import { expect } from '@playwright/test';

import { apiJson } from './hyperv-api.mjs';
import { waitForHomepageAvailable } from './hyperv-homepage.mjs';
import { openSuiteManager } from './hyperv-navigation.mjs';
import { captureElementShot, capturePageShot } from './screenshots.mjs';

const runtimeKinds = new Set(['compose', 'caddy', 'health']);

// The app whose pre-install detail view becomes the marketing
// app-detail-install.png shot. Seafile is in the default post-DNS set and
// its detail view shows setup fields, the posture-grade tile, and Install.
const showcaseDetailAppId = () => process.env.MOS_E2E_SCREENSHOT_APP || 'seafile';

// One-per-run guards for captures hooked into repeated flows.
const capturedOnce = new Set();

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

// A managed tile carries no address: it links to Suite Manager's own redirect,
// which resolves the app against whichever door this request arrived on. So the
// tile is checked by following it rather than by reading a host out of it.
async function expectHomepageHref(app, page, href) {
  expect(href || '', `${app.id} Homepage tile should link to the Suite Manager app redirect`)
    .toMatch(/^\/suite-manager\/open\/[0-9a-f-]{36}$/u);
  const redirect = await page.request.get(new URL(href, page.url()).toString(), { maxRedirects: 0, timeout: 60000 });
  expect(redirect.status(), `${app.id} tile should redirect`).toBe(302);
  expect(redirect.headers().location, `${app.id} tile should resolve to its address on this door`).toBe(routeUrl(page, app));
  if (app.id === 'vaultwarden') {
    expect(new URL(redirect.headers().location).protocol, 'Vaultwarden must resolve to HTTPS').toBe('https:');
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

  // Marketing shot of the pre-install detail view in its untouched state:
  // product prefills, posture-grade tile, and the Install action.
  if (app.id === showcaseDetailAppId()) {
    await capturePageShot(page, 'app-detail-install');
  }

  const install = details.getByRole('button', { name: /^Install$/iu });
  if (await install.isVisible().catch(() => false)) {
    await install.click();

    // Install opens the same review dialog for every app now, whichever way
    // the detail page looked before it: what the app asks for, the address it
    // will get, and the Homepage shortcut all live there rather than on the
    // page behind it. The dialog is portalled to <body>, so it is reached
    // from the page and not through the details locator.
    const config = page.getByRole('dialog', { name: `Install ${app.name}` });
    await expect(config).toBeVisible({ timeout: 30000 });

    for (const [fieldId, value] of Object.entries(setupConfigFor(app, env))) {
      const field = app.setup?.fields?.find((item) => item.id === fieldId);
      if (!field || field.generated) continue;
      await config.getByLabel(field.label, { exact: true }).fill(value);
    }

    const shortcut = config.getByRole('switch', { name: 'Show on Homepage' });
    if (await shortcut.isVisible().catch(() => false)) await shortcut.check();

    await config.getByRole('button', { name: /^Install$/iu }).click();
    await expect(config).toBeHidden({ timeout: 30000 });

    // Progress stays on the detail page for the whole install, which is why
    // the dialog hands over and closes rather than reporting it itself.
    await expect(details.getByText(/Preparing app|Starting app|Homepage shortcut|Ready to open|Install complete/iu).first()).toBeVisible({ timeout: 30000 });
    if (!capturedOnce.has('app-install-progress')) {
      capturedOnce.add('app-install-progress');
      await capturePageShot(page, 'app-install-progress');
    }
  }

  const running = await waitForRunning(page, app.id);
  await details.getByLabel('Close app details').click();
  await expect(details).toBeHidden({ timeout: 30000 });
  return running;
}

export async function verifyAppsPage(page, entryUrl = '/') {
  await openSuiteManager(page, 'Apps', entryUrl);
  await expect(page.getByRole('heading', { exact: true, level: 1, name: 'Apps' })).toBeVisible();
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

async function closeAppDetails(page, details) {
  await details.getByLabel('Close app details').click();
  await expect(details).toBeHidden({ timeout: 30000 });
}

// Marketing screenshots that need the fully installed suite: the catalog
// with running apps, the privacy posture dialog, the Connect visual, and a
// per-app setup guide. Called from the full spec after the connect step.
// Every block is best-effort — a missed shot logs a warning and the
// regression continues (see support/screenshots.mjs).
export async function captureMarketingScreenshots(page, env, entryUrl = '/') {
  try {
    await verifyAppsPage(page, entryUrl);
    await capturePageShot(page, 'app-catalog', { fullPage: true });
  } catch (error) {
    console.warn(`[screenshots] app catalog capture skipped: ${error.message}`);
  }

  try {
    const showcase = await packageById(page, showcaseDetailAppId());
    const details = await openAppDetails(page, showcase);
    const postureTile = details.locator('.suite-privacy-tile').first();
    if (await visible(postureTile)) {
      await postureTile.click();
      const dialog = page.getByRole('dialog', { name: `${showcase.name} privacy` });
      await expect(dialog).toBeVisible({ timeout: 15000 });
      await capturePageShot(page, 'privacy-posture');
      await dialog.getByRole('button', { exact: true, name: 'Close' }).click();
      await expect(dialog).toBeHidden({ timeout: 15000 });
    }
    const connections = details.locator('section.suite-app-detail-section', { hasText: 'Connections' }).first();
    if (await visible(connections)) {
      await captureElementShot(connections, 'app-connect');
    }
    await closeAppDetails(page, details);
  } catch (error) {
    console.warn(`[screenshots] posture/connect capture skipped: ${error.message}`);
  }

  try {
    const guideApp = await packageById(page, 'radicale');
    if (guideApp.instance) {
      const details = await openAppDetails(page, guideApp);
      const guideButton = details.getByRole('button', { name: /^(Setup guide|Continue guide)$/iu }).first();
      if (await visible(guideButton)) {
        await guideButton.click();
        await expect(page.getByLabel(`${guideApp.name} setup guide`)).toBeVisible({ timeout: 15000 });
        await capturePageShot(page, 'app-setup-guide');
        await page.getByLabel('Close setup guide').click();
      }
      await closeAppDetails(page, details);
    }
  } catch (error) {
    console.warn(`[screenshots] setup guide capture skipped: ${error.message}`);
  }
}

// The update-review dialog only exists when the lab actually has a newer
// compatible package for an installed app, so this shot refreshes
// opportunistically: any run that encounters a real update captures it,
// and runs without one leave the previous capture in place.
export async function captureUpdateReviewIfAvailable(page, entryUrl = '/') {
  try {
    const packages = await listPackages(page);
    const candidate = packages.find((item) => item.instance
      && item.catalogUpdate?.status === 'update-available'
      && item.catalogUpdate.available?.compatibility === 'compatible');
    if (!candidate) {
      console.log('[screenshots] no compatible app update in this lab; app-update-review.png not refreshed');
      return;
    }
    await verifyAppsPage(page, entryUrl);
    const details = await openAppDetails(page, candidate);
    const review = details.getByRole('button', { name: /^Review update$/iu });
    if (await visible(review)) {
      await review.click();
      const dialog = page.getByRole('dialog', { name: `Review ${candidate.name} update` });
      await expect(dialog).toBeVisible({ timeout: 30000 });
      await capturePageShot(page, 'app-update-review');
      await dialog.getByRole('button', { name: /^(Cancel|Close)$/u }).click();
      await expect(dialog).toBeHidden({ timeout: 15000 });
    }
    await closeAppDetails(page, details);
  } catch (error) {
    console.warn(`[screenshots] update review capture skipped: ${error.message}`);
  }
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
    await expectHomepageHref(app, page, await link.getAttribute('href'));
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
  // It is NOT a <button> element! It is an <a> anchor tag with role="button"
  // Playwright getByRole('button') matches both native buttons AND elements with role="button"

  // Step 1: Click first button "Add it later"
  await page.getByRole('button', { name: /add it later/i }).click({ timeout: 10000 });

  // Step 2: Click second button "Skip to web app"
  await page.getByText(/skip to web app/i).click({ timeout: 10000, force: true });
  await page.waitForTimeout(1000);

  // Fallback if anything went wrong
  if (/setup-extension/i.test(page.url())) {
    await page.goto(fallbackUrl);
  }
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
  if (await visible(continueButton)) {
    await continueButton.click();
  }
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
  if (await visible(name)) {
    await name.fill(env.vaultwarden.name);
  }
  const password = page.locator('input[type="password"]').nth(0);
  const confirmPassword = page.locator('input[type="password"]').nth(1);
  await expect(password, 'Vaultwarden account password field should be visible').toBeVisible({ timeout: 30000 });
  await expect(confirmPassword, 'Vaultwarden confirm password field should be visible').toBeVisible({ timeout: 30000 });
  await password.fill(env.vaultwarden.password);
  await confirmPassword.fill(env.vaultwarden.password);
  
  // Small intentional pause before submit to prevent race condition
  await page.waitForTimeout(300);
  
  await page.getByRole('button', { name: /create account|opret konto|submit|continue|sign up/i }).click();
  
  // Vaultwarden automatically logs you in immediately after signup, no separate login required
  await waitForVaultwardenSignupOutcome(page);
  
  // Small pause for state to settle after signup
  await page.waitForTimeout(500);
  
  if (!/#\/vault/i.test(page.url())) {
    await page.goto(vaultUrl);
  }
  // await signInToVaultwardenIfNeeded(page, env, emailAddress);
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
    await expectHomepageHref(app, page, await link.getAttribute('href'));
    const appUrl = routeUrl(page, app);
    if (appUrl) await waitForRouteAvailable(page, app, appUrl);
    const beforeClickUrl = page.url();
    const popupPromise = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await link.click();
    const appPage = (await popupPromise) || page;
    await appPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => undefined);
    if (appPage.url() === beforeClickUrl && appUrl) await appPage.goto(appUrl, { waitUntil: 'domcontentloaded' });

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
