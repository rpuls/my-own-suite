import { expect } from '@playwright/test';

const password = (env) => env.read('MOS_E2E_NAVIDROME_PASSWORD', 'navidrome-test-password');

async function signIn(page, setup) {
  await expect(page.locator('body')).toContainText(/Navidrome/iu, { timeout: 60000 });
  const username = page.locator('input[name="username"]');
  if (await username.isVisible()) {
    await username.fill(setup.adminName);
    await page.locator('input[name="password"]').fill(setup.adminPassword);
    await page.getByRole('button', { exact: true, name: /Sign in/iu }).click();
  }
  await expect(page.getByRole('menuitem', { exact: true, name: 'Songs' })).toBeVisible({ timeout: 60000 });
}

async function api(page, method, params = {}) {
  const response = await page.evaluate(async ({ method: endpoint, params: values }) => {
    const query = new URLSearchParams({
      c: 'MOS-E2E', f: 'json', v: '1.16.1', u: localStorage.getItem('username'),
      s: localStorage.getItem('subsonic-salt'), t: localStorage.getItem('subsonic-token'), ...values,
    });
    const result = await fetch(`/rest/${endpoint}?${query}`);
    if (!result.ok) throw new Error(`Subsonic HTTP ${result.status}`);
    return (await result.json())['subsonic-response'];
  }, { method, params });
  expect(response.status, JSON.stringify(response.error)).toBe('ok');
  return response;
}

async function play(page, title) {
  await page.getByRole('menuitem', { exact: true, name: 'Songs' }).click();
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill(title);
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 60000 });
  await row.getByText(title, { exact: true }).dblclick();
  await expect.poll(() => page.evaluate(() => Math.max(0, ...Array.from(document.querySelectorAll('audio'), (audio) => audio.currentTime))), {
    message: 'the song should play in the browser', timeout: 60000,
  }).toBeGreaterThan(1);
}

export default {
  setupValue({ env, field }) {
    return field.id === 'adminPassword' ? password(env) : null;
  },
  secrets({ env }) {
    return [{ label: 'admin password', value: password(env) }];
  },
  async landed({ page }) {
    await expect(page.locator('body')).toContainText('Navidrome', { timeout: 60000 });
  },
  async journey({ drive, make, page, setup, shot, state, step }) {
    await step('sign in with the administrator chosen at install', () => signIn(page, setup));
    const title = `MOS Song ${Date.now().toString(36)}`;
    await step('add music to the drive and reconnect it', async () => {
      await drive.put('Music', await make.audio('song', { seconds: 8 }), `${title}.wav`);
      await drive.replug();
    });
    let song;
    await step('the music is found automatically', async () => {
      await expect.poll(async () => {
        song = (await api(page, 'search3', { query: title })).searchResult3?.song?.find((item) => item.title === title);
        return Boolean(song);
      }, { intervals: [3000], timeout: 180000 }).toBe(true);
    });
    const name = `Evening music ${Date.now().toString(36)}`;
    await step('save a playlist containing the song', async () => {
      const { playlist } = await api(page, 'createPlaylist', { name, songId: song.id });
      Object.assign(state, { playlistId: playlist.id, playlistName: name, songId: song.id, title });
      expect(playlist.entry.map((entry) => entry.id)).toContain(song.id);
    });
    await step('play the song', () => play(page, title));
    await shot('playing');
  },
  async verify({ page, setup, shot, state, step }) {
    if (!state.playlistId) throw new Error('Run the Navidrome journey before verifying its saved music and playlist.');
    await step('sign in after restore or update', () => signIn(page, setup));
    await step('the playlist and its music survived', async () => {
      const { playlist } = await api(page, 'getPlaylist', { id: state.playlistId });
      expect(playlist.name).toBe(state.playlistName);
      expect(playlist.entry.map((entry) => entry.id)).toContain(state.songId);
    });
    await step('the music still plays', () => play(page, state.title));
    await shot('playing');
  },
};

