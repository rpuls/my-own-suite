// Paperless-ngx's own end-to-end journey for the MOS E2E suite (test/e2e). Not
// package content: a package's e2e/ folder never ships and never changes its digest.
import { expect } from '@playwright/test';

const adminUsername = (env) => env.read('MOS_E2E_PAPERLESS_USERNAME', 'admin');
const adminPassword = (env) => env.read('MOS_E2E_PAPERLESS_PASSWORD', 'paperless-test-password');

async function signIn(page, env) {
  if (/\/accounts\/login/iu.test(page.url())) {
    await page.getByRole('textbox', { name: 'Username' }).fill(adminUsername(env));
    await page.getByRole('textbox', { name: 'Password' }).fill(adminPassword(env));
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('link', { exact: true, name: 'Documents' }), 'Paperless should open its dashboard once signed in').toBeVisible({ timeout: 60000 });
}

// Read with the browser's own session: the same API the Paperless UI calls.
async function apiCount(page, query) {
  return page.evaluate(async (search) => {
    const response = await fetch(`/api/documents/?${search}`, { headers: { Accept: 'application/json' } });
    return response.ok ? (await response.json()).count : -1;
  }, query);
}

async function documentId(page, title) {
  return page.evaluate(async (search) => {
    const response = await fetch(`/api/documents/?title__iexact=${encodeURIComponent(search)}`, { headers: { Accept: 'application/json' } });
    return response.ok ? (await response.json()).results?.[0]?.id ?? null : null;
  }, title);
}

// The stored original and the thumbnail Paperless generated from it, as files.
async function expectFiles(page, url, id) {
  const original = await page.request.get(new URL(`/api/documents/${id}/download/?original=true`, url).toString());
  expect(original.status(), 'the original document downloads').toBe(200);
  expect((await original.body()).subarray(0, 5).toString('latin1'), 'the original is still the uploaded PDF').toBe('%PDF-');
  const thumbnail = await page.request.get(new URL(`/api/documents/${id}/thumb/`, url).toString());
  expect(thumbnail.status(), 'the generated thumbnail is served').toBe(200);
}

async function waitForDocument(page, query, minutes = 4) {
  await expect.poll(() => apiCount(page, query), { intervals: [3000], message: `Paperless should consume the upload (${query})`, timeout: minutes * 60 * 1000 }).toBe(1);
}

export default {
  setupValue({ env, field }) {
    if (field.id === 'adminUsername') return adminUsername(env);
    if (field.id === 'adminPassword') return adminPassword(env);
    return undefined;
  },

  secrets({ env }) {
    return [{ label: 'admin password', value: adminPassword(env) }];
  },

  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/Paperless|Username|Sign in|Dashboard/iu, { timeout: 90000 });
  },

  // A generated invoice goes in through the dashboard upload, is consumed, and
  // comes back out of the full-text index by a word only its contents carry.
  async journey({ env, make, page, shot, state, step, url }) {
    await step('sign in', () => signIn(page, env));
    await shot('dashboard');
    const reference = `MOSE2E${Date.now().toString(36).toUpperCase()}`;
    const title = `invoice-${reference.toLowerCase()}`;
    const file = await make.pdf(title, `<h1>Invoice ${reference}</h1><p>Amount due: 42 EUR. Payment reference ${reference}.</p>`);
    await step('upload a document', async () => {
      await page.locator('input[type=file]').first().setInputFiles(file);
      await waitForDocument(page, `title__iexact=${encodeURIComponent(title)}`);
    });
    await step('find it by its contents', async () => {
      await waitForDocument(page, `query=${encodeURIComponent(reference)}`, 2);
    });
    await step('its original and thumbnail are stored', async () => expectFiles(page, url, await documentId(page, title)));
    Object.assign(state, { reference, title });
    await page.getByRole('link', { exact: true, name: 'Documents' }).click();
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 30000 });
    await shot('documents');
  },

  async verify({ env, page, shot, state, step, url }) {
    if (!state.title) throw new Error('Paperless verify needs the document its journey uploaded (run app:paperless-ngx first, or carry it in with --continue).');
    await step('sign in', () => signIn(page, env));
    await shot('dashboard');
    await step('the document and its search index are still there', async () => {
      expect(await apiCount(page, `title__iexact=${encodeURIComponent(state.title)}`), 'the uploaded document').toBe(1);
      expect(await apiCount(page, `query=${encodeURIComponent(state.reference)}`), 'a full-text match on its contents').toBe(1);
      await expectFiles(page, url, await documentId(page, state.title));
    });
    await page.getByRole('link', { exact: true, name: 'Documents' }).click();
    await expect(page.getByText(state.title).first()).toBeVisible({ timeout: 30000 });
    await shot('documents');
  },
};
