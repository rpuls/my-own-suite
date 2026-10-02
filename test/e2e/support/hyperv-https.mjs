import { expect } from '@playwright/test';

import { apiJson, apiPathFor } from './hyperv-api.mjs';
import { redact } from './hyperv-env.mjs';
import { openSuiteManager } from './hyperv-navigation.mjs';

// A change of address answers 202 and runs on while the web server restarts
// under the browser's connection, so the outcome is read from the status — first
// through the door the test is on, then through the new name once it serves.
async function waitForAddressChange(page, env) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastStatus = null;
  const homeUrl = `https://home.${env.dns01BaseDomain}/`;

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
      return { appliedAt: change.at, homeUrl: lastStatus.address.url, result: change.result, status: 'applied' };
    }
    await page.waitForTimeout(3000);
  }

  const change = lastStatus?.lastChange;
  const lastState = change ? `${change.status}${change.stage ? ` (${change.stage})` : ''}${change.errorCode ? ` (${change.errorCode})` : ''}` : 'unavailable';
  throw new Error(`The address change did not finish with token ${redact(env.cloudflareApiToken)}. Last status: ${lastState}`);
}

async function diagnostics(page, result) {
  const addressStatus = await apiJson(page, apiPathFor(result.homeUrl, '/suite-manager/api/settings/address')).catch((error) => ({ error: error.message }));
  const setupStatus = await apiJson(page, apiPathFor(result.homeUrl, '/suite-manager/api/setup/status')).catch((error) => ({ error: error.message }));
  return `url=${page.url()} addressStatus=${JSON.stringify(addressStatus)} setupStatus=${JSON.stringify(setupStatus)}`;
}

async function gotoAppliedHome(page, result) {
  const deadline = Date.now() + 2 * 60 * 1000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await page.goto(result.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await expect(page.locator('body')).toContainText('My Own Suite', { timeout: 30000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5000);
    }
  }

  throw new Error(`Applied DNS-01 Home URL did not become browser-reachable. Last error: ${lastError?.message || 'unknown'}. ${await diagnostics(page, result)}`);
}

export async function applyDns01IfConfigured(page, env) {
  if (!env.enableDns01) return null;
  if (!env.cloudflareApiToken || !env.dns01BaseDomain) {
    throw new Error('DNS-01 E2E is enabled, but CLOUDFLARE_API_TOKEN or MOS_E2E_DNS01_BASE_DOMAIN is missing.');
  }
  await openSuiteManager(page, 'Settings');
  const status = await apiJson(page, '/suite-manager/api/settings/address');
  expect(status.agentAvailable, 'HTTPS agent should be available before DNS-01 apply').toBe(true);

  await page.getByLabel('MOS base domain').fill(env.dns01BaseDomain);
  await page.getByLabel('ACME contact email').fill(env.dns01AcmeEmail);
  await page.getByLabel('Cloudflare API token').fill(env.cloudflareApiToken);
  await page.getByRole('button', { name: 'Move my suite to this domain' }).click();
  const result = await waitForAddressChange(page, env);
  expect(result.status).toBe('applied');
  expect(result.homeUrl).toContain(`home.${env.dns01BaseDomain}`);

  // The change certified the name before it reported success, so the new
  // address answers as soon as the browser can resolve it.
  const recovered = await apiJson(page, apiPathFor(result.homeUrl, '/suite-manager/api/settings/address')).catch(() => null);
  expect(recovered?.lastChange?.status || result.status).toBe('applied');
  await gotoAppliedHome(page, result);
  return result;
}
