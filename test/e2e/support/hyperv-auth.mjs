import { expect } from '@playwright/test';

import { apiJson, apiPathFor, expectSignedInApi } from './hyperv-api.mjs';

async function expectHomeDashboard(page) {
  await expect(page).toHaveURL((url) => url.pathname === '/', { timeout: 60000 });
  await expect(page.locator('body')).toContainText('My Own Suite');
}

async function gotoHomeDashboard(page, entryUrl) {
  const homeUrl = /^https?:\/\//iu.test(entryUrl) ? new URL('/', entryUrl).toString() : '/';
  await page.goto(homeUrl);
  await expectHomeDashboard(page);
}

export async function ensureOwnerSession(page, env, entryUrl = '/suite-manager/') {
  await page.goto(entryUrl);
  const status = await apiJson(page, apiPathFor(entryUrl, '/suite-manager/api/setup/status'));

  if (status.status === 'needs-owner') {
    await expect(page.getByRole('heading', { name: /Create your owner account/i })).toBeVisible();
    await page.getByLabel(/name/i).fill(env.owner.name);
    await page.getByLabel(/email/i).fill(env.owner.email);
    await page.getByLabel(/^Password/i).fill(env.owner.password);
    await page.getByLabel(/Confirm password/i).fill(env.owner.password);
    await page.getByRole('button', { name: /Create owner/i }).click();
    await expectHomeDashboard(page);
    await expectSignedInApi(page, entryUrl);
    return;
  }

  if (status.status === 'signed-out') {
    await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
    await page.getByLabel(/email/i).fill(env.owner.email);
    await page.getByLabel(/^Password/i).fill(env.owner.password);
    await page.getByRole('button', { name: /Sign in/i }).click();
    await expectHomeDashboard(page);
    await expectSignedInApi(page, entryUrl);
    return;
  }

  await gotoHomeDashboard(page, entryUrl);
  await expectSignedInApi(page, entryUrl);
}
