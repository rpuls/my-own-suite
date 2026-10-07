const assert = require('node:assert/strict');
const test = require('node:test');

const { routeTable } = require('../src/server/routes/index.cjs');
const { fakeServices, withRoutes } = require('./support/route-harness.cjs');

const routes = routeTable(fakeServices());

function samplePath(route) {
  if (route.path !== undefined) return route.path;
  const sample = route.pattern.source
    .replace(/^\^/u, '')
    .replace(/\$$/u, '')
    .replaceAll('([^/]+)', 'sample')
    .replaceAll('(\\d{1,3})', '1')
    .replaceAll('(?:\\/|$)', '/')
    .replaceAll('\\/', '/');
  assert.match(sample, route.pattern, `no sample path for ${route.pattern}`);
  return sample;
}

function describe(route) {
  return `${route.method || 'ANY'} ${route.path ?? route.pattern}`;
}

test('every route that needs a session answers 401 with its own sentence when signed out', async () => {
  await withRoutes({}, async (call) => {
    for (const route of routes.filter((entry) => entry.signIn)) {
      const method = route.method || 'GET';
      const answer = await call(method, samplePath(route), { body: method === 'GET' ? undefined : {}, signedIn: false });
      assert.equal(answer.status, 401, describe(route));
      assert.deepEqual(answer.json(), { code: 'AUTH_REQUIRED', error: route.signIn }, describe(route));
    }
  });
});

// An installed app's page is same-site with Suite Manager, so the browser sends
// the owner's cookie with it; text/plain is what an attacker would use to skip a preflight.
test('every API write from another origin is refused before its route runs', async () => {
  await withRoutes({}, async (call) => {
    for (const route of routes.filter((entry) => entry.method !== 'GET')) {
      const answer = await call(route.method || 'POST', samplePath(route), {
        body: '{}',
        headers: { 'Content-Type': 'text/plain', Origin: 'http://vaultwarden.home.test' },
      });
      assert.equal(answer.status, 403, describe(route));
      assert.equal(answer.json().code, 'CROSS_ORIGIN_REJECTED', describe(route));
    }
  });
});
