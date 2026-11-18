// Memos's own end-to-end journey for the MOS E2E suite (test/e2e). Not
// package content: a package's e2e/ folder never ships and never changes its digest.
import { expect } from '@playwright/test';

const username = (env) => env.read('MOS_E2E_MEMOS_USERNAME', 'mos-e2e');
const password = (env) => env.read('MOS_E2E_MEMOS_PASSWORD', 'memos-test-password');

// The editor holds the same text until the save lands, so a saved note is matched on its card.
const savedNote = (page, text) => page.locator('[data-memo-content]').filter({ hasText: text }).first();

// A fresh install opens on the first-run screen; every later visit on the sign-in form.
async function signIn(page, env, { firstVisit }) {
  const create = page.getByRole('button', { name: 'Create admin account' });
  const signInButton = page.getByRole('button', { exact: true, name: 'Sign in' });
  await expect(create.or(signInButton)).toBeVisible({ timeout: 60000 });
  const setup = await create.isVisible();
  if (setup && !firstVisit) throw new Error('Memos is back at first-run setup, so the server lost its accounts and notes.');
  await page.getByPlaceholder('Username').fill(username(env));
  await page.getByPlaceholder('Password').fill(password(env));
  await (setup ? create : signInButton).click();
  await expect(page.locator('.memo-editor-root').first(), 'Memos should open the timeline').toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Skip' }).click({ timeout: 3000 }).catch(() => undefined);
}

export default {
  secrets({ env }) {
    return [{ label: 'admin password', value: password(env) }];
  },

  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/Memos|Sign in|Set up your instance/iu, { timeout: 45000 });
  },

  async journey({ env, page, shot, state, step }) {
    await step('create the admin account', () => signIn(page, env, { firstVisit: true }));
    const stamp = Date.now().toString(36);
    const note = `MOS E2E note ${stamp}`;
    const item = `Bin bags ${stamp}`;
    await step('write a note with a checklist and a tag', async () => {
      await page.locator('.memo-editor-root').first().click();
      await page.keyboard.type(`${note} #mose2e`);
      await page.keyboard.press('Enter');
      await page.keyboard.type(`- [ ] ${item}`);
      await page.getByRole('button', { exact: true, name: 'Save' }).click();
      await expect(savedNote(page, note)).toBeVisible({ timeout: 30000 });
    });
    await step('tick the checklist item', async () => {
      const saved = page.waitForResponse((response) => /MemoService\/UpdateMemo/u.test(response.url()) && response.ok());
      await savedNote(page, note).getByRole('checkbox').click();
      await saved;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(savedNote(page, note).getByRole('checkbox')).toBeChecked({ timeout: 30000 });
    });
    Object.assign(state, { item, note });
    await shot('timeline');
  },

  // Opened in a browser that has never seen this server, so the note can only have come from it.
  async verify({ env, freshPage, shot, state, step, url }) {
    if (!state.note) throw new Error('Memos verify needs the note its journey made (run app:memos first, or carry it in with --continue).');
    const page = await freshPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await step('a stranger sees no notes, only the way to sign in', async () => {
      const explore = page.getByRole('link', { name: 'Sign in to Memos' });
      const signInButton = page.getByRole('button', { exact: true, name: 'Sign in' });
      await expect(explore.or(signInButton)).toBeVisible({ timeout: 60000 });
      if (await explore.isVisible()) {
        await expect(page.locator('[data-memo-content]'), 'a stranger must not see any note').toHaveCount(0);
        await explore.click();
      }
    });
    await step('sign-up stays closed to strangers', async () => {
      await expect(page.getByRole('button', { exact: true, name: 'Sign in' })).toBeVisible({ timeout: 60000 });
      await expect(page.getByRole('link', { name: 'Sign up' }), 'MOS ships Memos with sign-up turned off').toHaveCount(0);
    });
    await step('sign in', () => signIn(page, env, { firstVisit: false }));
    const saved = savedNote(page, state.note);
    await expect(saved, 'the note should still be there').toBeVisible({ timeout: 30000 });
    await expect(saved, 'the checklist item should still be there').toContainText(state.item);
    await expect(saved.getByRole('checkbox'), 'the ticked item should still be ticked').toBeChecked();
    await shot('timeline', { page });
  },
};
