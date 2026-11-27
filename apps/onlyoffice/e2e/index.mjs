// ONLYOFFICE's own end-to-end journey for the MOS E2E suite (test/e2e). Not
// package content: a package's e2e/ folder never ships and never changes its digest.
// Editing happens inside the apps it is connected to, so their journeys exercise it and
// screenshot the editor; its own page is only a welcome screen, not worth comparing.
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';

import { expect } from '@playwright/test';

// The welcome page is served before the document service behind it has started.
async function documentServerAnswers(page, url) {
  const health = new URL('/healthcheck', url).toString();
  await expect.poll(async () => {
    const response = await page.request.get(health);
    return response.status() === 200 ? (await response.text()).trim() : `HTTP ${response.status()}`;
  }, { intervals: [5000], message: 'the document server should report itself healthy', timeout: 180000 }).toBe('true');
  await expect(page.getByRole('heading', { name: /ONLYOFFICE Docs .* installed/iu })).toBeVisible({ timeout: 60000 });
}

// A ZIP with its entries stored uncompressed, which is all a .docx has to be.
function storedZip(entries) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const fileName = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, fileName, data);
    directory.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const end = Buffer.alloc(22);
  const listing = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const OOXML = 'http://schemas.openxmlformats.org';

function wordDocument(text) {
  return storedZip([
    ['[Content_Types].xml', `${XML}<Types xmlns="${OOXML}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="${OOXML}/package/2006/relationships"><Relationship Id="rId1" Type="${OOXML}/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', `${XML}<w:document xmlns:w="${OOXML}/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ]);
}

function signed(payload, secret) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`;
  return `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

// The page any connected file app serves to open a document: the Docs API from this server,
// and an editor config signed with the secret MOS generated for the two of them.
function editorPage({ ai, secret, url }) {
  const key = `mos-e2e-${Date.now().toString(36)}`;
  const config = {
    document: { fileType: 'docx', key, permissions: { edit: true }, title: 'MOS E2E AI.docx', url: ai.serve(`/editor/${key}.docx`, { body: wordDocument('A document to ask the AI about.') }) },
    documentType: 'word',
    editorConfig: { callbackUrl: ai.serve(`/editor/${key}/callback`, { body: '{"error":0}', type: 'application/json' }), lang: 'en', mode: 'edit', user: { id: 'mos-e2e', name: 'MOS E2E' } },
    height: '100%',
    width: '100%',
  };
  const api = new URL('/web-apps/apps/api/documents/api.js', url).toString();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>MOS E2E editor</title><style>html,body,#editor{height:100%;margin:0}</style></head>
<body><div id="editor"></div><script src="${api}"></script>
<script>new DocsAPI.DocEditor('editor', ${JSON.stringify({ ...config, token: signed(config, secret) })});</script></body></html>`;
  return ai.serve(`/editor/${key}.html`, { body: html, type: 'text/html; charset=utf-8' });
}

async function frameMatching(page, pattern, message) {
  await expect.poll(() => page.frames().some((frame) => pattern.test(frame.url())), { message, timeout: 90000 }).toBe(true);
  return page.frames().find((frame) => pattern.test(frame.url()));
}

export default {
  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/ONLYOFFICE/iu, { timeout: 120000 });
  },

  async journey({ page, url }) {
    await documentServerAnswers(page, url);
  },

  // A question asked in the AI chat of an open document. The editor sends it to the Document
  // Server's /ai-proxy, which relays it to the AI service with the key the browser never sees.
  async aiService({ ai, page, serverEnv, shot, step, url }) {
    await documentServerAnswers(page, url);
    const secret = await serverEnv('JWT_SECRET');
    if (!secret) throw new Error('The ONLYOFFICE container runs without JWT_SECRET, so no editor config can be signed for it.');
    const editor = await page.context().newPage();
    try {
      const frame = await step('open a document in the editor', async () => {
        await editor.goto(editorPage({ ai, secret, url }), { waitUntil: 'domcontentloaded' });
        const main = await frameMatching(editor, /documenteditor\/main/u, 'the document editor should load');
        await main.locator('#editor_sdk').waitFor({ timeout: 90000 });
        return main;
      });
      const question = `MOS E2E question ${Date.now().toString(36)}`;
      await step('ask the AI chat a question', async () => {
        await frame.locator('li.ribtab > a').filter({ hasText: /^\s*AI\s*$/u }).click({ timeout: 90000 });
        await frame.getByText('Chatbot', { exact: true }).filter({ visible: true }).first().click();
        const chat = await frameMatching(editor, /\/chat\.html/u, 'the AI chat window should open');
        await chat.locator('#input_message').fill(question);
        await chat.locator('#input_message').press('Enter');
        await expect(chat.locator('#chat'), "the chat shows the model's answer").toContainText(ai.reply, { timeout: 90000 });
        await shot('ai-chat', { page: editor });
      });
      const asked = ai.received().filter((request) => request.kind === 'chat' && JSON.stringify(request.body).includes(question));
      expect(asked.length, 'the question reached the AI service').toBeGreaterThan(0);
      expect(asked.every((request) => !request.fromBrowser), 'it came from the Document Server, not straight from the browser').toBe(true);
    } finally {
      await editor.close();
    }
  },

  async verify({ page, url }) {
    await documentServerAnswers(page, url);
  },
};
