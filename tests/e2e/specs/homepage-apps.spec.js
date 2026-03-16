import { expect, test } from '@playwright/test';

import { completeOnboarding } from '../support/onboarding.js';
import { readStackState } from '../support/stack.js';

const stackState = readStackState();

test.describe('homepage app verification against the real local stack', () => {
  test('opens core apps from Homepage and verifies their live surfaces', async ({ browser, context, page }) => {
    const { owner } = await completeOnboarding(context, page);

    await test.step('verify Suite Manager link from Homepage returns to onboarding', async () => {
      const suiteManagerPagePromise = context.waitForEvent('page');
      await page.getByRole('link', { name: /Suite Manager Open the suite control plane and onboarding/i }).click();
      const suiteManagerPage = await suiteManagerPagePromise;
      await suiteManagerPage.waitForLoadState('domcontentloaded');
      await expect(suiteManagerPage).toHaveURL(/suite-manager\.localhost:18080\/setup\/?$/i);
      await expect(suiteManagerPage.getByRole('heading', { name: 'Finish setup' })).toBeVisible();
      await suiteManagerPage.close();
      await page.bringToFront();
    });

    await test.step('verify Vaultwarden opens from Homepage', async () => {
      const vaultwardenPagePromise = context.waitForEvent('page');
      await page.getByRole('link', { name: /Vaultwarden Self-hosted password manager/i }).click();
      const vaultwardenPage = await vaultwardenPagePromise;
      await vaultwardenPage.waitForLoadState('domcontentloaded');
      await expect(vaultwardenPage).toHaveURL(/vaultwarden\.localhost:18443/i);
      await expect(vaultwardenPage).toHaveTitle(/Vaultwarden Web/i);
      await expect(vaultwardenPage.locator('body')).toContainText(
        /Bokse|Vaults|Send|V.rkt. jer|Tools|Log ind|Log in|E-mailadresse|Email/i,
      );
      await vaultwardenPage.close();
      await page.bringToFront();
    });

    await test.step('log into Seafile from Homepage', async () => {
      const seafilePagePromise = context.waitForEvent('page');
      await page.getByRole('link', { name: /Seafile Self-hosted file sync and share/i }).click();
      const seafilePage = await seafilePagePromise;
      await seafilePage.waitForLoadState('domcontentloaded');
      await expect(seafilePage).toHaveURL(/seafile\.localhost:18080/i);
      await seafilePage.locator('input[name="login"]').fill(stackState.seafileAdminEmail);
      await seafilePage.locator('input[name="password"]').fill(stackState.seafileAdminPassword);
      await seafilePage.getByRole('button', { name: /log in|sign in/i }).click();
      await expect(seafilePage).toHaveURL(/seafile\.localhost:18080\/?$/i);
      await expect(seafilePage.locator('body')).toContainText(/My Libraries|Welcome to Seafile/i);
      await seafilePage.close();
      await page.bringToFront();
    });

    await test.step('verify Stirling PDF login surface loads from Homepage', async () => {
      const stirlingPagePromise = context.waitForEvent('page');
      await page.getByRole('link', { name: /Stirling PDF Self-hosted PDF tools suite/i }).click();
      const stirlingPage = await stirlingPagePromise;
      await stirlingPage.waitForLoadState('domcontentloaded');
      await expect(stirlingPage).toHaveURL(/stirling-pdf\.localhost:18080/i);
      await expect(stirlingPage.locator('body')).toContainText(/Login|Default Login Credentials|Please change your password/i);
      await stirlingPage.close();
      await page.bringToFront();
    });

    await test.step('verify Immich sign-in surface loads from Homepage', async () => {
      const immichPagePromise = context.waitForEvent('page');
      await page.getByRole('link', { name: /Immich Self-hosted photo and video backup/i }).click();
      const immichPage = await immichPagePromise;
      await immichPage.waitForLoadState('domcontentloaded');
      await expect(immichPage).toHaveURL(/immich\.localhost:18080/i);
      await expect(immichPage.locator('body')).toContainText(/Immich|Email|Password|Sign in/i);
      await immichPage.close();
      await page.bringToFront();
    });

    await test.step('verify Radicale is reachable with real credentials', async () => {
      const radicaleUrl = await page
        .getByRole('link', { name: /Radicale Self-hosted calendar sync server/i })
        .getAttribute('href');
      const radicaleContext = await browser.newContext({
        httpCredentials: {
          username: stackState.radicaleAdminUsername,
          password: stackState.radicaleAdminPassword,
        },
      });
      const radicalePage = await radicaleContext.newPage();
      await radicalePage.goto(radicaleUrl, { waitUntil: 'domcontentloaded' });
      await expect(radicalePage).toHaveURL(/radicale\.localhost:18080/i);
      await expect(radicalePage.locator('body')).toContainText(/Radicale|Directory listings are not supported|Calendar/i);
      await radicaleContext.close();
    });
  });
});
