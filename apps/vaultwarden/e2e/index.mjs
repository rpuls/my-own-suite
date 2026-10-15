// Vaultwarden's own end-to-end journey for the MOS E2E suite (test/e2e). Not
// package content: a package's e2e/ folder never ships and never changes its digest.
import { expect } from '@playwright/test';

function masterPassword(env) {
  const value = env.read('MOS_E2E_VAULTWARDEN_PASSWORD', 'MOS-E2E-Master-Password-2026!');
  if (value.length >= 12 && /[a-z]/u.test(value) && /[A-Z]/u.test(value) && /\d/u.test(value) && /[^A-Za-z0-9]/u.test(value)) return value;
  throw new Error('MOS_E2E_VAULTWARDEN_PASSWORD needs 12 characters with lower and upper case, a digit and a symbol.');
}

// A fresh address every run: an account that already exists, from a run on a
// lab that was not reset, must not be mistaken for the one this run makes.
function accountEmail(env) {
  const base = env.read('MOS_E2E_VAULTWARDEN_EMAIL', env.owner.email);
  const at = base.lastIndexOf('@');
  return `${base.slice(0, at)}+e2e-${Date.now().toString(36)}${base.slice(at)}`;
}

const accountName = (env) => env.read('MOS_E2E_VAULTWARDEN_NAME', env.owner.name);

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

// The web vault suggests its browser extension after the first sign-in.
async function skipExtensionPrompt(page) {
  if (!/#\/setup-extension/iu.test(page.url())) return;
  await page.getByRole('button', { name: /add it later/iu }).click({ timeout: 10000 }).catch(() => undefined);
  await page.getByText(/skip to web app/iu).click({ force: true, timeout: 10000 }).catch(() => undefined);
  if (/#\/setup-extension/iu.test(page.url())) await page.goto(`${new URL(page.url()).origin}/#/vault`);
}

async function signIn(page, env, email) {
  await expect(page.locator('body')).toContainText(/Vaultwarden|Bitwarden|Log in|Welcome back|Vault/iu, { timeout: 90000 });
  const password = page.getByRole('textbox', { name: /^Master password/iu });
  if (/#\/vault/iu.test(page.url()) && !(await visible(password))) return;
  if (!(await visible(password))) {
    await page.getByRole('textbox', { name: /^Email address/iu }).fill(email);
    await page.getByRole('button', { exact: true, name: 'Continue' }).click();
  }
  await password.fill(masterPassword(env));
  await page.getByRole('button', { name: /^(Log in|Unlock)/iu }).first().click();
  await expect(async () => {
    if (await visible(page.getByText(/Invalid master password/iu))) throw new Error('Vaultwarden rejected the E2E master password for this account.');
    expect(page.url()).toMatch(/#\/(?:vault|setup-extension)/iu);
  }).toPass({ intervals: [1000], timeout: 120000 });
  await skipExtensionPrompt(page);
  await expect(page).toHaveURL(/#\/vault/iu, { timeout: 60000 });
  await skipTour(page);
}

// Email and name first, then the master password on a page of its own. The
// breach check is unticked: it would send part of the password's hash to a
// third party from a test run.
async function createAccount(page, env) {
  const email = accountEmail(env);
  await page.goto(`${new URL(page.url()).origin}/#/signup`);
  await page.getByRole('textbox', { name: /^Email address/iu }).fill(email);
  await page.getByRole('textbox', { exact: true, name: 'Name' }).fill(accountName(env));
  await page.getByRole('button', { exact: true, name: 'Continue' }).click();
  await expect(page).toHaveURL(/#\/finish-signup/iu, { timeout: 30000 });
  await page.getByRole('textbox', { name: /^Master password \*/iu }).fill(masterPassword(env));
  await page.getByRole('textbox', { name: /^Confirm master password/iu }).fill(masterPassword(env));
  await page.getByRole('checkbox', { name: /Check known data breaches/iu }).uncheck();
  await page.getByRole('button', { exact: true, name: 'Create account' }).click();
  await expect(page).toHaveURL(/#\/(?:login|vault|setup-extension)/iu, { timeout: 120000 });
  // Depending on the web vault release, a new account is signed in already or sent to Log in.
  if (/#\/login/iu.test(page.url())) await signIn(page, env, email);
  await skipExtensionPrompt(page);
  await expect(page).toHaveURL(/#\/vault/iu, { timeout: 60000 });
  await skipTour(page);
  return email;
}

// A first visit to the vault, on a new account or a new device, opens a welcome tour over it.
async function skipTour(page) {
  const tour = page.getByRole('dialog').filter({ hasText: /Welcome to Bitwarden/iu });
  if (await tour.waitFor({ timeout: 8000 }).then(() => true, () => false)) await tour.getByRole('button', { exact: true, name: 'Skip' }).click();
}

async function createLoginItem(page, item) {
  await page.getByRole('button', { name: /^New/iu }).first().click();
  await page.getByRole('menuitem', { name: /^Login$/iu }).or(page.getByRole('button', { name: /^Login$/iu })).first().click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await dialog.getByRole('textbox', { name: /^Item name/iu }).fill(item.name);
  await dialog.getByRole('textbox', { name: /^Username/iu }).fill(item.username);
  await dialog.getByRole('textbox', { name: /^Password/iu }).first().fill(item.password);
  await dialog.getByRole('button', { exact: true, name: 'Save' }).click();
  await expect(page.getByText(item.name).first()).toBeVisible({ timeout: 30000 });
  await page.keyboard.press('Escape').catch(() => undefined);
}

export default {
  showcase: { 'app-update-review': 1 },

  secrets({ env, state }) {
    return [{ label: 'master password', value: masterPassword(env) }, ...(state.item ? [{ label: 'saved item password', value: state.item.password }] : [])];
  },

  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/Vaultwarden|Bitwarden|Log in|Create account/iu, { timeout: 90000 });
  },

  async journey({ env, page, shot, state, step }) {
    state.email = await step('create the vault account', () => createAccount(page, env));
    const stamp = Date.now().toString(36);
    const item = { name: `MOS E2E login ${stamp}`, password: `E2E-${stamp}-item-secret!`, username: 'e2e@example.com' };
    await step('save a login item', () => createLoginItem(page, item));
    state.item = item;
    await shot('vault');
  },

  async verify({ env, freshPage, shot, state, step, url }) {
    if (!state.item) throw new Error('Vaultwarden verify needs the item its journey saved (run app:vaultwarden first, or carry it in with --continue).');
    const page = await freshPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await step('sign in from a new device', () => signIn(page, env, state.email));
    await expect(page.getByText(state.item.name).first(), 'the saved login item should still be in the vault').toBeVisible({ timeout: 60000 });
    await shot('vault', { page });
    await step('the item still decrypts to what was saved', async () => {
      await page.getByText(state.item.name).first().click();
      const view = page.getByRole('dialog', { name: 'View Login' });
      await expect(view.getByRole('textbox', { name: 'Username' })).toHaveValue(state.item.username, { timeout: 30000 });
      await expect(view.getByRole('textbox', { name: 'Password' })).toHaveValue(state.item.password);
      await view.getByRole('button', { name: 'Close' }).first().click();
    });
  },
};
