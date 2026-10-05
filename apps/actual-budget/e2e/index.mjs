// Actual Budget's own end-to-end journey for the MOS E2E suite (test/e2e). Not
// package content: a package's e2e/ folder never ships and never changes its digest.
import { expect } from '@playwright/test';

const serverPassword = (env) => env.read('MOS_E2E_ACTUAL_PASSWORD', 'actual-test-password');
const OPENING_BALANCE = '1234.56';
const PAYMENT = '12.34';
const BALANCE_AFTER = '1,222.22';
const BUDGETED = '100';

// Actual starts on one of several screens depending on what the server and this
// browser already hold; each is answered until a budget is open.
async function openBudget(page, env, { firstVisit }) {
  const password = page.getByRole('textbox', { exact: true, name: 'Password' });
  const addAccount = page.getByRole('button', { name: 'Add account' }).first();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await expect(page.locator('body')).not.toContainText('Initializing the connection', { timeout: 60000 });
    if (await addAccount.isVisible().catch(() => false)) break;
    if (/\/bootstrap/u.test(page.url())) {
      if (!firstVisit) throw new Error('Actual is back at first-run setup, so the server lost its password and budgets.');
      await password.fill(serverPassword(env));
      await page.getByRole('textbox', { name: 'Confirm password' }).fill(serverPassword(env));
      await page.getByRole('button', { name: 'OK' }).click();
    } else if (/\/login/u.test(page.url())) {
      await password.fill(serverPassword(env));
      await page.getByRole('button', { name: 'Sign in' }).click();
    } else if (await page.getByRole('button', { name: 'Start budgeting' }).isVisible().catch(() => false)) {
      if (!firstVisit) throw new Error('Actual has no budget on the server, so the budget the journey made did not survive.');
      await page.getByRole('button', { name: 'Start budgeting' }).click();
    } else if (await page.getByRole('grid', { name: 'Budget files' }).isVisible().catch(() => false)) {
      await page.getByRole('grid', { name: 'Budget files' }).getByRole('row').first().click();
    }
    await page.waitForTimeout(3000);
  }
  await expect(addAccount, 'Actual should open a budget').toBeVisible({ timeout: 60000 });
  // Actual announces its own new releases in a banner, which sits over the screen.
  await page.getByRole('alert').filter({ hasText: 'new version' }).getByRole('button', { name: 'Close' }).click({ timeout: 3000 }).catch(() => undefined);
}

async function addTransaction(page, payee, notes) {
  await page.getByRole('button', { name: 'Add New' }).click();
  await page.keyboard.press('Tab');
  await page.keyboard.type(payee);
  await page.keyboard.press('Tab');
  await page.keyboard.type(notes);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.type(PAYMENT);
  await page.getByRole('button', { exact: true, name: 'Add' }).click();
}

// The current month's amount budgeted to one of the categories every new budget has.
function budgetedCell(page) {
  const category = page.locator('[data-testid="category-name"]').filter({ hasText: /^Food$/u }).first();
  return category.locator('xpath=ancestor::*[.//*[@data-testid="budget"]][1]').locator('[data-testid="budget"]').first();
}

export default {
  secrets({ env }) {
    return [{ label: 'server password', value: serverPassword(env) }];
  },

  async landed({ page }) {
    const loaded = () => expect(page.locator('body')).toContainText(/Actual|Password|Initializing|All accounts/iu, { timeout: 45000 });
    // Seen once in about ten loads: the app stays blank until reloaded. Logged so it stays visible.
    await loaded().catch(async () => {
      console.warn('[actual-budget] the page stayed blank for 45 s; reloading once');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loaded();
    });
  },

  async journey({ env, page, shot, state, step }) {
    await step('set the server password and open a budget', () => openBudget(page, env, { firstVisit: true }));
    const stamp = Date.now().toString(36);
    const account = `MOS E2E Checking ${stamp}`;
    const payee = `MOS E2E Grocer ${stamp}`;
    await step('create an account with an opening balance', async () => {
      await page.getByRole('button', { name: 'Add account' }).first().click();
      await page.getByRole('button', { name: 'Create a local account' }).click();
      const dialog = page.getByRole('dialog').last();
      await dialog.getByRole('textbox', { name: 'Name:' }).fill(account);
      await dialog.getByRole('textbox', { name: 'Balance:' }).fill(OPENING_BALANCE);
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByRole('link', { name: new RegExp(`^${account}`, 'u') })).toBeVisible({ timeout: 30000 });
    });
    await step('record a payment', async () => {
      await addTransaction(page, payee, `run ${stamp}`);
      await expect(page.getByText(payee).first()).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole('link', { name: new RegExp(`^${account}`, 'u') })).toContainText(BALANCE_AFTER, { timeout: 30000 });
    });
    await step('budget money to a category', async () => {
      await page.getByRole('link', { exact: true, name: 'Budget' }).click();
      await budgetedCell(page).click();
      await page.keyboard.press('Control+a');
      await page.keyboard.type(BUDGETED);
      await page.keyboard.press('Enter');
      await expect(budgetedCell(page)).toHaveText(`${BUDGETED}.00`, { timeout: 30000 });
    });
    Object.assign(state, { account, payee });
    await page.getByRole('link', { name: new RegExp(`^${account}`, 'u') }).click();
    await shot('account');
  },

  // Opened in a browser that has never seen this budget, so the account and the
  // payment can only have come from the server.
  async verify({ env, freshPage, shot, state, step, url }) {
    if (!state.account) throw new Error('Actual verify needs the account its journey made (run app:actual-budget first, or carry it in with --continue).');
    const page = await freshPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await step('sign in and download the budget', () => openBudget(page, env, { firstVisit: false }));
    const account = page.getByRole('link', { name: new RegExp(`^${state.account}`, 'u') });
    await expect(account, 'the account should still be there').toContainText(BALANCE_AFTER, { timeout: 60000 });
    await account.click();
    await expect(page.getByText(state.payee).first(), 'the payment should still be there').toBeVisible({ timeout: 30000 });
    await shot('account', { page });
    await page.getByRole('link', { exact: true, name: 'Budget' }).click();
    await expect(budgetedCell(page), 'the amount budgeted to the category should still be there').toHaveText(`${BUDGETED}.00`, { timeout: 30000 });
  },
};
