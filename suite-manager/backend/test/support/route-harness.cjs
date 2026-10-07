const http = require('node:http');

const { createRequestHandler } = require('../../src/server/http-app.cjs');

const HOST = 'home.test';
const OWNER = { email: 'owner@example.com', name: 'Suite Owner' };
const OWNER_SESSION = 'owner-session';

// The least of the services graph the request handler needs around a route:
// one allowed host, and a session that is signed in when the cookie carries it.
function fakeServices({ setup = {}, ...services } = {}) {
  return {
    addressService: { allowedHosts: () => new Set([HOST]), httpsRedirectFor: () => null },
    appUrls: { hostFor: () => null, publicUrlOf: () => ({}), publicUrls: () => () => ({}) },
    logger: { error() {}, info() {}, warn() {} },
    ...services,
    setup: { status: (token) => (token === OWNER_SESSION ? { owner: OWNER, status: 'signed-in' } : { owner: null, status: 'needs-login' }), ...setup },
  };
}

function send(port, method, routePath, { body, headers = {}, signedIn = true }) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // A fresh connection each time: a route may answer before it reads the body.
    const request = http.request({
      agent: false,
      headers: {
        Host: HOST,
        ...(signedIn ? { Cookie: `mos_session=${OWNER_SESSION}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      host: '127.0.0.1',
      method,
      path: `/suite-manager/api${routePath}`,
      port,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ body: text, headers: response.headers, json: () => JSON.parse(text), status: response.statusCode });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

// Calls `fn` with `call(method, routePath, { body, headers, signedIn })`.
async function withRoutes(services, fn) {
  const server = http.createServer(createRequestHandler(fakeServices(services)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn((method, routePath, options = {}) => send(server.address().port, method, routePath, options));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { fakeServices, withRoutes };
