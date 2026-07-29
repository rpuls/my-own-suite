import { expect } from '@playwright/test';

import { apiJson, apiPathFor, expectSignedInApi } from './hyperv-api.mjs';
import { acceptTermsIfPending, settleAfterSignIn } from './terms.mjs';

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
    // A brand-new owner always meets the terms gate: nothing has accepted them
    // yet, and sign-in deliberately holds there instead of redirecting past it.
    await settleAfterSignIn(page);
    expect(await acceptTermsIfPending(page)).toBe(true);
    await expectHomeDashboard(page);
    await expectSignedInApi(page, entryUrl);
    return;
  }

  if (status.status === 'signed-out') {
    await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
    await page.getByLabel(/email/i).fill(env.owner.email);
    await page.getByLabel(/^Password/i).fill(env.owner.password);
    await page.getByRole('button', { name: /Sign in/i }).click();
    // Signing back in only meets the gate on a lab whose owner never accepted,
    // or after a terms-version bump, so this one is conditional.
    await settleAfterSignIn(page);
    await acceptTermsIfPending(page);
    await expectHomeDashboard(page);
    await expectSignedInApi(page, entryUrl);
    return;
  }

  // Already signed in — a lab whose owner predates the terms, or one carried
  // across a terms-version bump, still owes an acceptance. Decided from the
  // status payload rather than the DOM so it never races the first render.
  if (status.terms?.version && !status.terms.accepted) {
    await expect(page.getByRole('heading', { name: /Before you start/iu })).toBeVisible({ timeout: 30000 });
    await acceptTermsIfPending(page);
  }
  await gotoHomeDashboard(page, entryUrl);
  await expectSignedInApi(page, entryUrl);
}
