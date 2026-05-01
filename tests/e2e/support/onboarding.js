import { expect } from '@playwright/test';

import { readStackState } from './stack.js';

const owner = readStackState();

export const vaultwardenMasterPassword = 'MOS-E2E-Master-Password-2026!';
const pauseAfterOnboarding = process.env.MOS_E2E_PAUSE_AFTER_ONBOARDING === '1';

export async function completeOnboarding(context, page) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://suite-manager.localhost:18080',
  });

  await page.goto('/setup/');
  let surface = await waitForSuiteManagerSurface(page);

  if (surface === 'login') {
    await page.getByLabel('Email').fill(owner.ownerEmail);
    await page.getByLabel('Password').fill(owner.ownerPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    surface = await waitForSignedInSuiteManagerSurface(page);
  }

  if (surface === 'homepage') {
    return {
      owner,
      vaultwardenMasterPassword,
      vaultwardenPage: null,
    };
  }

  let stepState = await readStepState(page);
  if (stepState.suiteReady || (await isOnboardingAlreadySatisfied(page, stepState))) {
    await page.goto('/');
    await expectHomepage(page);
    return {
      owner,
      vaultwardenMasterPassword,
      vaultwardenPage: null,
    };
  }

  await expect(page.getByRole('heading', { name: 'Finish setup' })).toBeVisible();

  let vaultwardenPage = null;

  if (!stepState.vaultwardenActivated) {
    stepState = await waitForActivationStepOrSuiteReady(page, 30000);
  }

  if (!stepState.vaultwardenActivated && !stepState.suiteReady) {
    await page.getByRole('button', { name: /Activate Vaultwarden/i }).click();
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
        vaultwardenActivated: true,
      },
      30000,
    );
  }

  if (!stepState.credentialsImported) {
    const importStep = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'Import your suite credentials' }) });
    const importStepHeader = importStep.getByRole('button', { name: /Import your suite credentials/i });

    await expect(importStep.getByRole('heading', { name: 'Import your suite credentials' })).toBeVisible();
    await expect(importStepHeader).toBeEnabled({ timeout: 30000 });
    const importStepClassName = (await importStep.getAttribute('class')) || '';
    if (/\bis-collapsed\b/.test(importStepClassName)) {
      await importStepHeader.click();
    }
    await expect(importStep).toContainText('Copy your suite credentials');

    await importStep.getByRole('button', { name: 'Copy' }).click();
    let csvImport = '';
    await expect
      .poll(async () => {
        csvImport = await page.evaluate(() => navigator.clipboard.readText());
        return csvImport;
      }, {
        timeout: 5000,
      })
      .toContain('"My Own Suite | Suite Manager"');
    expect(csvImport).toContain(owner.ownerEmail);
    expect(csvImport).toContain(owner.ownerPassword);

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
    await expect
      .poll(
        async () => {
          return isVisible(page.getByRole('button', { name: 'Go to Homepage' }));
        },
        {
          timeout: 30000,
        },
      )
      .toBe(true);
    stepState = await readStepState(page);
  }

  await expect(page.getByRole('button', { name: 'Go to Homepage' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to Homepage' }).click();

  await expectHomepage(page);

  if (pauseAfterOnboarding) {
    await page.pause();
  }

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

async function waitForSuiteManagerSurface(page) {
  let surface = 'loading';

  await expect
    .poll(
      async () => {
        surface = await detectSuiteManagerSurface(page);
        return surface;
      },
      {
        timeout: 30000,
      },
    )
    .not.toBe('loading');

  return surface;
}

async function waitForSignedInSuiteManagerSurface(page) {
  let surface = 'loading';

  await expect
    .poll(
      async () => {
        surface = await detectSuiteManagerSurface(page);
        return surface;
      },
      {
        timeout: 30000,
      },
    )
    .toMatch(/homepage|onboarding/);

  return surface;
}

async function detectSuiteManagerSurface(page) {
  if (await isHomepageVisible(page)) {
    return 'homepage';
  }

  if (await isVisible(page.getByRole('heading', { name: 'Finish setup' }))) {
    return 'onboarding';
  }

  if (await isVisible(page.getByLabel('Email'))) {
    return 'login';
  }

  return 'loading';
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
  const homepageButton = page.getByRole('button', { name: 'Go to Homepage' });
  const vaultwardenStep = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Activate Vaultwarden' }) });
  const importStep = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Import your suite credentials' }) });
  const calendarStep = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Calendar' }) });
  const filesStep = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Files & Office' }) });
  const photosStep = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Photos' }) });
  const suiteReady = await isVisible(homepageButton);
  const vaultwardenText = await readLocatorText(vaultwardenStep);
  const importText = await readLocatorText(importStep);
  const calendarText = await readLocatorText(calendarStep);
  const filesText = await readLocatorText(filesStep);
  const photosText = await readLocatorText(photosStep);

  return {
    applicationsReady:
      /ready/i.test(calendarText) &&
      /ready/i.test(filesText) &&
      /ready/i.test(photosText),
    credentialsImported: suiteReady || /completed/i.test(importText),
    credentialsReady: suiteReady || /ready/i.test(importText),
    suiteReady,
    vaultwardenActivated: suiteReady || /ready/i.test(importText) || /completed/i.test(vaultwardenText),
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

async function waitForActivationStepOrSuiteReady(page, timeout) {
  await expect
    .poll(
      async () => {
        const nextState = await readStepState(page);
        const activateButtonVisible = await isVisible(page.getByRole('button', { name: /Activate Vaultwarden/i }));

        return nextState.suiteReady || nextState.vaultwardenActivated || activateButtonVisible;
      },
      {
        timeout,
      },
    )
    .toBe(true);

  return readStepState(page);
}

async function readLocatorText(locator) {
  if ((await locator.count()) === 0) {
    return '';
  }

  return locator.innerText().catch(() => '');
}

async function isOnboardingAlreadySatisfied(page, stepState) {
  if (stepState.suiteReady) {
    return true;
  }

  if (await isVisible(page.getByRole('button', { name: 'Go to Homepage' }))) {
    return true;
  }

  const readyBanner = page.getByText('Your suite is ready to use now.', { exact: false });
  if (await isVisible(readyBanner)) {
    return true;
  }

  return false;
}
