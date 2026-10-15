// Seafile's own end-to-end journey for the MOS E2E suite (test/e2e). Not package
// content: a package's e2e/ folder never ships and never changes its digest.
import { inflateRawSync } from 'node:zlib';

import { expect } from '@playwright/test';

const adminEmail = (env) => env.read('MOS_E2E_SEAFILE_ADMIN_EMAIL', env.owner.email);
const adminPassword = (env) => env.read('MOS_E2E_SEAFILE_ADMIN_PASSWORD', 'seafile-test-password');

async function signIn(page, env) {
  const body = page.locator('body');
  await expect(body, 'Seafile should load its sign-in page or the libraries').toContainText(/Seafile|Email|Password|Log in|Libraries/iu, { timeout: 90000 });
  if (await page.getByText(/My Libraries/iu).first().isVisible().catch(() => false)) {
    await closeWelcome(page);
    return;
  }
  const email = page.locator('input[name="login"], input[type="email"]').first();
  const password = page.locator('input[name="password"], input[type="password"]').first();
  await expect(email).toBeVisible({ timeout: 30000 });
  await email.fill(adminEmail(env));
  await password.fill(adminPassword(env));
  await page.getByRole('button', { name: /log in|sign in/iu }).click();
  await expect(body).toContainText(/Libraries|My Libraries|Files/iu, { timeout: 90000 });
  await closeWelcome(page);
}

// The first sign-in opens "Welcome to Seafile" over the libraries.
async function closeWelcome(page) {
  const welcome = page.getByRole('dialog').filter({ hasText: 'Welcome to Seafile' });
  if (await welcome.waitFor({ timeout: 8000 }).then(() => true, () => false)) await welcome.getByRole('button', { name: 'Close' }).click();
}

// An empty folder offers quick "+ Word"-style buttons; any other folder keeps the
// same choices under More operations, New.
async function newFile(page, quickLabel, menuLabel, name) {
  const quick = page.getByRole('button', { name: quickLabel });
  if (await quick.isVisible().catch(() => false)) {
    await quick.click();
  } else {
    await page.getByRole('button', { exact: true, name: 'More operations' }).first().click();
    await page.getByRole('menuitem').filter({ has: page.getByText(menuLabel, { exact: true }) }).first().hover();
    await page.getByRole('menuitem', { exact: true, name: menuLabel }).click();
  }
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible({ timeout: 30000 });
}

// The text of a .docx, read from its word/document.xml through the zip's central directory.
function docxText(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('The downloaded document is not a zip archive.');
  let entry = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index += 1) {
    const nameLength = bytes.readUInt16LE(entry + 28);
    const name = bytes.toString('utf8', entry + 46, entry + 46 + nameLength);
    if (name === 'word/document.xml') {
      const local = bytes.readUInt32LE(entry + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(start, start + bytes.readUInt32LE(entry + 20));
      const xml = (bytes.readUInt16LE(entry + 10) === 8 ? inflateRawSync(data) : data).toString('utf8');
      return xml.replace(/<[^>]+>/gu, '');
    }
    entry += 46 + nameLength + bytes.readUInt16LE(entry + 30) + bytes.readUInt16LE(entry + 32);
  }
  throw new Error('The downloaded document has no word/document.xml.');
}

function libraryId(page) {
  return /\/library\/([0-9a-f-]{36})\//u.exec(page.url())?.[1];
}

async function fileSize(page, repo, name) {
  return page.evaluate(async ({ path, repo: id }) => {
    const response = await fetch(`/api/v2.1/repos/${id}/file/?p=${encodeURIComponent(path)}`, { headers: { Accept: 'application/json' } });
    return response.ok ? (await response.json()).size : -1;
  }, { path: `/${name}`, repo });
}

async function downloadText(page, repo, name) {
  const response = await page.request.get(new URL(`/lib/${repo}/file/${encodeURIComponent(name)}?dl=1`, page.url()).toString());
  expect(response.status(), `downloading ${name}`).toBe(200);
  return response.text();
}

