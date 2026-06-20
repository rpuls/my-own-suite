const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
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

async function withServer(fn, options = {}) {
  const server = createV2Server({
    frontendDistDir: await tempFrontendDistDir(),
    homeHost: '127.0.0.1',
    stateDir: await tempStateDir(),
    ...options,
  });
  const baseUrl = await listen(server);

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function hostRequest(baseUrl, requestPath, { body = '', headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const request = http.request({
      headers,
      hostname: url.hostname,
      method,
      path: requestPath,
      port: url.port,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          body: responseBody,
          headers: response.headers,
          json: () => JSON.parse(responseBody),
          status: response.statusCode,
        });
      });
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
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

test('static frontend assets are served from the reserved asset namespace', async () => {
  await withServer(async (baseUrl) => {
    const scriptResponse = await fetch(`${baseUrl}/suite-manager/assets/assets/index.js`);
    const script = await scriptResponse.text();
    const brandResponse = await fetch(`${baseUrl}/suite-manager/assets/brand/my-own-suite-mark.png`);

    assert.equal(scriptResponse.status, 200);
    assert.match(script, /mos v2 app/);
    assert.equal(scriptResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(brandResponse.status, 200);
    assert.equal(brandResponse.headers.get('content-type'), 'image/png');
  });
});

async function createOwner(baseUrl, host = 'home.test') {
  const response = await hostRequest(baseUrl, '/suite-manager/api/setup/owner', {
    body: JSON.stringify({
      email: 'owner@example.com',
      name: 'Suite Owner',
      password: 'correct horse battery',
    }),
    headers: { 'Content-Type': 'application/json', Host: host },
    method: 'POST',
  });
  return response.headers['set-cookie'][0];
}

test('Home serves Suite Manager but blocks its dashboard until authentication', async () => {
  await withServer(async (baseUrl) => {
    const setupResponse = await hostRequest(baseUrl, '/suite-manager/', { headers: { Host: 'home.test' } });
    const dashboardResponse = await hostRequest(baseUrl, '/', {
      headers: { Host: 'home.test' },
    });

    assert.equal(setupResponse.status, 200);
    assert.equal(dashboardResponse.status, 302);
    assert.equal(dashboardResponse.headers.location, '/suite-manager/');
  }, { homeHost: 'home.test' });
});

test('authenticated Home requests stream through the private Homepage proxy without the MOS cookie', async () => {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ body, headers: request.headers, method: request.method, url: request.url });
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'homepage=value' });
      response.write('first-');
      response.end('second');
    });
  });
  const upstreamUrl = await listen(upstream);

  try {
    await withServer(async (baseUrl) => {
      const cookie = await createOwner(baseUrl);
      const suiteManagerStatus = await hostRequest(baseUrl, '/suite-manager/api/setup/status', {
        headers: { Cookie: cookie, Host: 'home.test' },
      });
      const response = await hostRequest(baseUrl, '/api/data?view=empty', {
        body: 'dashboard request',
        headers: { Cookie: cookie, Host: 'home.test', Origin: 'http://home.test' },
        method: 'POST',
      });

      assert.equal(suiteManagerStatus.json().status, 'signed-in');
      assert.equal(response.status, 200);
      assert.equal(response.body, 'first-second');
      assert.equal(response.headers['set-cookie'], undefined);
      assert.deepEqual(seen.map(({ body, method, url }) => ({ body, method, url })), [{
        body: 'dashboard request',
        method: 'POST',
        url: '/api/data?view=empty',
      }]);
      assert.equal(seen[0].headers.cookie, undefined);
      assert.equal(seen[0].headers.host, 'home.test');
      assert.equal(seen[0].headers['x-forwarded-host'], 'home.test');
    }, { homeHost: 'home.test', homepageUpstream: upstreamUrl });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('Homepage redirects are rewritten to the public Home origin', async () => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(307, { Location: `http://${request.socket.localAddress}:${request.socket.localPort}/next?ok=1` });
    response.end();
  });
  const upstreamUrl = await listen(upstream);

  try {
    await withServer(async (baseUrl) => {
      const cookie = await createOwner(baseUrl);
      const response = await hostRequest(baseUrl, '/redirect', {
        headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      });

      assert.equal(response.status, 307);
      assert.equal(response.headers.location, 'https://home.test/next?ok=1');
    }, { homeHost: 'home.test', homepageUpstream: upstreamUrl });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('Suite Manager path and unknown hosts cannot bypass the Homepage boundary', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((request, response) => {
    upstreamRequests += 1;
    response.end('homepage');
  });
  const upstreamUrl = await listen(upstream);

  try {
    await withServer(async (baseUrl) => {
      const cookie = await createOwner(baseUrl);
      const suiteResponse = await hostRequest(baseUrl, '/suite-manager/', { headers: { Host: 'home.test' } });
      const unknownSuiteResponse = await hostRequest(baseUrl, '/suite-manager/unknown', {
        headers: { Cookie: cookie, Host: 'home.test' },
        method: 'POST',
      });
      const unknownResponse = await hostRequest(baseUrl, '/', { headers: { Host: 'bypass.test' } });

      assert.equal(suiteResponse.status, 200);
      assert.match(suiteResponse.body, /Suite Manager/);
      assert.equal(unknownSuiteResponse.status, 404);
      assert.equal(unknownResponse.status, 421);
      assert.equal(upstreamRequests, 0);
    }, {
      homeHost: 'home.test',
      homepageUpstream: upstreamUrl,
    });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('logout immediately blocks Home dashboard access again', async () => {
  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/auth/logout', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const response = await hostRequest(baseUrl, '/', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.location, '/suite-manager/');
  }, { homeHost: 'home.test' });
});

test('Homepage failure returns a controlled bad gateway response', async () => {
  const unavailable = http.createServer();
  const unavailableUrl = await listen(unavailable);
  await new Promise((resolve) => unavailable.close(resolve));

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const response = await hostRequest(baseUrl, '/', { headers: { Cookie: cookie, Host: 'home.test' } });

    assert.equal(response.status, 502);
    assert.deepEqual(response.json(), { error: 'Homepage is unavailable.' });
  }, { homeHost: 'home.test', homepageUpstream: unavailableUrl });
});

