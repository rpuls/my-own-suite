import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { catalogApps, loadAppModule, requireAppModule } from '../support/catalog.mjs';
import { fixtureMaker } from '../support/fixtures.mjs';
import { waitForHomepageAvailable } from '../support/homepage.mjs';
import {
  appRunning,
  closeAppDetails,
  expectTileRedirect,
  hasTile,
  installedPackages,
  isInstalled,
  listPackages,
  openAppDetails,
  openAppsScreen,
  packageById,
  projectionApplied,
  routeUrl,
  tileLink,
  waitForRouteAvailable,
  waitForRunning,
} from '../support/packages.mjs';
import { capturePageShot } from '../support/screenshots.mjs';
import { takeShot } from '../support/shots.mjs';
import { showcaseApp } from './marketing.mjs';

const capturedOnce = new Set();

function needsHttps(id) {
  return catalogApps().find((item) => item.id === id)?.needsHttps === true;
}

// Null keeps what the dialog prefilled from the package's own default.
function defaultSetupValue(app, field, env) {
  if (typeof field.default === 'string') return null;
  if (field.type === 'email') return env.owner.email;
  if (field.type === 'password') return `${app.id}-${field.id}-test-password`;
  return `e2e-${field.id}`;
}

// The install dialog, field by field: the app module's own value where it has
// one, the dialog's prefill or a predictable value otherwise. What was entered
// is kept in the app's state, so the log check knows the secrets.
async function fillSetupFields(ctx, app, dialog) {
  const module = await loadAppModule(app.id);
  const values = {};
  for (const field of app.setup?.fields || []) {
    if (field.generated) continue;
    const input = dialog.getByLabel(field.label, { exact: true });
    const value = module?.setupValue?.({ env: ctx.env, field }) ?? defaultSetupValue(app, field, ctx.env);
    if (value === null) {
      values[field.id] = await input.inputValue();
    } else {
      await input.fill(value);
      values[field.id] = value;
    }
  }
  return values;
}

async function installViaUi(ctx, app) {
  const { page } = ctx;
  const details = await openAppDetails(page, app);
  if (app.id === await showcaseApp('app-detail-install')) await capturePageShot(page, 'app-detail-install');

  const install = details.getByRole('button', { name: /^Install$/iu });
  // The server runs the install as one job, so a failed job ends the step with
  // the job's own answer instead of a twelve-minute wait for Running.
  let settled = false;
  let refused = new Promise(() => {});
  if (await install.isVisible().catch(() => false)) {
    refused = (async () => {
      while (!settled) {
        await page.waitForTimeout(3000);
        const job = (await packageById(page, app.id)).installJob;
        if (job?.status === 'failed') {
          throw new Error(`${app.id} install failed at ${job.steps.find((step) => step.status === 'failed')?.id}: ${job.error?.message}`);
        }
      }
      return new Promise(() => {});
    })();
    refused.catch(() => undefined);
    await install.click();

    const dialog = page.getByRole('dialog', { name: `Install ${app.name}` });
    await expect(dialog).toBeVisible({ timeout: 30000 });
    const values = await fillSetupFields(ctx, app, dialog);
    ctx.state(app.id).setup = values;
    ctx.state(app.id).passwordFields = app.setup.fields.filter((field) => field.type === 'password' && field.id in values).map((field) => field.id);
    const shortcut = dialog.getByRole('switch', { name: 'Show on Homepage' });
    if (await shortcut.isVisible().catch(() => false)) await shortcut.check();
    await dialog.getByRole('button', { name: /^Install$/iu }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });

    await expect(details.getByText(/Preparing app|Starting app|Homepage shortcut|Ready to open|Install complete/iu).first()).toBeVisible({ timeout: 30000 });
    if (!capturedOnce.has('app-install-progress')) {
      capturedOnce.add('app-install-progress');
      await capturePageShot(page, 'app-install-progress');
    }
  }

  const running = await Promise.race([waitForRunning(page, app.id, { minutes: 20 }), refused]);
  settled = true;
  await closeAppDetails(details);
  return running;
}