async function uploadFile(page, file, name) {
  await page.getByRole('button', { exact: true, name: 'More operations' }).first().click();
  const chooser = page.waitForEvent('filechooser', { timeout: 15000 });
  await page.getByRole('menuitem', { name: 'Upload Files' }).click();
  await (await chooser).setFiles(file);
  await expect(fileRow(page, name)).toBeVisible({ timeout: 60000 });
}

// The upload panel lists the file too; the folder's own row is the draggable one.
function fileRow(page, name) {
  return page.locator('tr[draggable="true"]').filter({ hasText: name }).first();
}

// A public link anyone can open, made from the file's own menu; returns its token.
async function shareLink(page, name) {
  const row = fileRow(page, name);
  await row.hover();
  await row.getByRole('button', { name: 'More operations' }).click();
  await page.getByRole('menuitem', { exact: true, name: 'Share' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: `Share ${name}` });
  await dialog.getByRole('button', { exact: true, name: 'Generate Link' }).click();
  await dialog.getByRole('button', { exact: true, name: 'Generate' }).click();
  const link = dialog.getByRole('textbox').filter({ hasNotText: 'seafhttp' }).first();
  await expect(link).toHaveValue(/\/f\/[0-9a-f]+\//u, { timeout: 30000 });
  const token = /\/f\/([0-9a-f]+)\//u.exec(await link.inputValue())[1];
  await dialog.getByRole('button', { exact: true, name: 'Close' }).click();
  return token;
}

// Read the way a stranger with the link would: a browser that has never signed in.
async function readShared(freshPage, url, token) {
  const stranger = await freshPage();
  const response = await stranger.request.get(new URL(`/seafhttp/f/${token}/?op=view`, url).toString());
  expect(response.status(), 'the public link should serve the file without signing in').toBe(200);
  return response.text();
}

async function documentText(page, repo, name) {
  const response = await page.request.get(new URL(`/lib/${repo}/file/${encodeURIComponent(name)}?dl=1`, page.url()).toString());
  expect(response.status(), `downloading ${name}`).toBe(200);
  return docxText(await response.body());
}

// Opens the document from its row, which Seafile shows in the connected editor.
async function openInEditor(page, name) {
  const [editor] = await Promise.all([page.context().waitForEvent('page', { timeout: 30000 }), page.getByRole('link', { exact: true, name }).click()]);
  await expect.poll(() => editor.frames().some((frame) => /documenteditor\/main/u.test(frame.url())), { message: 'the document editor should load', timeout: 60000 }).toBe(true);
  const frame = editor.frames().find((item) => /documenteditor\/main/u.test(item.url()));
  await frame.locator('#editor_sdk').waitFor({ timeout: 90000 });
  await expect.poll(() => frame.title(), { timeout: 60000 }).toContain(name);
  return { editor, frame };
}

// Written in the office editor another app provides, saved back into Seafile,
// and read out of the stored file: the two apps working together end to end.
// The editor draws on a canvas, so its screenshot is the only view of the typed text.
async function writeDocument({ page, shot }, repo, name, text) {
  await newFile(page, '+ Word', 'New Word File', name);
  const emptySize = await fileSize(page, repo, name);
  const { editor, frame } = await openInEditor(page, name);
  // The editor draws its toolbar and page after the frame loads, and drops keys typed before then.
  await editor.waitForTimeout(8000);
  await frame.locator('#editor_sdk').click({ position: { x: 400, y: 200 } });
  await editor.keyboard.type(text);
  await editor.keyboard.press('Control+s');
  await editor.waitForTimeout(5000);
  await shot('document', { page: editor });
  await editor.close();
  await expect.poll(() => fileSize(page, repo, name), { intervals: [3000], message: 'the saved document should be stored back in Seafile', timeout: 90000 }).toBeGreaterThan(emptySize);
  await expect.poll(() => documentText(page, repo, name), { intervals: [3000], timeout: 60000 }).toContain(text);
}

export default {
  showcase: { 'app-connect': 1, 'app-detail-install': 1, 'app-update-review': 2, 'privacy-posture': 1 },

  setupValue({ env, field }) {
    if (field.id === 'adminEmail') return adminEmail(env);
    if (field.id === 'adminPassword') return adminPassword(env);
    return undefined;
  },

  secrets({ env }) {
    return [{ label: 'admin password', value: adminPassword(env) }];
  },

  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/Seafile|Email|Password|Log in|Libraries/iu, { timeout: 90000 });
  },

  async journey({ connected, env, freshPage, make, page, shot, state, step, url }) {
    await step('sign in', () => signIn(page, env));
    const library = `MOS E2E ${Date.now().toString(36)}`;
    const file = 'mos-e2e-notes.md';
    await step('create a library', async () => {
      await page.getByRole('button', { name: 'Operations' }).click();
      await page.getByRole('menuitem', { name: 'New Library' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Name' }).fill(library);
      await dialog.getByRole('button', { name: 'Submit' }).click();
      await expect(page.getByRole('link', { exact: true, name: library })).toBeVisible({ timeout: 30000 });
    });
    await shot('libraries');
    await step('create a file in it', async () => {
      await page.getByRole('link', { exact: true, name: library }).click();
      await newFile(page, '+ Markdown', 'New Markdown File', file);
    });
    Object.assign(state, { file, library });
    const upload = { content: `MOS E2E upload ${Date.now().toString(36)}
`, name: 'mos-e2e-upload.txt' };
    await step('upload a file, download it back and share it publicly', async () => {
      await uploadFile(page, make.text(upload.name, upload.content), upload.name);
      expect(await downloadText(page, libraryId(page), upload.name)).toBe(upload.content);
      upload.token = await shareLink(page, upload.name);
      expect(await readShared(freshPage, url, upload.token)).toBe(upload.content);
    });
    state.upload = upload;
    if (connected.includes('documentEditor')) {
      const document = { name: 'mos-e2e-letter.docx', text: `MOS E2E letter ${Date.now().toString(36)}` };
      await step('create a Word document, write in it in the connected office editor, save it and read it back', () => writeDocument({ page, shot }, libraryId(page), document.name, document.text));
      state.document = document;
    }
    await shot('library');
  },

  async verify({ connected, env, freshPage, page, shot, state, step, url }) {
    if (!state.library) throw new Error('Seafile verify needs the library its journey made (run app:seafile first, or carry it in with --continue).');
    await step('sign in', () => signIn(page, env));
    await expect(page.getByRole('link', { exact: true, name: state.library }), 'the library should still be listed').toBeVisible({ timeout: 60000 });
    await shot('libraries');
    await page.getByRole('link', { exact: true, name: state.library }).click();
    await expect(page.getByRole('row').filter({ hasText: state.file }), 'the file should still be in the library').toBeVisible({ timeout: 60000 });
    if (state.upload) {
      await step('the uploaded file and its public link still serve its content', async () => {
        expect(await downloadText(page, libraryId(page), state.upload.name)).toBe(state.upload.content);
        expect(await readShared(freshPage, url, state.upload.token)).toBe(state.upload.content);
      });
    }
    if (state.document) {
      await step('the document written in the office editor kept its text and still opens in it', async () => {
        expect(await documentText(page, libraryId(page), state.document.name)).toContain(state.document.text);
        expect(connected, 'Seafile should still be connected to the office editor its journey wrote in').toContain('documentEditor');
        await (await openInEditor(page, state.document.name)).editor.close();
      });
    }
    await shot('library');
    // After the shot, so the new file is not counted as a changed screen.
    if (state.document) {
      await step('create a new Word document, write in it in the office editor, save it and read it back', async () => {
        const stamp = Date.now().toString(36);
        await writeDocument({ page, shot }, libraryId(page), `mos-e2e-check-${stamp}.docx`, `MOS E2E check ${stamp}`);
      });
    }
  },
};
