import { test } from '@playwright/test';

import { expectSignedInApi } from '../support/hyperv-api.mjs';
import { ensureOwnerSession } from '../support/hyperv-auth.mjs';
import { createBackupIfAvailable, restoreBackupIfAvailable } from '../support/hyperv-backups.mjs';
import { exportDiagnosticsBundle, verifyDiagnosticsBundle } from '../support/hyperv-diagnostics.mjs';
import { loadHypervEnv } from '../support/hyperv-env.mjs';
import { assertLogSurface } from '../support/hyperv-log-assertions.mjs';
import { customizeHomepage, verifyHomepageCustomization, waitForHomepageAvailable } from '../support/hyperv-homepage.mjs';
import { applyDns01IfConfigured } from '../support/hyperv-https.mjs';
import { resetLabIfConfigured } from '../support/hyperv-lab-reset.mjs';
import { capturePlatformUpdateScreenshot } from '../support/hyperv-updates.mjs';
import {
  captureMarketingScreenshots,
  captureUpdateReviewIfAvailable,
  clickHomepageAppTiles,
  connectSeafileOnlyOffice,
  expectInstalledAppIds,
  installCatalogApps,
  lifecycleSmoke,
  verifyAppRoutes,
  verifyHomepageAppTiles,
} from '../support/hyperv-apps.mjs';

const env = loadHypervEnv();

test.describe.configure({ mode: 'serial' });

test('Hyper-V MOS full platform regression', async ({ browser, page }) => {
  test.skip(env.enableUpdate, 'Update validation is intentionally not part of the default full suite yet.');
  let homepageCheckpoint = null;
  let earlyBackup = null;
  const checkpointAppIds = env.preDnsAppIds.slice(0, 1);
  const remainingPreDnsAppIds = env.preDnsAppIds.slice(1);

  await test.step('reset lab state', async () => {
    await resetLabIfConfigured(page, env);
  });

  await test.step('create or sign in owner', async () => {
    await ensureOwnerSession(page, env);
    await expectSignedInApi(page);
  });

  await test.step('customize Homepage', async () => {
    homepageCheckpoint = await customizeHomepage(page);
  });

  await test.step('install first pre-DNS app for restore checkpoint', async () => {
    if (!checkpointAppIds.length) throw new Error('Hyper-V full E2E needs at least one pre-DNS app so backup/restore can prove rollback.');
    await installCatalogApps(page, env, checkpointAppIds);
  });

  await test.step('create restore checkpoint after first app', async () => {
    earlyBackup = await createBackupIfAvailable(page, env);
  });

  await test.step('install remaining pre-DNS apps', async () => {
    await installCatalogApps(page, env, remainingPreDnsAppIds);
  });

  await test.step('verify pre-DNS Homepage tiles and app routes', async () => {
    await verifyHomepageAppTiles(page);
    await verifyAppRoutes(page);
  });

  await test.step('click pre-DNS Homepage app tiles and verify app logins', async () => {
    await clickHomepageAppTiles(page, env, '/', { browser, ids: env.preDnsAppIds });
  });

  const dns01 = await test.step('apply DNS-01 HTTPS before post-DNS apps', async () => {
    const result = await applyDns01IfConfigured(page, env);
    if (!result?.homeUrl) throw new Error('Hyper-V full E2E requires DNS-01 before post-DNS app installs. Set MOS_E2E_DNS01_BASE_DOMAIN and CLOUDFLARE_API_TOKEN in test/e2e/.env.');
    if (result?.homeUrl) {
      await ensureOwnerSession(page, env, `${result.homeUrl.replace(/\/$/u, '')}/suite-manager/`);
    }
    return result;
  });

  await test.step('install post-DNS apps', async () => {
    await installCatalogApps(page, env, env.postDnsAppIds, dns01?.homeUrl || '/');
  });

  await test.step('connect Seafile and ONLYOFFICE', async () => {
    if (dns01?.homeUrl) await page.goto(`${dns01.homeUrl.replace(/\/$/u, '')}/suite-manager/`);
    await connectSeafileOnlyOffice(page);
  });

  await test.step('capture marketing screenshots', async () => {
    await captureMarketingScreenshots(page, env, dns01?.homeUrl || '/');
    await captureUpdateReviewIfAvailable(page, dns01?.homeUrl || '/');
    await capturePlatformUpdateScreenshot(page, dns01?.homeUrl || '/');
  });

  await test.step('verify Homepage app tiles', async () => {
    await verifyHomepageAppTiles(page, dns01?.homeUrl || '/');
  });

  await test.step('click Homepage app tiles and verify app logins', async () => {
    await clickHomepageAppTiles(page, env, dns01?.homeUrl || '/', { browser });
  });

  await test.step('verify app routes', async () => {
    await waitForHomepageAvailable(page, dns01?.homeUrl || '/');
    await verifyAppRoutes(page);
  });

  // Placed after the apps are installed and routed, because that is the state
  // the export has to describe: containers to collect, secrets to redact
  // against, and a machine that got here by managed update rather than a
  // reinstall.
  await test.step('export a diagnostics bundle and inspect what this run left in the logs', async () => {
    const bundle = await exportDiagnosticsBundle(page, dns01?.homeUrl || '/');
    await verifyDiagnosticsBundle(bundle);
    await assertLogSurface(bundle, env);
  });

  await test.step('optional lifecycle smoke', async () => {
    await lifecycleSmoke(page, env);
  });

  await test.step('restore early checkpoint and verify rollback', async () => {
    await waitForHomepageAvailable(page, dns01?.homeUrl || '/');
    const restored = await restoreBackupIfAvailable(page, env, earlyBackup);
    if (!restored) return;
    await ensureOwnerSession(page, env);
    await expectSignedInApi(page);
    await verifyHomepageCustomization(page, homepageCheckpoint);
    await expectInstalledAppIds(page, checkpointAppIds);
  });
});