export async function install(ctx, id) {
  const { page } = ctx;
  await openAppsScreen(page, ctx.url('/'));
  let app = await packageById(page, id);
  expect(app.validation.valid, `${id} manifest should be valid`).toBe(true);
  if (!appRunning(app) || (app.homepage && !hasTile(app))) app = await installViaUi(ctx, app);
  if (app.homepage && !hasTile(app)) {
    await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/add-to-homepage`, { method: 'POST' });
    app = await packageById(page, id);
  }
  ctx.state(id).installedVersion = app.instance?.packageVersion || null;
}

// Opens the app the way an owner does, through its Homepage tile; an app with no
// tile (a provider other apps use) is opened at its own address instead.
async function openApp(ctx, id, module) {
  const { page } = ctx;
  const app = await packageById(page, id);
  if (!isInstalled(app)) throw new Error(`${id} is not installed.`);
  const url = routeUrl(ctx.homeUrl, app);
  if (url) await waitForRouteAvailable(page, app, url);

  let appPage = page;
  if (hasTile(app)) {
    await waitForHomepageAvailable(page, ctx.url('/'));
    const link = tileLink(page, app);
    await expect(link, `${id} Homepage tile should be clickable`).toBeVisible({ timeout: 60000 });
    await expectTileRedirect(page, ctx.homeUrl, app, await link.getAttribute('href'), { needsHttps: needsHttps(id) });
    const beforeClick = page.url();
    const popup = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await link.click();
    appPage = (await popup) || page;
    await appPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => undefined);
    if (appPage.url() === beforeClick && url) await appPage.goto(url, { waitUntil: 'domcontentloaded' });
  } else {
    if (!url) throw new Error(`${id} has neither a Homepage tile nor an address to open.`);
    appPage = await page.context().newPage();
    await appPage.goto(url, { waitUntil: 'domcontentloaded' });
  }

  if (module.landed) await module.landed({ page: appPage });
  else await expect(appPage.locator('body')).not.toBeEmpty({ timeout: 60000 });

  return {
    // The app's own connection slots that another installed app currently fills.
    connected: (app.compatibility?.connections || []).filter((item) => item.relationship?.status === 'active').map((item) => item.slotId),
    async close() {
      if (appPage !== page) {
        await appPage.close();
        await page.bringToFront();
      } else {
        await page.goto(ctx.url('/'), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      }
    },
    page: appPage,
    url,
  };
}

function appContext(ctx, id, module, opened, freshContexts) {
  const state = ctx.state(id);
  return {
    connected: opened.connected,
    env: ctx.env,
    expect,
    // A browser with nothing stored, as a new device would be: proof that what
    // the app shows comes from the server and not from the browser's own copy.
    async freshPage() {
      const { deviceScaleFactor, viewport } = test.info().project.use;
      const context = await ctx.browser.newContext({ deviceScaleFactor, ignoreHTTPSErrors: true, viewport });
      freshContexts.push(context);
      ctx.network?.watch(context);
      return context.newPage();
    },
    make: fixtureMaker(ctx, id),
    owner: ctx.env.owner,
    page: opened.page,
    setup: state.setup || {},
    async shot(name, { page = opened.page, ...options } = {}) {
      const mask = module.masks ? await module.masks(page) : [];
      return takeShot(ctx, id, page, name, { ...options, mask: [...mask, ...(options.mask || [])] });
    },
    state,
    step: (title, body) => test.step(title, body),
    url: opened.url,
  };
}

// Playwright's own error context shows the suite's tab, while an app fails in the
// tab its tile opened, so the app's pages are written down as text beside it.
async function describeAppPages(ctx, id, pages) {
  const lines = [];
  for (const [index, page] of pages.entries()) {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch((error) => `(no snapshot: ${error.message.split('\n')[0]})`);
    const file = path.join(ctx.resultsDir, 'failures', `${String(ctx.stepIndex + 1).padStart(2, '0')}-${id}-page-${index + 1}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${page.url()}\n${snapshot}\n`);
    lines.push(`\nApp page ${index + 1}: ${page.url()}\n  snapshot: ${path.relative(process.cwd(), file)}`);
  }
  return lines.join('');
}

async function runAppHook(ctx, id, hook) {
  const module = await requireAppModule(id);
  if (typeof module[hook] !== 'function') throw new Error(`apps/${id}/e2e/index.mjs exports no ${hook}().`);
  const opened = await openApp(ctx, id, module);
  const freshContexts = [];
  try {
    await module[hook](appContext(ctx, id, module, opened, freshContexts));
  } catch (error) {
    const appPages = new Set([opened.page, ...opened.page.context().pages().filter((item) => item !== ctx.page), ...freshContexts.flatMap((context) => context.pages())]);
    error.message += await describeAppPages(ctx, id, [...appPages]);
    throw error;
  } finally {
    for (const context of freshContexts) await context.close().catch(() => undefined);
    await opened.close();
  }
}

export async function app(ctx, id) {
  await runAppHook(ctx, id, 'journey');
}

export async function verify(ctx, id) {
  await runAppHook(ctx, id, 'verify');
}

export async function update(ctx, id) {
  const { page } = ctx;
  await openAppsScreen(page, ctx.url('/'));
  const before = await packageById(page, id);
  const target = before.catalogUpdate?.available?.packageVersion;
  if (before.catalogUpdate?.status !== 'update-available' || !target) {
    throw new Error(`${id} is offered no update (catalog status ${before.catalogUpdate?.status || 'none'}, installed ${before.instance?.packageVersion || 'none'}).`);
  }
  ctx.state(id).updatedFrom = before.instance?.packageVersion || null;

  const details = await openAppDetails(page, before);
  await details.getByRole('button', { name: /^Review update$/iu }).first().click();
  const dialog = page.getByRole('dialog', { name: `Review ${before.name} update` });
  await expect(dialog).toBeVisible({ timeout: 60000 });
  await takeShot(ctx, id, page, 'update-review', { fullPage: false });
  const module = await loadAppModule(id);
  for (const input of await dialog.locator('input').all()) {
    if (await input.inputValue()) continue;
    const label = await input.getAttribute('aria-label') || await input.evaluate((element) => element.labels?.[0]?.textContent || '');
    const value = module?.setupValue?.({ env: ctx.env, field: { label } });
    if (!value) throw new Error(`The ${id} update asks for "${label}", and apps/${id}/e2e has no value for it.`);
    await input.fill(value);
  }
  await dialog.getByRole('button', { exact: true, name: 'Update' }).click();
  const said = await updateDialogOutcome(dialog, 25);
  // What the owner was told is checked apart from what happened, so a dialog
  // that reports failure for an update that went through still fails the run
  // without hiding whether the app's data made it across.
  expect.soft(said, `The ${id} update dialog should close on success, not report a failure`).toBe('closed');
  if (said !== 'closed') await dialog.getByRole('button', { name: /^(Cancel|Close)$/u }).click().catch(() => undefined);
  await closeAppDetails(details).catch(() => undefined);

  const after = await waitForRunning(page, id, { minutes: 20, version: target });
  ctx.state(id).installedVersion = after.instance.packageVersion;
}

async function updateDialogOutcome(dialog, minutes) {
  const deadline = Date.now() + minutes * 60 * 1000;
  const failed = dialog.getByText('The update did not finish');
  while (Date.now() < deadline) {
    if (!(await dialog.isVisible().catch(() => false))) return 'closed';
    if (await failed.isVisible().catch(() => false)) return `failed: ${(await dialog.innerText()).split('The update did not finish')[1]?.trim().split('\n')[0] || 'no reason shown'}`;
    await dialog.page().waitForTimeout(5000);
  }
  return `still open after ${minutes} minutes`;
}

export async function lifecycle(ctx, id) {
  const { page } = ctx;
  await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  expect((await packageById(page, id)).instance?.enabled).toBe(false);
  await apiJson(page, `/suite-manager/api/apps/packages/${encodeURIComponent(id)}/enable`, { method: 'POST' });
  expect(appRunning(await waitForRunning(page, id))).toBe(true);
}

export async function tiles(ctx) {
  const { page } = ctx;
  const withTiles = (await listPackages(page)).filter(hasTile);
  await waitForHomepageAvailable(page, ctx.url('/'));
  for (const app of withTiles) {
    await expect(page.getByText(app.homepage.name)).toBeVisible({ timeout: 60000 });
    await expectTileRedirect(page, ctx.homeUrl, app, await tileLink(page, app).getAttribute('href'), { needsHttps: needsHttps(app.id) });
  }
}

export async function routes(ctx) {
  const { page } = ctx;
  await page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const https = new URL(ctx.homeUrl).protocol === 'https:';
  for (const app of (await installedPackages(page)).filter((item) => item.routes?.length && item.role !== 'capability-provider')) {
    if (needsHttps(app.id) && !https) continue;
    const response = await waitForRouteAvailable(page, app, routeUrl(ctx.homeUrl, app));
    expect(response.status(), `${app.id} should not answer with a server error`).toBeLessThan(500);
  }
}

// Every installed consumer is connected to every installed provider it offers a
// connection to, so apps that work together are tested together.
export async function connect(ctx) {
  const { page } = ctx;
  await page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const installed = await installedPackages(page);
  const installedIds = new Set(installed.map((item) => item.id));
  for (const consumer of installed) {
    for (const connection of consumer.compatibility?.connections || []) {
      if (!installedIds.has(connection.provider.id) || connection.relationship?.status === 'active') continue;
      expect(connection.ready, `${consumer.id} + ${connection.provider.id} should be ready to connect`).toBe(true);
      await apiJson(page, '/suite-manager/api/apps/integrations/connect', {
        body: JSON.stringify({
          consumerPackageId: connection.consumerPackageId,
          providerCapabilityId: connection.capabilityId,
          providerPackageId: connection.provider.id,
          slotId: connection.slotId,
        }),
        method: 'POST',
      });
      const updated = await packageById(page, consumer.id);
      const active = updated.compatibility?.connections?.find((item) => item.provider.id === connection.provider.id && item.slotId === connection.slotId);
      expect(active?.relationship?.status, `${consumer.id} should be connected to ${connection.provider.id}`).toBe('active');
    }
  }
}

export async function installed(ctx, list) {
  await ctx.page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const expected = String(list || '').split(',').filter(Boolean).sort();
  const actual = (await installedPackages(ctx.page)).map((item) => item.id).sort();
  expect(actual, 'The installed apps should be exactly the expected ones').toEqual(expected);
}

export async function absent(ctx, id) {
  await ctx.page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const app = await packageById(ctx.page, id);
  expect(isInstalled(app), `${id} should not be installed`).toBe(false);
  expect(projectionApplied(app, 'homepage'), `${id} should have no Homepage tile`).toBe(false);
}