function websocketExchange(baseUrl, cookie = '', requestPath = '/socket') {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const socket = net.connect(Number(url.port), url.hostname);
    let received = '';
    let sentPayload = false;

    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        'Host: home.test',
        'Connection: Upgrade',
        'Upgrade: websocket',
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (!sentPayload && received.includes('101 Switching Protocols')) {
        sentPayload = true;
        socket.write('dashboard-socket-payload');
      }
      if (
        received.includes('dashboard-socket-payload')
        || received.includes('401 Unauthorized')
        || received.includes('404 Not Found')
      ) {
        socket.end();
      }
    });
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
    socket.on('timeout', () => socket.destroy(new Error('Timed out waiting for WebSocket proxy.')));
  });
}

test('WebSocket upgrades require a valid Home session and tunnel when authenticated', async () => {
  const upstream = http.createServer();
  upstream.on('upgrade', (request, socket) => {
    assert.equal(request.headers.cookie, undefined);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: homepage=value\r\n\r\n');
    socket.pipe(socket);
  });
  const upstreamUrl = await listen(upstream);

  try {
    await withServer(async (baseUrl) => {
      const denied = await websocketExchange(baseUrl);
      const cookie = await createOwner(baseUrl);
      const suiteManagerDenied = await websocketExchange(baseUrl, cookie, '/suite-manager/socket');
      const allowed = await websocketExchange(baseUrl, cookie);

      assert.match(denied, /401 Unauthorized/);
      assert.match(suiteManagerDenied, /404 Not Found/);
      assert.match(allowed, /101 Switching Protocols/);
      assert.match(allowed, /dashboard-socket-payload/);
      assert.doesNotMatch(allowed, /Set-Cookie/i);
    }, { homeHost: 'home.test', homepageUpstream: upstreamUrl });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('empty setup status requires owner creation', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/suite-manager/api/setup/status`);
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
    const createResponse = await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
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

    const statusResponse = await fetch(`${baseUrl}/suite-manager/api/setup/status`, {
      headers: { Cookie: cookie },
    });
    const status = await statusResponse.json();

    assert.equal(status.status, 'signed-in');
    assert.equal(status.owner.email, 'owner@example.com');
  });
});

test('existing-owner signed-out state never returns setup again', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        name: 'Suite Owner',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const statusResponse = await fetch(`${baseUrl}/suite-manager/api/setup/status`);
    const status = await statusResponse.json();

    assert.equal(statusResponse.status, 200);
    assert.equal(status.status, 'signed-out');
    assert.equal(status.owner.email, 'owner@example.com');
  });
});

test('login and logout transition session state', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        name: 'Suite Owner',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const loginResponse = await fetch(`${baseUrl}/suite-manager/api/auth/login`, {
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

    const signedInResponse = await fetch(`${baseUrl}/suite-manager/api/setup/status`, {
      headers: { Cookie: cookie },
    });
    const signedIn = await signedInResponse.json();

    assert.equal(signedIn.status, 'signed-in');

    const logoutResponse = await fetch(`${baseUrl}/suite-manager/api/auth/logout`, {
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

    await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify(owner),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const duplicateResponse = await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify(owner),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const duplicate = await duplicateResponse.json();

    assert.equal(duplicateResponse.status, 409);
    assert.equal(duplicate.code, 'OWNER_ALREADY_EXISTS');
  });
});
