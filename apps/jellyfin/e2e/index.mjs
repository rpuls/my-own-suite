// Jellyfin's own end-to-end journey for the MOS E2E suite (test/e2e). Not package
// content: a package's e2e/ folder never ships and never changes its digest.
import { expect } from '@playwright/test';

const CLIENT = 'MediaBrowser Client="MOS E2E", Device="Playwright", DeviceId="mos-e2e", Version="1"';
const adminPassword = (env) => env.read('MOS_E2E_JELLYFIN_PASSWORD', 'jellyfin-test-password');

// Jellyfin's own API from inside its page, signed in as the administrator the
// package created at install.
async function api(page, setup, path, { method = 'GET' } = {}) {
  return page.evaluate(async ({ client, name, password, path: target, method: verb }) => {
    const session = await fetch('/Users/AuthenticateByName', {
      body: JSON.stringify({ Pw: password, Username: name }),
      headers: { Authorization: client, 'Content-Type': 'application/json' },
      method: 'POST',
    }).then((response) => response.json());
    const response = await fetch(target, { headers: { Authorization: `${client}, Token="${session.AccessToken}"` }, method: verb });
    return { body: response.status === 204 ? null : await response.json().catch(() => null), status: response.status };
  }, { client: CLIENT, method, name: setup.adminName, password: setup.adminPassword, path });
}

// The package finishes Jellyfin's setup a few seconds after it first answers, and a
// page opened in between keeps showing the first-run wizard until it is reloaded.
// The same for a page opened while Jellyfin restarts onto a returning drive, which
// says "Server Unavailable" until reloaded.
async function reloadUntil(page, pattern, message) {
  await expect.poll(async () => {
    if (pattern.test(await page.locator('body').innerText().catch(() => ''))) return true;
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    return false;
  }, { intervals: [2000], message, timeout: 120000 }).toBe(true);
}

const SIGNED_IN = /Favorites/u;

// A tab that already signed in, as after a drive drill, stays signed in.
async function signIn(page, setup) {
  await reloadUntil(page, /Sign In|Please sign in|Manual Login|Favorites/iu, 'Jellyfin should offer its sign-in page');
  if (SIGNED_IN.test(await page.locator('body').innerText())) return;
  const manual = page.getByRole('button', { name: /Manual Login/iu });
  if (await manual.isVisible().catch(() => false)) await manual.click();
  await page.locator('#txtManualName').fill(setup.adminName);
  await page.locator('#txtManualPassword').fill(setup.adminPassword);
  await page.getByRole('button', { exact: true, name: 'Sign In' }).click();
  await expect(page.locator('body')).toContainText(/My Media|Movies/iu, { timeout: 60000 });
}

async function filmsNamed(page, setup, name) {
  const found = await api(page, setup, `/Items?Recursive=true&IncludeItemTypes=Movie&SearchTerm=${encodeURIComponent(name)}`);
  return found.body?.Items || [];
}

async function playsInTheBrowser(page, url, film) {
  await page.goto(new URL(`/web/#/details?id=${film.Id}`, url).toString());
  await page.getByRole('button', { name: /^Play$/iu }).first().click();
  await expect.poll(() => page.evaluate(() => document.querySelector('video')?.currentTime || 0), { message: 'the film should play', timeout: 60000 }).toBeGreaterThan(1);
}

export default {
  setupValue({ env, field }) {
    if (field.id === 'adminPassword' || /password/iu.test(field.label || '')) return adminPassword(env);
    return null;
  },

  secrets({ env }) {
    return [{ label: 'admin password', value: adminPassword(env) }];
  },

  async landed({ page }) {
    await reloadUntil(page, /Jellyfin|Sign In|Favorites/iu, 'Jellyfin should answer');
  },

  async journey({ drive, make, page, setup, shot, state, step, url }) {
    await step('sign in as the administrator chosen at install', () => signIn(page, setup));
    await step('the Movies and Series libraries are already there', async () => {
      const libraries = (await api(page, setup, '/Library/VirtualFolders')).body || [];
      expect(libraries.map((library) => [library.Name, library.Locations])).toEqual([['Movies', ['/media/movies']], ['Series', ['/media/series']]]);
      expect(libraries.every((library) => library.LibraryOptions.SaveSubtitlesWithMedia === false)).toBe(true);
    });
    const title = `MOS E2E Film ${Date.now().toString(36)}`;
    await step('copy a film onto the drive and plug it back in', async () => {
      const film = await make.video('film', { label: title });
      await drive.put('Movies', film, `${title} (2026)/${title} (2026).webm`);
      await drive.replug();
    });
    let film;
    await step('Jellyfin finds the film on its own', async () => {
      await expect.poll(async () => {
        film = (await filmsNamed(page, setup, title).catch(() => []))[0];
        return Boolean(film);
      }, { intervals: [5000], message: 'Jellyfin should list the film copied onto the drive', timeout: 300000 }).toBe(true);
    });
    await page.goto(new URL('/web/#/home.html', url).toString());
    await expect(page.locator('body')).toContainText(/Movies/iu, { timeout: 60000 }).catch(() => signIn(page, setup));
    await shot('home');
    await step('the film plays', () => playsInTheBrowser(page, url, film));
    await shot('playing');
    Object.assign(state, { filmId: film.Id, title });
  },

  async verify({ page, setup, shot, state, step, url }) {
    if (!state.title) throw new Error('Jellyfin verify needs the film its journey put on the drive (run app:jellyfin first, or carry it in with --continue).');
    await step('sign in', () => signIn(page, setup));
    let film;
    await step('the film on the drive is still in the library', async () => {
      await expect.poll(async () => {
        film = (await filmsNamed(page, setup, state.title).catch(() => []))[0];
        return Boolean(film);
      }, { intervals: [5000], message: 'the film should still be listed', timeout: 300000 }).toBe(true);
    });
    await step('and still plays', () => playsInTheBrowser(page, url, film));
    await shot('playing');
  },
};
