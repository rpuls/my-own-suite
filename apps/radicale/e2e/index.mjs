// Radicale's own end-to-end journey for the MOS E2E suite (test/e2e). Not package
// content: a package's e2e/ folder never ships and never changes its digest.
import { expect } from '@playwright/test';

const username = (env) => env.read('MOS_E2E_RADICALE_USERNAME', 'admin');
const password = (env) => env.read('MOS_E2E_RADICALE_PASSWORD', 'radicale-test-password');

function basicAuth(env) {
  return `Basic ${Buffer.from(`${username(env)}:${password(env)}`).toString('base64')}`;
}

const collections = (page) => page.locator('#collectionsscene:not(.hidden)');

async function signIn(page, env) {
  if (await collections(page).isVisible().catch(() => false)) return;
  await expect(page.locator('#loginscene:not(.hidden)'), 'Radicale login form should be visible').toBeVisible({ timeout: 60000 });
  await page.locator('input[data-name="user"]').fill(username(env));
  await page.locator('input[data-name="password"]').fill(password(env));
  await page.locator('form[data-name="form"] button[type="submit"]').click();
  await expect(collections(page), 'Radicale should reach the signed-in collections view').toBeVisible({ timeout: 60000 });
}

function collectionCard(page, title) {
  return collections(page).locator('article').filter({ has: page.getByRole('heading', { name: title }) });
}

// Made in Radicale's own web UI; the card shows the collection's address.
async function createCollection(page, type, title) {
  await collections(page).locator('a[data-name="new"]').click();
  const form = page.locator('#createcollectionscene:not(.hidden)');
  await expect(form).toBeVisible({ timeout: 30000 });
  await form.locator('select[data-name="type"]').selectOption(type);
  await form.locator('input[data-name="displayname"]').fill(title);
  await form.locator('button[data-name="submit"]').click();
  await expect(collectionCard(page, title)).toBeVisible({ timeout: 30000 });
  return new URL(await collectionCard(page, title).getByRole('textbox').inputValue()).pathname;
}

// Read back at whatever door this run is on, which may have changed since.
function itemUrl(entry, currentUrl) {
  return new URL(entry.file, new URL(entry.path, currentUrl)).toString();
}

async function putItem(page, env, url, entry, contentType, body) {
  const response = await page.request.fetch(itemUrl(entry, url), {
    data: body,
    headers: { Authorization: basicAuth(env), 'Content-Type': `${contentType}; charset=utf-8` },
    method: 'PUT',
  });
  expect(response.status(), `PUT of ${entry.file}`).toBeLessThan(300);
}

async function expectItem(page, env, url, entry, line) {
  const response = await page.request.get(itemUrl(entry, url), { headers: { Authorization: basicAuth(env) } });
  expect(response.status(), `${entry.file} should still be there`).toBe(200);
  expect(await response.text()).toContain(line);
}

function eventIcs(uid, summary) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MOS//E2E//EN', 'BEGIN:VEVENT',
    `UID:${uid}`, 'DTSTAMP:20261005T080000Z', 'DTSTART:20261012T090000Z', 'DTEND:20261012T100000Z',
    `SUMMARY:${summary}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function contactVcf(uid, name) {
  return ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${name}`, `N:${name};;;;`, 'EMAIL:e2e-contact@example.com', 'END:VCARD', ''].join('\r\n');
}

export default {
  showcase: { 'app-setup-guide': 1, 'app-update-review': 3 },

  setupValue({ env, field }) {
    if (field.id === 'adminUsername') return username(env);
    if (field.id === 'adminPassword') return password(env);
    return undefined;
  },

  secrets({ env }) {
    return [{ label: 'password', value: password(env) }];
  },

  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/Radicale|Collection management|Sign in|Username|Authentication|Unauthorized/iu, { timeout: 60000 });
  },

  // A calendar and an address book made in Radicale's own web UI, with an event
  // and a contact put into them over CalDAV and CardDAV, the way every client
  // the owner connects will reach them.
  async journey({ env, page, shot, state, step, url }) {
    await step('sign in', () => signIn(page, env));
    const stamp = Date.now().toString(36);
    const calendar = { file: `mos-e2e-${stamp}.ics`, line: `SUMMARY:MOS E2E event ${stamp}`, title: `MOS E2E calendar ${stamp}` };
    const addressBook = { file: `mos-e2e-${stamp}.vcf`, line: `FN:MOS E2E Contact ${stamp}`, title: `MOS E2E contacts ${stamp}` };
    await step('create a calendar and an address book in the web UI', async () => {
      calendar.path = await createCollection(page, 'CALENDAR', calendar.title);
      addressBook.path = await createCollection(page, 'ADDRESSBOOK', addressBook.title);
    });
    await step('put an event over CalDAV and a contact over CardDAV', async () => {
      await putItem(page, env, url, calendar, 'text/calendar', eventIcs(`mos-e2e-${stamp}`, `MOS E2E event ${stamp}`));
      await putItem(page, env, url, addressBook, 'text/vcard', contactVcf(`mos-e2e-contact-${stamp}`, `MOS E2E Contact ${stamp}`));
    });
    Object.assign(state, { addressBook, calendar });
    await page.locator('#logoutview a[data-name="refresh"]').click().catch(() => undefined);
    await expect(collectionCard(page, calendar.title)).toContainText(/1 item/iu, { timeout: 30000 });
    await expect(collectionCard(page, addressBook.title)).toContainText(/1 item/iu, { timeout: 30000 });
    await shot('collections');
  },

  async verify({ env, page, shot, state, step, url }) {
    if (!state.calendar) throw new Error('Radicale verify needs the collections its journey made (run app:radicale first, or carry it in with --continue).');
    await step('sign in', () => signIn(page, env));
    for (const entry of [state.calendar, state.addressBook]) {
      await expect(collectionCard(page, entry.title), `"${entry.title}" should still be listed`).toBeVisible({ timeout: 30000 });
    }
    await step('read the event and the contact back', async () => {
      await expectItem(page, env, url, state.calendar, state.calendar.line);
      await expectItem(page, env, url, state.addressBook, state.addressBook.line);
    });
    await shot('collections');
  },
};
