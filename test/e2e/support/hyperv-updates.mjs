import { expect } from '@playwright/test';

import { openSuiteManager } from './hyperv-navigation.mjs';
import {
  announceArrangedCapture,
  apiPathPredicate,
  changelogReleases,
  readRepoChangelog,
  stubStableTrackStatus,
  withStubbedApi,
} from './screenshot-stubs.mjs';
import { capturePageShot } from './screenshots.mjs';

async function currentUpdateStatus(page) {
  return page.evaluate(async () => {
    const response = await fetch('/suite-manager/api/updates/status', { credentials: 'same-origin' });
    return response.ok ? response.json() : null;
  });
}

// The platform Updates screen, photographed as a stable-track install with a
// release waiting.
//
// The lab VM follows the `staging` branch, so its real Updates screen reads
// "Staging branch" and a twelve-character commit hash — a state no owner's
// machine is in and one the public site should not be showing. The stable shape
// is arranged from the repository's own CHANGELOG.md: the newest released
// section becomes the target, the one before it becomes what is installed, and
// its bullets become the release notes, which is what the update agent would
// itself report on a stable machine one release behind.
//
// A lab that genuinely has a stable-track update pending is photographed as-is.
export async function capturePlatformUpdateScreenshot(page, entryUrl = '/') {
  let arranged = false;
  try {
    const changelog = readRepoChangelog();
    const releases = changelogReleases(changelog);
    await openSuiteManager(page, 'Updates', entryUrl);

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
      await openSuiteManager(page, 'Updates', entryUrl);
      const facts = page.locator('.suite-updates-facts dd');
      await expect(facts.first()).toBeVisible({ timeout: 30000 });
      stub.assertArranged();
      // Not product assertions — these are the capture refusing to publish a
      // half-rendered screen. The values they check are the arranged ones.
      await expect(facts.nth(0)).toHaveText('Stable releases');
      await expect(facts.nth(1)).toHaveText(releases[1].version);
      await expect(facts.nth(2)).toHaveText(releases[0].version);
      await expect(page.getByRole('heading', { name: `Changes in ${releases[0].version}` })).toBeVisible();
      await capturePageShot(page, 'platform-update', { fullPage: true });
      announceArrangedCapture('platform-update', `the stable track sitting on ${releases[1].version} with ${releases[0].version} waiting, release notes read from the real CHANGELOG.md`);
    });
  } catch (error) {
    console.warn(`[screenshots] platform update capture skipped: ${error.message}`);
  } finally {
    // Leaves the screen reading the machine's real track before the run
    // continues, so nothing downstream can assert against arranged state.
    if (arranged) await openSuiteManager(page, 'Updates', entryUrl).catch(() => undefined);
  }
}
