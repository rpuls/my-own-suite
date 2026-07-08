import { expect } from '@playwright/test';

import { apiJson } from './hyperv-api.mjs';
import { redact } from './hyperv-env.mjs';

export async function applyDns01IfConfigured(page, env) {
  if (!env.enableDns01) return null;
  if (!env.cloudflareApiToken || !env.dns01BaseDomain) {
    throw new Error('DNS-01 E2E is enabled, but CLOUDFLARE_API_TOKEN or MOS_V2_E2E_DNS01_BASE_DOMAIN is missing.');
  }
  const status = await apiJson(page, '/suite-manager/api/settings/https');
  expect(status.agentAvailable, 'HTTPS agent should be available before DNS-01 apply').toBe(true);
  const result = await apiJson(page, '/suite-manager/api/settings/https/apply', {
    body: JSON.stringify({
      acmeEmail: env.dns01AcmeEmail,
      baseDomain: env.dns01BaseDomain,
      cloudflareApiToken: env.cloudflareApiToken,
    }),
    method: 'POST',
  }).catch((error) => {
    throw new Error(`DNS-01 apply failed with token ${redact(env.cloudflareApiToken)}: ${error.message}`);
  });
  expect(result.status).toBe('applied');
  expect(result.homeUrl).toContain(`home.${env.dns01BaseDomain}`);
  await page.goto(result.homeUrl);
  await expect(page.locator('body')).toContainText('My Own Suite', { timeout: 90000 });
  return result;
}
