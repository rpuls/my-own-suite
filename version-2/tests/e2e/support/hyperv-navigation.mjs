import { expect } from '@playwright/test';

export async function openSuiteManager(page, screenName) {
  await page.goto('/suite-manager/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Suite Manager menu' })).toBeVisible();
  await page.getByRole('button', { name: screenName }).click();
  await expect(page.getByRole('heading', { name: screenName === 'Backup' ? 'Backup & Restore' : screenName })).toBeVisible();
}
