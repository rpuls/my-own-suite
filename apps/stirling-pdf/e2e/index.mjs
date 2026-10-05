// Stirling PDF's own end-to-end journey for the MOS E2E suite (test/e2e). Not
// package content: a package's e2e/ folder never ships and never changes its digest.
import fs from 'node:fs';

import { expect } from '@playwright/test';

const DEFAULT_USER = 'admin';
const DEFAULT_PASSWORD = 'stirling';
const adminPassword = (env) => env.read('MOS_E2E_STIRLING_PASSWORD', 'stirling-test-password');

async function submitLogin(page, password) {
  await page.getByRole('textbox', { name: 'Username' }).fill(DEFAULT_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { exact: true, name: 'Login' }).click();
}

// A fresh Stirling signs in with its published default and then insists on a new
// password before anything else; every later visit uses that new password.
async function signIn(page, env, { firstVisit }) {
  await expect(page.locator('body')).toContainText(/Stirling|Login|Tools/iu, { timeout: 90000 });
  if (!/\/login/iu.test(page.url())) {
    await page.keyboard.press('Escape');
    return;
  }
  if (await page.getByText('Default Login Credentials').waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    if (!firstVisit) throw new Error('Stirling PDF is back on its default password, so the password set by the journey did not survive.');
    await submitLogin(page, DEFAULT_PASSWORD);
    const dialog = page.getByRole('dialog').filter({ hasText: 'Set Your Password' });
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await dialog.getByRole('textbox', { exact: true, name: 'New Password' }).fill(adminPassword(env));
    await dialog.getByRole('textbox', { exact: true, name: 'Confirm New Password' }).fill(adminPassword(env));
    await dialog.getByRole('button', { name: 'Change Password' }).click();
    await expect(page).toHaveURL(/\/login/iu, { timeout: 30000 });
  }
  await submitLogin(page, adminPassword(env));
  await expect(page.getByRole('textbox', { name: 'Search tools...' }), 'Stirling PDF should open its tools once signed in').toBeVisible({ timeout: 60000 });
  // The "Welcome to Stirling V2" tour opens over the tools on first sign-in.
  await page.keyboard.press('Escape');
}

async function mergeTwo(page, make, stamp) {
  const files = [];
  for (const part of [1, 2]) {
    files.push(await make.pdf(`part-${part}`, `<h1>MOS E2E part ${part}</h1><p>Run ${stamp}</p>`));
  }
  await page.getByRole('link', { exact: true, name: 'Merge' }).click();
  await page.locator('input[type=file]').first().setInputFiles(files);
  await expect(page.getByText(/2 files selected/iu)).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Go to file editor' }).click();
  const [merged] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/v1/general/merge-pdfs'), { timeout: 60000 }),
    page.getByRole('button', { name: /^Merge \(2 files\)$/u }).click(),
  ]);
  expect(merged.status(), 'the Stirling server should merge the files').toBe(200);
  await expect(page.getByText(/^merged_.*\.pdf$/u).first(), 'the merged file should be offered for review').toBeVisible({ timeout: 60000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { exact: true, name: 'Download' }).click()]);
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString('latin1'), 'the download should be a PDF').toBe('%PDF-');
  // Page objects sit in compressed object streams, so the count is read from Stirling's own viewer.
  await expect(page.getByText('/ 2', { exact: true }).first(), 'the merged PDF should hold both pages').toBeVisible({ timeout: 30000 });
}

export default {
  showcase: { 'app-update-review': 4 },

  secrets({ env }) {
    return [{ label: 'admin password', value: adminPassword(env) }];
  },

  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/Stirling|PDF|Login/iu, { timeout: 90000 });
  },

  async journey({ env, make, page, shot, step }) {
    await step('sign in, replacing the default password', () => signIn(page, env, { firstVisit: true }));
    await shot('tools');
    await step('merge two PDFs and download the result', () => mergeTwo(page, make, Date.now().toString(36)));
    await shot('merge-review');
  },

  async verify({ env, page, shot, step }) {
    await step('sign in with the password the journey set', () => signIn(page, env, { firstVisit: false }));
    await shot('tools');
  },
};
