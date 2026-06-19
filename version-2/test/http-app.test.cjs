const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createV2Server } = require('../src/server/http-app.cjs');

async function tempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mos-v2-http-'));
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function withServer(fn) {
  const server = createV2Server({ stateDir: await tempStateDir() });
  const baseUrl = await listen(server);

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('first visit renders owner creation page', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Create your MOS owner account/);
    assert.match(html, /name="email"/);
    assert.match(html, /name="password"/);
  });
});

test('owner creation API signs in and changes setup status', async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/setup/owner`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        name: 'Suite Owner',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const created = await createResponse.json();
    const cookie = createResponse.headers.get('set-cookie');

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, 'signed-in');
    assert.match(cookie, /mos_v2_session=/);

    const statusResponse = await fetch(`${baseUrl}/api/setup/status`, {
      headers: { Cookie: cookie },
    });
    const status = await statusResponse.json();

    assert.equal(status.status, 'signed-in');
    assert.equal(status.owner.email, 'owner@example.com');
  });
});

test('duplicate owner creation returns conflict', async () => {
  await withServer(async (baseUrl) => {
    const owner = {
      email: 'owner@example.com',
      name: 'Suite Owner',
      password: 'correct horse battery',
    };

    await fetch(`${baseUrl}/api/setup/owner`, {
      body: JSON.stringify(owner),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const duplicateResponse = await fetch(`${baseUrl}/api/setup/owner`, {
      body: JSON.stringify(owner),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const duplicate = await duplicateResponse.json();

    assert.equal(duplicateResponse.status, 409);
    assert.equal(duplicate.code, 'OWNER_ALREADY_EXISTS');
  });
});
