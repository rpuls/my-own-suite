// Immich's own end-to-end journey for the MOS E2E suite (test/e2e). Not package
// content: a package's e2e/ folder never ships and never changes its digest.
import { expect } from '@playwright/test';

const adminEmail = (env) => env.read('MOS_E2E_IMMICH_EMAIL', env.owner.email);
const adminPassword = (env) => env.read('MOS_E2E_IMMICH_PASSWORD', 'immich-test-password');
const PHOTO_COLOURS = ['#2f7d4a', '#b4233c', '#1f5fbf'];

// The web client's own API, called with its own session.
function api(page, path, { body, method = 'GET' } = {}) {
  return page.evaluate(async (request) => {
    const response = await fetch(request.path, {
      body: request.body ? JSON.stringify(request.body) : undefined,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      method: request.method,
    });
    return { body: await response.json().catch(() => null), status: response.status };
  }, { body, method, path });
}

async function register(page, env) {
  await page.getByRole('link', { name: 'Getting Started' }).click();
  await page.getByRole('textbox', { name: 'Admin Email' }).fill(adminEmail(env));
  await page.getByRole('textbox', { exact: true, name: 'Admin Password' }).fill(adminPassword(env));
  await page.getByRole('textbox', { name: 'Confirm Admin Password' }).fill(adminPassword(env));
  await page.getByRole('textbox', { name: 'Name' }).fill(env.owner.name);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/auth\/login/u, { timeout: 30000 });
}

// Theme, language, privacy and the mobile app, each step's button naming the
// next one, until Done lands on the timeline.
async function finishOnboarding(page) {
  for (let step = 0; step < 10 && /\/auth\/onboarding/u.test(page.url()); step += 1) {
    const done = page.getByRole('button', { exact: true, name: 'Done' });
    if (await done.isVisible().catch(() => false)) {
      await done.click();
      break;
    }
    await page.getByRole('button').last().click();
    await page.waitForTimeout(1000);
  }
  await expect(page).toHaveURL(/\/photos/u, { timeout: 30000 });
}

async function signIn(page, env, { firstVisit }) {
  await expect(page.locator('body')).toContainText(/Immich|Welcome|Login|Search your photos/iu, { timeout: 90000 });
  if (await page.getByRole('link', { name: 'Getting Started' }).isVisible().catch(() => false)) {
    if (!firstVisit) throw new Error('Immich is back at first-run setup, so its database did not survive.');
    await register(page, env);
  }
  if (/\/auth\/login/u.test(page.url())) {
    await page.getByRole('textbox', { name: 'Email' }).fill(adminEmail(env));
    await page.getByRole('textbox', { name: 'Password' }).fill(adminPassword(env));
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).not.toHaveURL(/\/auth\/login/u, { timeout: 30000 });
  }
  if (/\/auth\/onboarding/u.test(page.url())) await finishOnboarding(page);
  await expect(page.getByRole('link', { name: 'Photos' }), 'Immich should open its timeline').toBeVisible({ timeout: 60000 });
}

// The album's title is an editable field on its own page.
async function expectAlbumPage(page, name, count) {
  await expect(page.getByRole('textbox', { name: 'Edit Title' })).toHaveValue(name, { timeout: 30000 });
  await expect(page.getByText(new RegExp(`${count} items`, 'u')).first()).toBeVisible();
}

async function photosFrom(page, stamp) {
  const search = await api(page, '/api/search/metadata', { body: { originalFileName: `photo-${stamp}` }, method: 'POST' });
  return search.body?.assets?.items || [];
}

export default {
  // Storage use moves with every upload anywhere on the server; it says nothing about this app's screens.
  masks(page) {
    return [page.getByRole('meter', { name: 'Storage space' }), page.getByText(/GiB of .* GiB used/u)];
  },

  secrets({ env }) {
    return [{ label: 'admin password', value: adminPassword(env) }];
  },

  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/Immich|Welcome|Login|Search your photos/iu, { timeout: 90000 });
  },

  async journey({ env, make, page, shot, state, step, url }) {
    await step('register the admin and sign in', () => signIn(page, env, { firstVisit: true }));
    const stamp = Date.now().toString(36);
    const files = [];
    for (const [index, colour] of PHOTO_COLOURS.entries()) {
      files.push(await make.png(`photo-${stamp}-${index + 1}`, `<body style="margin:0;background:${colour};display:grid;place-items:center;height:100vh;font:48px sans-serif;color:#fff">MOS E2E ${stamp} #${index + 1}</body>`, { height: 600, width: 900 }));
    }
    await step('upload photos', async () => {
      const chooser = page.waitForEvent('filechooser', { timeout: 15000 });
      await page.getByRole('button', { exact: true, name: 'Upload' }).click();
      await (await chooser).setFiles(files);
      await expect.poll(async () => (await photosFrom(page, stamp)).length, { intervals: [3000], message: 'Immich should list every uploaded photo', timeout: 180000 }).toBe(files.length);
    });
    await step('its background jobs make previews', async () => {
      const [first] = await photosFrom(page, stamp);
      const preview = new URL(`/api/assets/${first.id}/thumbnail?size=preview`, url).toString();
      await expect.poll(async () => (await page.request.get(preview)).status(), { intervals: [3000], message: 'Immich should generate a preview', timeout: 180000 }).toBe(200);
    });
    const albumName = `MOS E2E ${stamp}`;
    await step('put them in an album', async () => {
      const ids = (await photosFrom(page, stamp)).map((asset) => asset.id);
      const album = await api(page, '/api/albums', { body: { albumName, assetIds: ids }, method: 'POST' });
      expect(album.status, 'creating the album').toBe(201);
      state.albumId = album.body.id;
    });
    Object.assign(state, { albumName, photos: files.length, stamp });
    await page.goto(new URL('/photos', url).toString());
    await expect(page.getByRole('link', { name: 'Photos' })).toBeVisible({ timeout: 30000 });
    await shot('photos');
    await page.goto(new URL(`/albums/${state.albumId}`, url).toString());
    await expectAlbumPage(page, albumName, files.length);
    await shot('album');
  },

  async verify({ env, page, shot, state, step, url }) {
    if (!state.stamp) throw new Error('Immich verify needs the photos its journey uploaded (run app:immich first, or carry it in with --continue).');
    await step('sign in', () => signIn(page, env, { firstVisit: false }));
    await step('the photos, their files and the album are still there', async () => {
      const photos = await photosFrom(page, state.stamp);
      expect(photos.length, 'every uploaded photo').toBe(state.photos);
      for (const photo of photos) {
        const original = await page.request.get(new URL(`/api/assets/${photo.id}/original`, url).toString());
        expect(original.status(), `the original file of ${photo.originalFileName}`).toBe(200);
        const preview = await page.request.get(new URL(`/api/assets/${photo.id}/thumbnail?size=preview`, url).toString());
        expect(preview.status(), `the preview Immich generated for ${photo.originalFileName}`).toBe(200);
      }
      const album = await api(page, `/api/albums/${state.albumId}`);
      expect(album.body?.albumName).toBe(state.albumName);
      expect(album.body?.assets?.length ?? album.body?.assetCount).toBe(state.photos);
    });
    await page.goto(new URL('/photos', url).toString());
    await expect(page.getByRole('link', { name: 'Photos' })).toBeVisible({ timeout: 30000 });
    await shot('photos');
    await page.goto(new URL(`/albums/${state.albumId}`, url).toString());
    await expectAlbumPage(page, state.albumName, state.photos);
    await shot('album');
  },
};
