const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { requestAgent } = require('../src/agent-request.cjs');

function socketPathFor(name) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mos-agent-request-${process.pid}-${name}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-agent-request-')), `${name}.sock`);
}

async function serve(t, name, handler) {
  const socketPath = socketPathFor(name);
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  return socketPath;
}

test('an agent\'s answer comes back with its status, whatever the status', async (t) => {
  const socketPath = await serve(t, 'answers', (request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const refused = request.url === '/refuse';
      response.writeHead(refused ? 409 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(refused ? { code: 'NO', error: 'No.' } : { echoed: raw ? JSON.parse(raw) : null, method: request.method }));
    });
  });

  assert.deepEqual(await requestAgent({ method: 'GET', path: '/v1/status', socketPath, timeoutMs: 5000 }), { body: { echoed: null, method: 'GET' }, ok: true, statusCode: 200 });
  assert.deepEqual(await requestAgent({ body: { a: 1 }, method: 'POST', path: '/v1/do', socketPath, timeoutMs: 5000 }), { body: { echoed: { a: 1 }, method: 'POST' }, ok: true, statusCode: 200 });
  assert.deepEqual(await requestAgent({ body: {}, method: 'POST', path: '/refuse', socketPath, timeoutMs: 5000 }), { body: { code: 'NO', error: 'No.' }, ok: false, statusCode: 409 });
});

test('an agent that is not there and one that is too slow are told apart', async (t) => {
  await assert.rejects(
    requestAgent({ method: 'GET', path: '/v1/status', socketPath: socketPathFor('absent'), timeoutMs: 5000 }),
    (error) => error.timedOut === false,
  );
  const socketPath = await serve(t, 'slow', () => {});
  await assert.rejects(
    requestAgent({ method: 'GET', path: '/v1/status', socketPath, timeoutMs: 100 }),
    (error) => error.timedOut === true,
  );
});
