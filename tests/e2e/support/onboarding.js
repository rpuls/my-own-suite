import { expect } from '@playwright/test';

import { readStackState } from './stack.js';

const owner = readStackState();

export const vaultwardenMasterPassword = 'MOS-E2E-Master-Password-2026!';

export async function completeOnboarding(context, page) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://suite-manager.localhost:18080',
  });

  await page.goto('/setup/');

  if (await page.getByLabel('Email').isVisible()) {
    await page.getByLabel('Email').fill(owner.ownerEmail);
    await page.getByLabel('Password').fill(owner.ownerPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  if (await isHomepageVisible(page)) {
    return {
      owner,
      vaultwardenMasterPassword,
      vaultwardenPage: null,
    };
  }

  await expect(page.getByRole('heading', { name: 'Finish setup' })).toBeVisible();
  let stepState = await readStepState(page);
  if (stepState.stepThreeCompleted || (await isVisible(page.getByRole('button', { name: 'Go to Homepage' })))) {
    await page.goto('/');
    await expectHomepage(page);
    return {
      owner,
      vaultwardenMasterPassword,
      vaultwardenPage: null,
    };
  }

  let vaultwardenPage = null;

  if (!stepState.stepOneCompleted) {
    await page.getByRole('button', { name: /Step 1: Activate Vaultwarden/i }).click();
    const signupUrl = await page.getByRole('link', { name: 'Go to Vaultwarden signup' }).getAttribute('href');
    vaultwardenPage = await context.newPage();
    await vaultwardenPage.goto(signupUrl);

    await vaultwardenPage.waitForLoadState('domcontentloaded');
    await expect(vaultwardenPage).toHaveURL(/vaultwarden\.localhost:18443/i);

    await vaultwardenPage.getByRole('textbox').nth(0).fill(owner.ownerEmail);
    await vaultwardenPage.getByRole('button').nth(0).click();
    await vaultwardenPage.locator('input[type="password"]').nth(0).fill(vaultwardenMasterPassword);
    await vaultwardenPage.locator('input[type="password"]').nth(1).fill(vaultwardenMasterPassword);
    await vaultwardenPage.getByRole('button', { name: /create account|opret konto/i }).click();
    await expect
      .poll(
        async () => ({
          body: await vaultwardenPage.locator('body').innerText(),
          url: vaultwardenPage.url(),
        }),
        {
          timeout: 30000,
        },
      )
      .toMatchObject({
        body: expect.stringMatching(/Din nye konto er oprettet!|Your new account has been created!/i),
        url: expect.stringMatching(/finish-signup|setup-extension/i),
      });
    if (!/setup-extension/i.test(vaultwardenPage.url())) {
      await vaultwardenPage.goto('https://vaultwarden.localhost:18443/#/setup-extension');
    }
    await dismissVaultwardenExtensionPrompt(vaultwardenPage);
    await page.bringToFront();
    stepState = await waitForCurrentStep(
      page,
      {
        stepOneCompleted: true,
        stepTwoCurrent: true,
      },
      30000,
    );
  }

  if (!stepState.stepTwoCompleted) {
    const importStep = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'Step 2: Securely Import Your Suite Credentials' }) });

    await expect(importStep.getByRole('heading', { name: 'Step 2: Securely Import Your Suite Credentials' })).toBeVisible();
    await expect(importStep).toContainText('Copy your credentials');

    await importStep.getByRole('button', { name: 'Copy' }).click();
    const csvImport = await page.evaluate(() => navigator.clipboard.readText());

    if (!vaultwardenPage) {
      vaultwardenPage = await context.newPage();
      await ensureVaultwardenSession(vaultwardenPage);
    }

    const importUrl = await importStep.getByRole('link', { name: 'Go to import page' }).getAttribute('href');
    await vaultwardenPage.goto(importUrl);
    await vaultwardenPage.waitForLoadState('domcontentloaded');
    await dismissVaultwardenExtensionPrompt(vaultwardenPage);
    await expect(vaultwardenPage.getByRole('combobox')).toHaveCount(3, { timeout: 30000 });
    await vaultwardenPage.getByRole('combobox').nth(2).click();
    await vaultwardenPage.locator('.ng-option').getByText('Bitwarden (csv)', { exact: true }).click();
    await vaultwardenPage.locator('textarea').first().fill(csvImport);
    await vaultwardenPage.getByRole('button', { name: /import/i }).click();

    await page.bringToFront();

    await importStep.getByRole('button', { name: 'I have imported my credentials' }).click();
    stepState = await waitForCurrentStep(
      page,
      {
        stepThreeCurrent: true,
      },
      30000,
    );
  }

  if (!stepState.stepThreeCompleted) {
    const calendarStep = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'Step 3: Connect your calendar' }) });

    await calendarStep.getByRole('button', { name: 'Windows' }).click();
    await calendarStep.getByRole('button', { name: 'My calendar is connected' }).click();
  }

  await expect(page.getByRole('button', { name: 'Go to Homepage' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to Homepage' }).click();

  await expectHomepage(page);

  return {
    owner,
    vaultwardenMasterPassword,
    vaultwardenPage,
  };
}

async function expectHomepage(page) {
  await expect(page).toHaveURL('http://suite-manager.localhost:18080/');
  await expect(page.locator('body')).toContainText('My Own Suite');
  await expect(page.getByRole('link', { name: /Suite Manager/i })).toBeVisible();
}

async function isHomepageVisible(page) {
  return page.getByRole('link', { name: /Suite Manager/i }).isVisible().catch(() => false);
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function ensureVaultwardenSession(page) {
  await page.goto('https://vaultwarden.localhost:18443/#/login');
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('textbox').nth(0).fill(owner.ownerEmail);
  await page.getByRole('button', { name: /log ind|log in|continue|forts.t/i }).last().click();
  await page.locator('input[type="password"]').first().fill(vaultwardenMasterPassword);
  await page.getByRole('button', { name: /log ind|log in|continue|forts.t/i }).last().click();
  await dismissVaultwardenExtensionPrompt(page);
  await expect(page).toHaveURL(/vaultwarden\.localhost:18443\/#\/vault/i, { timeout: 30000 });
}

async function dismissVaultwardenExtensionPrompt(page) {
  if (!/setup-extension/i.test(page.url())) {
    return;
  }

  const addItLater = page.getByRole('button', { name: /add it later/i });
  if (await addItLater.isVisible().catch(() => false)) {
    await addItLater.click();
  } else {
    await page.goto('https://vaultwarden.localhost:18443/#/vault');
  }
}

async function readStepState(page) {
  const stepOne = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Step 1: Activate Vaultwarden' }) });
  const stepTwo = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Step 2: Securely Import Your Suite Credentials' }) });
  const stepThree = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Step 3: Connect your calendar' }) });
  const stepOneText = await stepOne.innerText();
  const stepTwoText = await stepTwo.innerText();
  const stepThreeText = await stepThree.innerText();

  return {
    stepOneCompleted: /completed/i.test(stepOneText),
    stepTwoCompleted: /completed/i.test(stepTwoText),
    stepTwoCurrent: /current/i.test(stepTwoText),
    stepThreeCompleted: /completed/i.test(stepThreeText),
    stepThreeCurrent: /current/i.test(stepThreeText),
  };
}

async function waitForCurrentStep(page, expected, timeout) {
  await expect
    .poll(
      async () => {
        await page.reload();
        return readStepState(page);
      },
      {
        timeout,
      },
    )
    .toMatchObject(expected);

  return readStepState(page);
}
