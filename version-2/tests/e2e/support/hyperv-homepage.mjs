import { expect } from '@playwright/test';

import { openSuiteManager } from './hyperv-navigation.mjs';

function uniqueSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function homepageBodyText(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  return page.locator('body').innerText().catch(() => '');
}

export async function waitForHomepageAvailable(page) {
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastText = '';

  while (Date.now() < deadline) {
    lastText = await homepageBodyText(page);
    if (!lastText.includes('Homepage is unavailable.')) return;
    await page.waitForTimeout(3000);
  }

  throw new Error(`Homepage did not become available at /. Last response body: ${lastText.slice(0, 300)}`);
}

async function waitForHomepageText(page, text) {
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastText = '';

  while (Date.now() < deadline) {
    lastText = await homepageBodyText(page);
    if (lastText.includes(text)) return;
    await page.waitForTimeout(3000);
  }

  throw new Error(`Homepage did not render "${text}" at /. Last response body: ${lastText.slice(0, 300)}`);
}

export async function customizeHomepage(page) {
  const suffix = uniqueSuffix();
  const linkName = `MOS E2E Link ${suffix}`;
  const serviceName = `MOS E2E Service ${suffix}`;
  const serviceSubdomain = `e2e-service-${suffix}`.replace(/[^a-z0-9-]/gu, '').slice(0, 50);

  await waitForHomepageAvailable(page);
  await openSuiteManager(page, 'Customize');
  await page.getByRole('button', { name: 'Add to Homepage' }).click();
  await page.getByRole('button', { name: /Website/ }).click();
  await page.getByLabel('Name', { exact: true }).fill(linkName);
  await page.getByRole('textbox', { name: /^Description/ }).fill('Added by the Hyper-V regression suite');
  await page.getByRole('textbox', { name: /^Icon/ }).fill('mdi:link');
  await page.getByRole('combobox', { name: 'Placement' }).selectOption('My Own Suite');
  await page.getByLabel('Website address', { exact: true }).fill('https://example.com/');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 30000 });
  await expect(page.getByLabel('Homepage YAML')).toContainText(linkName);

  await page.getByRole('button', { name: 'Add to Homepage' }).click();
  await page.getByRole('button', { name: /Home network app/ }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill(serviceName);
  await page.getByRole('textbox', { name: /^Description/ }).fill('Safe local placeholder service');
  await page.getByRole('textbox', { name: /^Icon/ }).fill('mdi:server-network');
  await page.getByRole('combobox', { name: 'Placement' }).selectOption('My Own Suite');
  await page.getByRole('textbox', { name: /^App address/ }).fill('http://192.168.1.20:8080');
  await page.getByRole('button', { name: 'Edit URL subdomain' }).click();
  await page.getByLabel('URL subdomain').fill(serviceSubdomain);
  await page.getByRole('button', { name: 'Preview route' }).click();
  await expect(page.getByText(new RegExp(`${serviceSubdomain.replace(/[-/\\^$*+?.()|[\]{}]/gu, '\\$&')}\\.`))).toBeVisible();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 30000 });
  await expect(page.getByLabel('Homepage YAML')).toContainText(serviceName);

  await waitForHomepageText(page, linkName);
  await expect(page.getByText(linkName)).toBeVisible({ timeout: 60000 });
  await expect(page.getByText(serviceName)).toBeVisible();

  const linkHref = await page.getByRole('link', { name: new RegExp(linkName) }).first().getAttribute('href');
  expect(linkHref).toBe('https://example.com/');
}
