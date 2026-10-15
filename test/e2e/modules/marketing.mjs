import { expect } from '@playwright/test';

import { catalogApps, loadAppModule } from '../support/catalog.mjs';
import { openSuiteManager } from '../support/navigation.mjs';
import { closeAppDetails, isInstalled, listPackages, openAppDetails, openAppsScreen, packageById } from '../support/packages.mjs';
import {
  announceArrangedCapture,
  apiPathPredicate,
  changelogReleases,
  nextPackageVersion,
  readRepoChangelog,
  stubPackagesUpdateAvailable,
  stubStableTrackStatus,
  stubUpdateComparison,
  withStubbedApi,
} from '../support/screenshot-stubs.mjs';
import { captureElementShot, capturePageShot } from '../support/screenshots.mjs';

const OVERRIDES = {
  'app-connect': 'MOS_E2E_SCREENSHOT_APP',
  'app-detail-install': 'MOS_E2E_SCREENSHOT_APP',
  'app-update-review': 'MOS_E2E_SCREENSHOT_UPDATE_APP',
  'privacy-posture': 'MOS_E2E_SCREENSHOT_APP',
};

// The app a site screenshot is taken of. Apps volunteer in their own module
// (`showcase: { 'app-setup-guide': 1 }`, lowest rank first), so this file never
// names one; an environment override wins.
export async function showcaseApp(shot, candidateIds = catalogApps().map((item) => item.id)) {
  const override = process.env[OVERRIDES[shot]];
  if (override) return candidateIds.includes(override) ? override : null;
  const ranked = [];
  for (const id of candidateIds) {
    const rank = (await loadAppModule(id))?.showcase?.[shot];
    if (rank) ranked.push({ id, rank });
  }
  ranked.sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
  return ranked[0]?.id || null;
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function captureCatalogAndDetail(page, home, installedIds) {
  try {
    await openAppsScreen(page, home);
    await capturePageShot(page, 'app-catalog', { fullPage: true });
  } catch (error) {
    console.warn(`[screenshots] app catalog capture skipped: ${error.message}`);
  }

  try {
    const id = await showcaseApp('privacy-posture', installedIds);
    if (!id) return;
    const showcase = await packageById(page, id);
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
    if (await visible(connections)) await captureElementShot(connections, 'app-connect');
    await closeAppDetails(details);
  } catch (error) {
    console.warn(`[screenshots] posture/connect capture skipped: ${error.message}`);
  }

  try {
    const id = await showcaseApp('app-setup-guide', installedIds);
    if (!id) return;
    const guideApp = await packageById(page, id);
    const details = await openAppDetails(page, guideApp);
    const guideButton = details.getByRole('button', { name: /^(Setup guide|Continue guide)$/iu }).first();
    if (await visible(guideButton)) {
      await guideButton.click();
      await expect(page.getByLabel(`${guideApp.name} setup guide`)).toBeVisible({ timeout: 15000 });
      await capturePageShot(page, 'app-setup-guide');
      await page.getByLabel('Close setup guide').click();
    }
    await closeAppDetails(details);
  } catch (error) {
    console.warn(`[screenshots] setup guide capture skipped: ${error.message}`);
  }
}

async function captureUpdateReviewDialog(page, home, app, beforeShot) {
  await openAppsScreen(page, home);
  const details = await openAppDetails(page, app);
  const review = details.getByRole('button', { name: /^Review update$/iu }).first();
  if (!(await visible(review))) throw new Error(`${app.id} detail view offers no Review update action.`);
  await review.click();
  const dialog = page.getByRole('dialog', { name: `Review ${app.name} update` });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await beforeShot?.();
  await capturePageShot(page, 'app-update-review');
  await dialog.getByRole('button', { name: /^(Cancel|Close)$/u }).click();
  await expect(dialog).toBeHidden({ timeout: 15000 });
  await closeAppDetails(details);
}

// The lab's apps are rarely behind the catalog, so without a real pending update a
// volunteer's own candidate is dated one release forward (support/screenshot-stubs.mjs).
async function captureUpdateReview(page, home, packages, installedIds) {
  let arranged = false;
  try {
    const real = packages.find((item) => item.instance && item.catalogUpdate?.status === 'update-available' && item.catalogUpdate.available?.compatibility === 'compatible');
    if (real) {
      await captureUpdateReviewDialog(page, home, real);
      return;
    }
    const withCandidate = installedIds.filter((id) => {
      const item = packages.find((entry) => entry.id === id);
      return item?.catalogUpdate?.available && item.catalogUpdate.installed?.packageVersion;
    });
    const id = await showcaseApp('app-update-review', withCandidate);
    if (!id) {
      console.log('[screenshots] no installed app carries a catalog candidate; app-update-review.png not refreshed');
      return;
    }
    const installed = packages.find((item) => item.id === id);
    const from = installed.catalogUpdate.installed.packageVersion;
    const availableVersion = nextPackageVersion(from);
    arranged = true;
    await withStubbedApi(page, {
      label: 'app-update-review',
      routes: [
        {
          endpoint: 'apps/packages',
          predicate: apiPathPredicate('/suite-manager/api/apps/packages'),
          transform: (body) => stubPackagesUpdateAvailable(body, { availableVersion, packageId: installed.id }),
        },
        {
          endpoint: 'apps/packages/:id/prepare-update',
          predicate: apiPathPredicate(`/suite-manager/api/apps/packages/${encodeURIComponent(installed.id)}/prepare-update`),
          transform: (body) => stubUpdateComparison(body, { availableVersion }),
        },
      ],
    }, async (stub) => {
      await captureUpdateReviewDialog(page, home, installed, () => stub.assertArranged());
      announceArrangedCapture('app-update-review', `${installed.name} dated forward from ${from} to ${availableVersion}`);
    });
  } catch (error) {
    console.warn(`[screenshots] update review capture skipped: ${error.message}`);
  } finally {
    // A capture that failed part-way leaves a dialog open over the arranged
    // catalog, so the screen is reloaded against the real responses.
    if (arranged) await openAppsScreen(page, home).catch(() => undefined);
  }
}

async function currentUpdateStatus(page) {
  return page.evaluate(async () => {
    const response = await fetch('/suite-manager/api/updates/status', { credentials: 'same-origin' });
    return response.ok ? response.json() : null;
  });
}

// The lab follows a branch, a state no owner's machine is in, so a stable track is
// arranged from CHANGELOG.md: the newest release is the target, the one before installed.
async function capturePlatformUpdate(page, home) {
  let arranged = false;
  try {
    const changelog = readRepoChangelog();
    const releases = changelogReleases(changelog);
    await openSuiteManager(page, 'Updates', home);
    if (releases.length < 2) throw new Error(`CHANGELOG.md has ${releases.length} released section(s); a stable-track capture needs a release and the one before it.`);
    const live = await currentUpdateStatus(page);
    if (live?.track?.type === 'stable' && live.updateAvailable) {
      await capturePageShot(page, 'platform-update', { fullPage: true });
      return;
    }
    arranged = true;
    await withStubbedApi(page, {
      label: 'platform-update',
      routes: [{
        endpoint: 'updates/status',
        predicate: apiPathPredicate('/suite-manager/api/updates/status'),
        transform: (body) => stubStableTrackStatus(body, { changelog }),
      }],
    }, async (stub) => {
      await openSuiteManager(page, 'Updates', home);
      const facts = page.locator('.suite-updates-facts dd');
      await expect(facts.first()).toBeVisible({ timeout: 30000 });
      stub.assertArranged();
      // The capture refusing to publish a half-rendered screen, not product assertions.
      await expect(facts.nth(0)).toHaveText('Stable releases');
      await expect(facts.nth(1)).toHaveText(releases[1].version);
      await expect(facts.nth(2)).toHaveText(releases[0].version);
      await expect(page.getByRole('heading', { name: `MOS ${releases[0].version} is available` })).toBeVisible();
      await expect(page.getByText(`[${releases[0].version}]`, { exact: true })).toBeVisible();
      await capturePageShot(page, 'platform-update', { fullPage: true });
      announceArrangedCapture('platform-update', `the stable track sitting on ${releases[1].version} with ${releases[0].version} waiting, release notes read from the real CHANGELOG.md`);
    });
  } catch (error) {
    console.warn(`[screenshots] platform update capture skipped: ${error.message}`);
  } finally {
    if (arranged) await openSuiteManager(page, 'Updates', home).catch(() => undefined);
  }
}

// Best effort by design: a missed site screenshot warns and the run goes on.
export async function marketing(ctx) {
  const { page } = ctx;
  const home = ctx.url('/');
  await page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const packages = await listPackages(page);
  const installedIds = packages.filter(isInstalled).map((item) => item.id);
  await captureCatalogAndDetail(page, home, installedIds);
  await captureUpdateReview(page, home, packages, installedIds);
  await capturePlatformUpdate(page, home);
}
