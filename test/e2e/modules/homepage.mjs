import { expect } from '@playwright/test';

import { waitForHomepageAvailable, waitForHomepageText } from '../support/homepage.mjs';
import { openSuiteManager } from '../support/navigation.mjs';

function uniqueSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function homepage(ctx) {
  const { page } = ctx;
  const home = ctx.url('/');
  const suffix = uniqueSuffix();
  const linkName = `MOS E2E Link ${suffix}`;
  const serviceName = `MOS E2E Service ${suffix}`;
  const serviceSubdomain = `e2e-service-${suffix}`.replace(/[^a-z0-9-]/gu, '').slice(0, 50);

  await waitForHomepageAvailable(page, home);
  await openSuiteManager(page, 'Customize', home);
  await page.getByRole('button', { name: 'Add to Homepage' }).click();
  await page.getByRole('button', { name: /Website/ }).click();
  await page.getByLabel('Name', { exact: true }).fill(linkName);
  await page.getByRole('textbox', { name: /^Description/ }).fill('Added by the MOS E2E suite');
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

  await waitForHomepageText(page, linkName, home);
  await expect(page.getByText(linkName)).toBeVisible({ timeout: 60000 });
  await expect(page.getByText(serviceName)).toBeVisible();
  const linkHref = await page.getByRole('link', { name: new RegExp(linkName) }).first().getAttribute('href');
  expect(linkHref).toBe('https://example.com/');

  ctx.homepageCheckpoint = { linkName, serviceName };
}

export async function homepageCheck(ctx) {
  const checkpoint = ctx.homepageCheckpoint;
  if (!checkpoint) throw new Error('homepage-check needs an earlier `homepage` step in this run.');
  await waitForHomepageText(ctx.page, checkpoint.linkName, ctx.url('/'));
  await expect(ctx.page.getByText(checkpoint.linkName)).toBeVisible({ timeout: 60000 });
  await expect(ctx.page.getByText(checkpoint.serviceName)).toBeVisible();
}
