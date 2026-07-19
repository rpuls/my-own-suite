import { expect } from '@playwright/test';

import { apiJson, apiPathFor } from './hyperv-api.mjs';
import { redact } from './hyperv-env.mjs';
import { openSuiteManager } from './hyperv-navigation.mjs';

async function waitForDns01Applied(page, env, responsePromise) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastStatus = null;
  let lastResponseResult = null;

  while (Date.now() < deadline) {
    if (!lastResponseResult) {
      lastResponseResult = await Promise.race([
        responsePromise,
        page.waitForTimeout(1000).then(() => null),
      ]);
    }

    if (lastResponseResult?.type === 'response') {
      if (!lastResponseResult.response.ok()) {
        const error = lastResponseResult.body?.error || lastResponseResult.response.status();
        throw new Error(`DNS-01 apply failed with token ${redact(env.cloudflareApiToken)}: ${error}`);
      }
      if (lastResponseResult.body?.status === 'applied') return lastResponseResult.body;
    }

    lastStatus = await apiJson(page, '/suite-manager/api/settings/https').catch(() => null);
    if (lastStatus?.lastApply?.status === 'applied' && lastStatus.baseDomain === env.dns01BaseDomain) {
      return {
        appliedAt: lastStatus.lastApply.at || new Date().toISOString(),
        bootstrapUrl: lastStatus.bootstrapUrl,
        homeUrl: lastStatus.activeHomeUrl,
        status: 'applied',
      };
    }

    await page.waitForTimeout(3000);
  }

  const lastApply = lastStatus?.lastApply;
  const lastState = lastApply ? `${lastApply.status}${lastApply.errorCode ? ` (${lastApply.errorCode})` : ''}` : 'unavailable';
  throw new Error(`DNS-01 apply did not reach applied state with token ${redact(env.cloudflareApiToken)}. Last HTTPS status: ${lastState}`);
}

async function diagnostics(page, result) {
  const httpsStatus = await apiJson(page, apiPathFor(result.homeUrl, '/suite-manager/api/settings/https')).catch((error) => ({ error: error.message }));
  const setupStatus = await apiJson(page, apiPathFor(result.homeUrl, '/suite-manager/api/setup/status')).catch((error) => ({ error: error.message }));
  return `url=${page.url()} httpsStatus=${JSON.stringify(httpsStatus)} setupStatus=${JSON.stringify(setupStatus)}`;
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
  const status = await apiJson(page, '/suite-manager/api/settings/https');
  expect(status.agentAvailable, 'HTTPS agent should be available before DNS-01 apply').toBe(true);

  const applyResponse = page.waitForResponse(
    (response) => response.url().includes('/suite-manager/api/settings/https/apply') && response.request().method() === 'POST',
    { timeout: 5 * 60 * 1000 },
  ).then(async (response) => ({
    body: await response.json().catch(() => ({})),
    response,
    type: 'response',
  })).catch((error) => ({
    error,
    type: 'response-error',
  }));
  await page.getByLabel('MOS base domain').fill(env.dns01BaseDomain);
  await page.getByLabel('ACME contact email').fill(env.dns01AcmeEmail);
  await page.getByLabel('Cloudflare API token').fill(env.cloudflareApiToken);
  await page.getByRole('button', { name: 'Apply HTTPS settings' }).click();
  const result = await waitForDns01Applied(page, env, applyResponse);
  expect(result.status).toBe('applied');
  expect(result.homeUrl).toContain(`home.${env.dns01BaseDomain}`);

  await expect(page.getByRole('link', { name: result.homeUrl })).toBeVisible({ timeout: 30000 }).catch(() => undefined);
  const recovered = await apiJson(page, apiPathFor(result.homeUrl, '/suite-manager/api/settings/https')).catch(() => null);
  expect(recovered?.lastApply?.status || result.status).toBe('applied');
  await gotoAppliedHome(page, result);
  return result;
}
