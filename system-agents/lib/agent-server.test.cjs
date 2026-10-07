const assert = require('node:assert/strict');
const test = require('node:test');

const { routeTable } = require('./agent-server.cjs');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { body, method });
    return { json: await response.json(), status: response.status };
  };
}

test('a route table answers its handlers, a 404 for anything else, and the agent\'s own failure shape', async (t) => {
  const server = routeTable({
    'GET /v1/status': (body) => ({ body, ok: true }),
    'POST /v1/echo': (body) => ({ echoed: body }),
    'POST /v1/refuse': () => { throw Object.assign(new Error('No.'), { code: 'REFUSED' }); },
  }, {
    bodyLimit: 64,
    failure: (error) => ({ payload: { code: error.code || error.message }, statusCode: 409 }),
  });
  t.after(() => server.close());
  const request = await listen(server);

  assert.deepEqual(await request('GET', '/v1/status'), { json: { body: {}, ok: true }, status: 200 });
  assert.deepEqual(await request('POST', '/v1/echo', '{"a":1}'), { json: { echoed: { a: 1 } }, status: 200 });
  assert.deepEqual(await request('POST', '/v1/echo', ''), { json: { echoed: {} }, status: 200 });
  assert.deepEqual(await request('POST', '/v1/refuse', '{}'), { json: { code: 'REFUSED' }, status: 409 });
  assert.deepEqual(await request('POST', '/v1/echo', '{"a":'), { json: { code: 'INVALID_JSON' }, status: 409 });
  assert.deepEqual(await request('POST', '/v1/echo', JSON.stringify({ a: 'x'.repeat(100) })), { json: { code: 'BODY_TOO_LARGE' }, status: 409 });
  assert.deepEqual(await request('GET', '/v1/elsewhere'), { json: { code: 'NOT_FOUND', error: 'Not found.' }, status: 404 });
});
