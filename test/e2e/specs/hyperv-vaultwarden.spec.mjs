import { test } from '@playwright/test';

import { expectSignedInApi } from '../support/hyperv-api.mjs';
import { ensureOwnerSession } from '../support/hyperv-auth.mjs';
import { loadHypervEnv } from '../support/hyperv-env.mjs';
import { applyDns01IfConfigured } from '../support/hyperv-https.mjs';
import { resetLabIfConfigured } from '../support/hyperv-lab-reset.mjs';
import { clickHomepageAppTiles, installCatalogApps, verifyHomepageAppTiles } from '../support/hyperv-apps.mjs';

const env = loadHypervEnv();

test.describe.configure({ mode: 'serial' });

test('Hyper-V focused Vaultwarden DNS-01 signup regression', async ({ page }) => {
  await test.step('reset lab state', async () => {
    await resetLabIfConfigured(page, env);
  });

  await test.step('create or sign in owner', async () => {
    await ensureOwnerSession(page, env);
    await expectSignedInApi(page);
  });

  const dns01 = await test.step('apply DNS-01 HTTPS', async () => {
    const result = await applyDns01IfConfigured(page, env);
    if (!result?.homeUrl) throw new Error('Focused Vaultwarden E2E requires DNS-01. Set MOS_E2E_DNS01_BASE_DOMAIN and CLOUDFLARE_API_TOKEN.');
    await ensureOwnerSession(page, env, `${result.homeUrl.replace(/\/$/u, '')}/suite-manager/`);
    return result;
  });

  await test.step('install Vaultwarden after DNS-01', async () => {
    await installCatalogApps(page, env, ['vaultwarden'], dns01.homeUrl);
    await verifyHomepageAppTiles(page, dns01.homeUrl);
  });

  await test.step('create Vaultwarden owner from Homepage tile', async () => {
    await clickHomepageAppTiles(page, env, dns01.homeUrl, { ids: ['vaultwarden'] });
  });
});
