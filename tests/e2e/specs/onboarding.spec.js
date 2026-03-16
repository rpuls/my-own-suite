import { expect, test } from '@playwright/test';

import { readStackState } from '../support/stack.js';

const owner = readStackState();
const vaultwardenMasterPassword = 'MOS-E2E-Master-Password-2026!';

test.describe('suite-manager onboarding against the real local stack', () => {
  test('signs in, creates the Vaultwarden owner account, imports credentials, and reaches Homepage', async ({
    context,
    page,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://suite-manager.localhost:18080',
    });

    await page.goto('/setup/');

    await page.getByLabel('Email').fill(owner.ownerEmail);
    await page.getByLabel('Password').fill(owner.ownerPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: 'Finish setup' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Step 1: Activate Vaultwarden' })).toBeVisible();

    const vaultwardenPagePromise = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Go to Vaultwarden signup' }).click();
    const vaultwardenPage = await vaultwardenPagePromise;

    await vaultwardenPage.waitForLoadState('domcontentloaded');
    await expect(vaultwardenPage).toHaveURL(/vaultwarden\.localhost:18443/i);

    await vaultwardenPage.getByRole('textbox').nth(0).fill(owner.ownerEmail);
    await vaultwardenPage.getByRole('button').nth(0).click();
    await vaultwardenPage.locator('input[type="password"]').nth(0).fill(vaultwardenMasterPassword);
    await vaultwardenPage.locator('input[type="password"]').nth(1).fill(vaultwardenMasterPassword);
    await vaultwardenPage.getByRole('button', { name: /create account|opret konto/i }).click();
    await expect(vaultwardenPage).toHaveURL(/setup-extension/i);

    await page.bringToFront();
    await expect
      .poll(
        async () => {
          await page.reload();
          const stepOne = page
            .locator('article')
            .filter({ has: page.getByRole('heading', { name: 'Step 1: Activate Vaultwarden' }) });
          const stepTwo = page
            .locator('article')
            .filter({ has: page.getByRole('heading', { name: 'Step 2: Securely Import Your Suite Credentials' }) });
          const stepOneText = await stepOne.innerText();
          const stepTwoText = await stepTwo.innerText();

          return {
            isStepOneCompleted: /completed/i.test(stepOneText),
            isStepTwoCurrent: /current/i.test(stepTwoText),
          };
        },
        {
          timeout: 30000,
        },
      )
      .toMatchObject({
        isStepOneCompleted: true,
        isStepTwoCurrent: true,
      });

    const importStep = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'Step 2: Securely Import Your Suite Credentials' }) });

    await expect(importStep.getByRole('heading', { name: 'Step 2: Securely Import Your Suite Credentials' })).toBeVisible();
    await expect(importStep).toContainText('Copy your credentials');

    await importStep.getByRole('button', { name: 'Copy' }).click();
    const csvImport = await page.evaluate(() => navigator.clipboard.readText());

    const importUrl = await importStep.getByRole('link', { name: 'Go to import page' }).getAttribute('href');
    await vaultwardenPage.goto(importUrl);
    await vaultwardenPage.waitForLoadState('domcontentloaded');
    await vaultwardenPage.getByRole('combobox').nth(2).click();
    await vaultwardenPage.locator('.ng-option').getByText('Bitwarden (csv)', { exact: true }).click();
    await vaultwardenPage.locator('textarea').first().fill(csvImport);
    await vaultwardenPage.getByRole('button', { name: /import/i }).click();

    await page.bringToFront();

    await importStep.getByRole('button', { name: 'I have imported my credentials' }).click();
    const calendarStep = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'Step 3: Connect your calendar' }) });

    await expect
      .poll(
        async () => {
          await page.reload();
          return /current/i.test(await calendarStep.innerText());
        },
        {
          timeout: 30000,
        },
      )
      .toBe(true);

    await calendarStep.getByRole('button', { name: 'Windows' }).click();
    await calendarStep.getByRole('button', { name: 'My calendar is connected' }).click();

    await expect(page.getByRole('button', { name: 'Go to Homepage' })).toBeVisible();
    await page.getByRole('button', { name: 'Go to Homepage' }).click();

    await expect(page).toHaveURL('http://suite-manager.localhost:18080/');
    await expect(page.locator('body')).toContainText('My Own Suite');
    await expect(page.getByRole('link', { name: /Suite Manager/i })).toBeVisible();
  });
});
