import { test } from '@playwright/test';

import { expectSignedInApi } from '../support/hyperv-api.mjs';
import { ensureOwnerSession } from '../support/hyperv-auth.mjs';
import { createBackupIfAvailable } from '../support/hyperv-backups.mjs';
import { loadHypervEnv } from '../support/hyperv-env.mjs';
import { customizeHomepage } from '../support/hyperv-homepage.mjs';
import { applyDns01IfConfigured } from '../support/hyperv-https.mjs';
import { resetLabIfConfigured } from '../support/hyperv-lab-reset.mjs';
import {
  connectSeafileOnlyOffice,
  installCatalogApps,
  lifecycleSmoke,
  verifyAppRoutes,
  verifyHomepageAppTiles,
} from '../support/hyperv-apps.mjs';

const env = loadHypervEnv();

test.describe.configure({ mode: 'serial' });

test('Hyper-V MOS V2 full platform regression', async ({ page }) => {
  test.skip(env.enableRestore, 'Restore validation is intentionally not part of the default full suite yet.');
  test.skip(env.enableUpdate, 'Update validation is intentionally not part of the default full suite yet.');

  await resetLabIfConfigured(page, env);
  await ensureOwnerSession(page, env);
  await expectSignedInApi(page);

  await customizeHomepage(page);

  const dns01 = await applyDns01IfConfigured(page, env);
  if (dns01?.homeUrl) {
    await ensureOwnerSession(page, env, `${dns01.homeUrl.replace(/\/$/u, '')}/suite-manager/`);
  }

  await installCatalogApps(page, env);
  await connectSeafileOnlyOffice(page);
  await verifyHomepageAppTiles(page, dns01?.homeUrl || '/');
  await verifyAppRoutes(page);
  await lifecycleSmoke(page, env);
  await createBackupIfAvailable(page, env);
});
