import { expect, test } from '@playwright/test';

import { acceptTermsIfPending, settleAfterSignIn } from '../support/terms.mjs';

const owner = { email: 'owner@example.com', name: 'MOS Owner', password: 'correct horse battery' };

test('owner onboarding, Homepage customization, Settings validation, and logout use the real control plane', async ({ page }) => {
  await page.goto('/suite-manager/');
  await expect(page.getByRole('heading', { name: /Create your owner account/i })).toBeVisible();
  await page.getByLabel(/name/i).fill(owner.name);
  await page.getByLabel(/email/i).fill(owner.email);
  await page.getByLabel(/^Password/i).fill(owner.password);
  await page.getByLabel(/Confirm password/i).fill(owner.password);
  await page.getByRole('button', { name: /Create owner/i }).click();

  // The terms gate holds a new owner here instead of handing them to their
  // Homepage dashboard, and it holds on every Suite Manager route, not just
  // the one they landed on — an acceptance a URL can walk around is no
  // acceptance at all.
  await settleAfterSignIn(page);
  await expect(page.getByRole('heading', { name: /Before you start/i })).toBeVisible();
  await page.goto('/suite-manager/apps');
  await expect(page.getByRole('heading', { name: /Before you start/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeHidden();
  // Back to the entry route: accepting unlocks Suite Manager and deliberately stays there,
  // because first run is when the dashboard has the server login to show.
  await page.goto('/suite-manager/');
  await expect(page.getByRole('heading', { name: /Before you start/i })).toBeVisible();
  expect(await acceptTermsIfPending(page)).toBe(true);

  await expect(page).toHaveURL(/\/suite-manager\/?$/u);
  await expect(page.getByRole('heading', { name: /install your first app/iu })).toBeVisible();
  // Homepage is reachable now that the gate is answered — it just is not forced.
  await page.goto('/');
  await expect(page.locator('body')).toContainText('My Own Suite');
  await page.goto('/suite-manager/');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Suite Manager menu' })).toBeVisible();
  await page.getByRole('button', { name: /Customize/i }).click();
  await expect(page).toHaveURL(/\/suite-manager\/customize$/u);
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible();

  // Saving is the only button, and it is what validates: a broken file has to
  // be refused by the same click that would have written it, not by a separate
  // Validate step the owner could skip.
  await expect(page.getByText('Raw YAML, for now')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Validate' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload saved' })).toHaveCount(0);
  await page.getByLabel('Homepage YAML').fill('- broken: [');
  await page.getByRole('button', { name: 'Save and apply' }).click();
  await expect(page.getByText('Fix the YAML errors before saving.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Homepage YAML')).not.toContainText('broken');

  await page.getByRole('button', { name: 'Add to Homepage' }).click();
  await page.getByRole('button', { name: /Website/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('MOS Test Link');
  await page.getByRole('textbox', { name: /^Description/ }).fill('Added by the MOS browser flow');
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
