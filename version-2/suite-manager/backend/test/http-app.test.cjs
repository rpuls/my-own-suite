const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createV2Server } = require('../src/server/http-app.cjs');

async function tempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mos-v2-http-'));
}

async function tempFrontendDistDir() {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-v2-frontend-'));
  await fs.mkdir(path.join(distDir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(distDir, 'brand'), { recursive: true });
  await fs.writeFile(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><title>Suite Manager | My Own Suite</title><script type="module" src="./assets/index.js"></script></head><body><div id="root"></div></body></html>',
  );
  await fs.writeFile(path.join(distDir, 'assets', 'index.js'), 'console.log("mos v2 app");\n');
  await fs.writeFile(path.join(distDir, 'brand', 'my-own-suite-mark.png'), 'fake image');
  return distDir;
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
  const server = createV2Server({
    frontendDistDir: await tempFrontendDistDir(),
    stateDir: await tempStateDir(),
  });
  const baseUrl = await listen(server);

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('first visit serves the built Suite Manager frontend', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Suite Manager \| My Own Suite/);
    assert.match(html, /id="root"/);
  });
});

test('static frontend assets are served from the built app', async () => {
  await withServer(async (baseUrl) => {
    const scriptResponse = await fetch(`${baseUrl}/assets/index.js`);
    const script = await scriptResponse.text();
    const brandResponse = await fetch(`${baseUrl}/brand/my-own-suite-mark.png`);

    assert.equal(scriptResponse.status, 200);
    assert.match(script, /mos v2 app/);
    assert.equal(scriptResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(brandResponse.status, 200);
    assert.equal(brandResponse.headers.get('content-type'), 'image/png');
  });
});

test('empty setup status requires owner creation', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/setup/status`);
    const status = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(status, {
      owner: null,
      status: 'needs-owner',
    });
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

test('existing-owner signed-out state never returns setup again', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/setup/owner`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        name: 'Suite Owner',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const statusResponse = await fetch(`${baseUrl}/api/setup/status`);
    const status = await statusResponse.json();

    assert.equal(statusResponse.status, 200);
    assert.equal(status.status, 'signed-out');
    assert.equal(status.owner.email, 'owner@example.com');
  });
});

test('login and logout transition session state', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/setup/owner`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        name: 'Suite Owner',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const login = await loginResponse.json();
    const cookie = loginResponse.headers.get('set-cookie');

    assert.equal(loginResponse.status, 200);
    assert.equal(login.status, 'signed-in');
    assert.match(cookie, /mos_v2_session=/);

    const signedInResponse = await fetch(`${baseUrl}/api/setup/status`, {
      headers: { Cookie: cookie },
    });
    const signedIn = await signedInResponse.json();

    assert.equal(signedIn.status, 'signed-in');

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      headers: { Cookie: cookie },
      method: 'POST',
    });
    const logout = await logoutResponse.json();

    assert.equal(logoutResponse.status, 200);
    assert.equal(logout.status, 'signed-out');
    assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);
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
