import { expect } from '@playwright/test';

function suiteManagerUrl(entryUrl = '/') {
  if (!/^https?:\/\//iu.test(entryUrl)) return '/suite-manager/';
  return new URL('/suite-manager/', entryUrl).toString();
}

async function diagnosticSnapshot(page, label) {
  const headings = await page.getByRole('heading').evaluateAll((items) => items.map((item) => ({
    level: item.tagName,
    text: item.textContent?.trim() || '',
  }))).catch(() => []);
  return `${label}: url=${page.url()} headings=${JSON.stringify(headings)}`;
}

// Just after the control plane restarts, as a lab reset leaves it, the first
// load can be cut off under the browser or overtaken by the page's own redirect;
// one more try, once that has settled, is what a reload is.
async function gotoSettled(page, url) {
  await page.goto(url).catch(async (error) => {
    if (!/ERR_ABORTED|interrupted by another navigation/u.test(error.message)) throw error;
    await page.waitForTimeout(3000);
    await page.goto(url);
  });
}

export async function openSuiteManager(page, screenName, entryUrl = '/') {
  await gotoSettled(page, suiteManagerUrl(entryUrl));
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const menu = page.getByRole('navigation', { name: 'Suite Manager menu' });
  await expect(menu).toBeVisible();
  // Scoped to the menu: role-name matching is substring-based, and screen
  // content behind the menu can echo a screen name (the first-run
  // checklist's "Make your first backup" button also matches "Backup").
  await menu.getByRole('button', { name: screenName }).click();
  const headingName = screenName === 'Backup' ? 'Backup & Restore' : screenName;
  try {
    await expect(page.getByRole('heading', { exact: true, level: 1, name: headingName })).toBeVisible();
  } catch (error) {
    throw new Error(`${error.message}\n${await diagnosticSnapshot(page, `Suite Manager navigation to ${screenName} failed`)}`);
  }
}
