const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { withHandler } = require('./support/route-harness.cjs');

function frontendDistDir() {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-frontend-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.mkdirSync(path.join(distDir, 'brand'));
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><title>Suite Manager | My Own Suite</title><script type="module" src="./assets/index.js"></script></head><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(path.join(distDir, 'assets', 'index.js'), 'console.log("mos app");\n');
  fs.writeFileSync(path.join(distDir, 'brand', 'my-own-suite-mark.png'), 'fake image');
  return distDir;
}

function countingHomepage() {
  const proxied = [];
  return { homepage: { proxyHttp: (request, response) => { proxied.push(request.url); response.end('homepage'); } }, proxied };
}

test('first visit serves the built Suite Manager frontend', async () => {
  await withHandler({ frontendDistDir: frontendDistDir() }, async (request) => {
    const home = await request('GET', '/', { signedIn: false });
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/suite-manager/');

    const page = await request('GET', '/suite-manager/', { signedIn: false });
    assert.equal(page.status, 200);
    assert.match(page.body, /Suite Manager \| My Own Suite/u);
    assert.match(page.body, /id="root"/u);
  });
});

// The build stamp is how a running frontend learns it was replaced, and a cached
// document would defeat that on its own.
test('the served document names its build, is never cached, and the API agrees', async () => {
  await withHandler({ frontendDistDir: frontendDistDir() }, async (request) => {
    const page = await request('GET', '/suite-manager/', { signedIn: false });
    const stamped = /<meta name="mos-build" content="([0-9a-f]{16})" \/>/u.exec(page.body);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.ok(stamped, 'the served document carries its build id');

    const build = await request('GET', '/suite-manager/api/build', { signedIn: false });
    assert.equal(build.status, 200);
    assert.equal(build.headers['cache-control'], 'no-store');
    assert.equal(build.json().id, stamped[1]);
  });
});

test('build output is cached forever and everything else is not', async () => {
  await withHandler({ frontendDistDir: frontendDistDir() }, async (request) => {
    // A content hash in the filename makes a new build a new URL; a brand mark keeps its name.
    assert.equal((await request('GET', '/suite-manager/assets/assets/index.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await request('GET', '/suite-manager/assets/brand/my-own-suite-mark.png')).headers['cache-control'], 'public, max-age=3600');
  });
});

test('static frontend assets are served from the reserved asset namespace', async () => {
  await withHandler({ frontendDistDir: frontendDistDir() }, async (request) => {
    const script = await request('GET', '/suite-manager/assets/assets/index.js', { signedIn: false });
    assert.equal(script.status, 200);
    assert.match(script.body, /mos app/u);
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');

    const brand = await request('GET', '/suite-manager/assets/brand/my-own-suite-mark.png', { signedIn: false });
    assert.equal(brand.status, 200);
    assert.equal(brand.headers['content-type'], 'image/png');

    assert.equal((await request('GET', '/suite-manager/assets/missing.js', { signedIn: false })).status, 404);
    assert.equal((await request('GET', '/suite-manager/assets/..%2F..%2Fpackage.json', { signedIn: false })).status, 404);
  });
});

test('Suite Manager paths and unknown hosts never reach Homepage, and a signed-in owner does', async () => {
  const { homepage, proxied } = countingHomepage();
  await withHandler({ frontendDistDir: frontendDistDir(), homepage }, async (request) => {
    assert.equal((await request('GET', '/suite-manager/')).status, 200);
    assert.equal((await request('POST', '/suite-manager/unknown')).status, 404);
    assert.equal((await request('GET', '/', { headers: { Host: 'bypass.test' } })).status, 421);
    assert.equal((await request('GET', '/', { signedIn: false })).status, 302);
    assert.deepEqual(proxied, []);

    assert.equal((await request('GET', '/api/widgets?view=empty')).body, 'homepage');
    assert.deepEqual(proxied, ['/api/widgets?view=empty']);
  });
});

test('the bare Suite Manager path redirects to its slash, and unknown API paths are not found', async () => {
  await withHandler({ frontendDistDir: frontendDistDir() }, async (request) => {
    const bare = await request('GET', '/suite-manager', { signedIn: false });
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.location, '/suite-manager/');

    for (const requestPath of ['/suite-manager/api', '/suite-manager/api/unknown']) {
      const missing = await request('GET', requestPath);
      assert.equal(missing.status, 404, requestPath);
      assert.deepEqual(missing.json(), { error: 'Not found.' });
    }
  });
});

// An installed app's page is same-site with Suite Manager, so the browser sends
// the owner's cookie with it.
test('a write from a sibling site, a null origin or another port is refused, and a same-origin write is not', async () => {
  const saved = [];
  const setup = { setPreference: (input) => { saved.push(input); return { technicalControls: true }; } };
  await withHandler({ setup }, async (request) => {
    const write = (headers) => request('POST', '/suite-manager/api/settings/preferences', {
      body: '{"key":"technicalControls","value":true}',
      headers: { 'Content-Type': 'text/plain', ...headers },
    });

    for (const headers of [{ 'Sec-Fetch-Site': 'same-site' }, { Origin: 'null' }, { Origin: 'http://home.test:8443' }]) {
      const refused = await write(headers);
      assert.equal(refused.status, 403, JSON.stringify(headers));
      assert.equal(refused.json().code, 'CROSS_ORIGIN_REJECTED');
    }
    assert.deepEqual(saved, []);

    assert.equal((await write({ Origin: 'http://home.test', 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal(saved.length, 1);
  });
});

// The target comes from the installed app the id names; nothing in the URL can steer it.
test('a dashboard tile goes to the app its instance names, signed in or not, and nowhere else', async () => {
  const instanceId = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const services = {
    appPackages: { installedPackageIdForInstance: (id) => (id === instanceId ? 'notes' : null) },
    appUrls: { hostFor: (id) => (id === 'notes' ? 'notes' : null), publicUrlOf: () => ({ publicUrl: 'https://notes.mos.example.com/' }), publicUrls: () => () => ({}) },
    frontendDistDir: frontendDistDir(),
  };
  await withHandler(services, async (request) => {
    const tile = await request('GET', `/suite-manager/open/${instanceId}`, { signedIn: false });
    assert.equal(tile.status, 302);
    assert.equal(tile.headers.location, 'https://notes.mos.example.com/');
    assert.equal(tile.headers['cache-control'], 'no-store');

    const unknown = await request('GET', '/suite-manager/open/00000000-0000-4000-8000-000000000000', { signedIn: false });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json().code, 'APP_NOT_INSTALLED');

    assert.equal((await request('GET', '/suite-manager/open/evil.example.com', { signedIn: false })).headers.location, undefined);
  });
});

test('pages move to HTTPS where the address asks for it, and the API answers where it is', async () => {
  const addressService = { allowedHosts: () => new Set(['home.test']), httpsRedirectFor: () => 'https://home.test' };
  await withHandler({ addressService, frontendDistDir: frontendDistDir() }, async (request) => {
    const page = await request('GET', '/suite-manager/setup?step=1', { signedIn: false });
    assert.equal(page.status, 308);
    assert.equal(page.headers.location, 'https://home.test/suite-manager/setup?step=1');
    assert.equal(page.headers['cache-control'], 'no-store');

    assert.equal((await request('GET', '/suite-manager/api/build', { signedIn: false })).status, 200);
    assert.equal((await request('GET', '/suite-manager/setup', { headers: { 'X-Forwarded-Proto': 'https' }, signedIn: false })).status, 200);
    assert.equal((await request('POST', '/suite-manager/setup', { signedIn: false })).status, 404);
  });
});
