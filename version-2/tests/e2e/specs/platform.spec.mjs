import { expect, test } from '@playwright/test';

const owner = { email: 'owner@example.com', name: 'MOS Owner', password: 'correct horse battery' };

test('owner onboarding, navigation, Settings validation, and logout use the real control plane', async ({ page }) => {
  await page.goto('/suite-manager/');
  await expect(page.getByRole('heading', { name: /Create your owner account/i })).toBeVisible();
  await page.getByLabel(/name/i).fill(owner.name);
  await page.getByLabel(/email/i).fill(owner.email);
  await page.getByLabel(/^Password/i).fill(owner.password);
  await page.getByRole('button', { name: /Create owner/i }).click();

  await expect(page).toHaveURL(/\/$/u);
  await expect(page.locator('body')).toContainText('My Own Suite');
  await page.goto('/suite-manager/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Suite Manager menu' })).toBeVisible();
  await page.getByRole('button', { name: /Settings/i }).click();
  await expect(page).toHaveURL(/\/suite-manager\/settings$/u);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByRole('button', { name: 'Apply HTTPS settings' }).click();
  await expect(page.getByText('Enter a valid Cloudflare-managed base domain.')).toBeVisible();
  await page.getByLabel('MOS base domain').fill('mos.example.com');
  await page.getByLabel('ACME contact email').fill('owner@example.com');
  await page.getByLabel('Cloudflare API token').fill('token_value_1234567890');
  await page.getByRole('button', { name: 'Apply HTTPS settings' }).click();
  await expect(page.getByText(/HTTPS system agent is unavailable/i)).toBeVisible();
  await expect(page.getByLabel('Cloudflare API token')).toHaveValue('token_value_1234567890');

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/suite-manager\/$/u);
  await page.goto('/suite-manager/settings');
  await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
});
