import { expect } from '@playwright/test';

function suiteManagerUrl(entryUrl = '/') {
  if (!/^https?:\/\//iu.test(entryUrl)) return '/suite-manager/';
  return new URL('/suite-manager/', entryUrl).toString();
}

export async function openSuiteManager(page, screenName, entryUrl = '/') {
  await page.goto(suiteManagerUrl(entryUrl));
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Suite Manager menu' })).toBeVisible();
  await page.getByRole('button', { name: screenName }).click();
  await expect(page.getByRole('heading', { name: screenName === 'Backup' ? 'Backup & Restore' : screenName })).toBeVisible();
}
