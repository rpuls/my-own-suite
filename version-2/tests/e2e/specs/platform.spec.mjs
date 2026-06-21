import { expect, test } from '@playwright/test';

const owner = { email: 'owner@example.com', name: 'MOS Owner', password: 'correct horse battery' };

test('owner onboarding, Homepage customization, Settings validation, and logout use the real control plane', async ({ page }) => {
  await page.goto('/suite-manager/');
  await expect(page.getByRole('heading', { name: /Create your MOS owner account/i })).toBeVisible();
  await page.getByLabel(/name/i).fill(owner.name);
  await page.getByLabel(/email/i).fill(owner.email);
  await page.getByLabel(/^Password/i).fill(owner.password);
  await page.getByRole('button', { name: /Create owner/i }).click();

  await expect(page).toHaveURL(/\/$/u);
  await expect(page.locator('body')).toContainText('My Own Suite');
  await page.goto('/suite-manager/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Suite Manager menu' })).toBeVisible();
  await page.getByRole('button', { name: /Customize/i }).click();
  await expect(page).toHaveURL(/\/suite-manager\/customize$/u);
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible();

  await page.getByLabel('Homepage YAML').fill('- broken: [');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Fix the YAML errors before saving.')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reload saved' }).click();

  await page.getByRole('button', { name: 'Add to Homepage' }).click();
  await page.getByRole('button', { name: /Website/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('MOS Test Link');
  await page.getByRole('textbox', { name: /^Description/ }).fill('Added by the V2 browser flow');
  await page.getByRole('textbox', { name: /^Icon/ }).fill('mdi:link');
  await page.getByRole('combobox', { name: 'Placement' }).selectOption('My Own Suite');
  await page.getByLabel('Website address', { exact: true }).fill('https://example.com/');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 30000 });
  await expect(page.getByLabel('Homepage YAML')).toContainText('MOS Test Link');

  await page.getByRole('button', { name: 'Add to Homepage' }).click();
  await page.getByRole('button', { name: /Home network app/ }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill('MOS Test Service');
  await page.getByRole('textbox', { name: /^Description/ }).fill('Existing network service');
  await page.getByRole('textbox', { name: /^Icon/ }).fill('mdi:server-network');
  await page.getByRole('combobox', { name: 'Placement' }).selectOption('My Own Suite');
  await page.getByRole('textbox', { name: /^App address/ }).fill('http://192.168.1.20:8080');
  await page.getByRole('button', { name: 'Edit URL subdomain' }).click();
  await page.getByLabel('URL subdomain').fill('test-service');
  await page.getByRole('button', { name: 'Preview route' }).click();
  await expect(page.getByText('http://test-service.127.0.0.1.sslip.io/')).toBeVisible();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 30000 });
  await expect(page.getByLabel('Homepage YAML')).toContainText('MOS Test Service');

  await page.goto('/');
  await expect(page.getByText('MOS Test Link')).toBeVisible();
  await expect(page.getByText('MOS Test Service')).toBeVisible();
  await page.goto('/suite-manager/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
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
  await page.goto('/suite-manager/customize');
  await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
});
