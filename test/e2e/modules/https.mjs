import { expect } from '@playwright/test';

import { apiJson, apiPathFor } from '../support/api.mjs';
import { ensureOwnerSession } from '../support/auth.mjs';
import { redact } from '../support/env.mjs';
import { openSuiteManager } from '../support/navigation.mjs';

// A change of address answers 202 and runs on while the web server restarts
// under the browser's connection, so the outcome is read from the status — first
// through the door the test is on, then through the new name once it serves.
async function waitForAddressChange(page, env) {
  const deadline = Date.now() + 5 * 60 * 1000;
  const homeUrl = `https://home.${env.dns01BaseDomain}/`;
  let lastStatus = null;
  while (Date.now() < deadline) {
    for (const statusPath of ['/suite-manager/api/settings/address', apiPathFor(homeUrl, '/suite-manager/api/settings/address')]) {
      lastStatus = await apiJson(page, statusPath).catch(() => lastStatus);
      if (lastStatus?.lastChange?.status && lastStatus.lastChange.status !== 'applying') break;
    }
    const change = lastStatus?.lastChange;
    if (change?.status === 'failed') {
      throw new Error(`The address change failed with token ${redact(env.cloudflareApiToken)}: ${change.errorCode || 'unknown'}${change.diagnostics ? `\n${change.diagnostics}` : ''}`);
    }
    if (change?.status === 'applied' && lastStatus.address?.baseDomain === env.dns01BaseDomain) {
      return lastStatus.address.url;
    }
    await page.waitForTimeout(3000);
  }
  const change = lastStatus?.lastChange;
  const lastState = change ? `${change.status}${change.stage ? ` (${change.stage})` : ''}${change.errorCode ? ` (${change.errorCode})` : ''}` : 'unavailable';
  throw new Error(`The address change did not finish with token ${redact(env.cloudflareApiToken)}. Last status: ${lastState}`);
}

async function gotoAppliedHome(page, homeUrl) {
  const deadline = Date.now() + 2 * 60 * 1000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await page.goto(homeUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toContainText('My Own Suite', { timeout: 30000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5000);
    }
  }
  const address = await apiJson(page, apiPathFor(homeUrl, '/suite-manager/api/settings/address')).catch((error) => ({ error: error.message }));
  throw new Error(`The DNS-01 home address did not become reachable. Last error: ${lastError?.message || 'unknown'}. url=${page.url()} address=${JSON.stringify(address)}`);
}

export async function dns01(ctx) {
  const { env, page } = ctx;
  if (!env.dns01Configured) {
    throw new Error('dns01 needs MOS_E2E_DNS01_BASE_DOMAIN and CLOUDFLARE_API_TOKEN in test/e2e/.env.');
  }
  await openSuiteManager(page, 'Settings', ctx.url('/'));
  const status = await apiJson(page, '/suite-manager/api/settings/address');
  expect(status.agentAvailable, 'The HTTPS agent should be available before DNS-01').toBe(true);
  if (status.lastChange?.status === 'applied' && status.address?.baseDomain === env.dns01BaseDomain) {
    ctx.homeUrl = status.address.url.replace(/\/$/u, '');
    await ensureOwnerSession(page, env, ctx.url('/suite-manager/'));
    return;
  }

  await page.locator('#set-address').getByRole('button', { name: /^(Edit|Use your own domain)$/u }).click();
  await page.getByLabel('Base domain').fill(env.dns01BaseDomain);
  await page.getByLabel('Certificate contact email').fill(env.dns01AcmeEmail);
  await page.getByLabel('Cloudflare API token').fill(env.cloudflareApiToken);
  await page.getByRole('button', { name: 'Move my suite to this domain' }).click();
  const homeUrl = await waitForAddressChange(page, env);
  expect(homeUrl).toContain(`home.${env.dns01BaseDomain}`);

  await gotoAppliedHome(page, homeUrl);
  ctx.homeUrl = homeUrl.replace(/\/$/u, '');
  await ensureOwnerSession(page, env, ctx.url('/suite-manager/'));
}
