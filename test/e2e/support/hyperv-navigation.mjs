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

export async function openSuiteManager(page, screenName, entryUrl = '/') {
  await page.goto(suiteManagerUrl(entryUrl));
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Suite Manager menu' })).toBeVisible();
  await page.getByRole('button', { name: screenName }).click();
  const headingName = screenName === 'Backup' ? 'Backup & Restore' : screenName;
  try {
    await expect(page.getByRole('heading', { exact: true, level: 1, name: headingName })).toBeVisible();
  } catch (error) {
    throw new Error(`${error.message}\n${await diagnosticSnapshot(page, `Suite Manager navigation to ${screenName} failed`)}`);
  }
}
