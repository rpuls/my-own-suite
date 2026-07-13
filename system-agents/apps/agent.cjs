#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { AppAgentCore, AppRuntimeError } = require('./agent-core.cjs');
const { AppApplyError, SystemAppAdapter } = require('./system-adapter.cjs');

const socketPath = process.env.MOS_V2_APP_AGENT_SOCKET || '/run/mos-v2-app-agent/agent.sock';
const core = new AppAgentCore(new SystemAppAdapter());

function respond(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 64 * 1024) reject(new Error('BODY_TOO_LARGE')); });
    request.on('end', () => { try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { reject(new Error('INVALID_JSON')); } });
    request.on('error', reject);
  });
}

const routes = new Map([
  ['GET /v1/status', () => core.status()],
  ['POST /v1/apps/apply', (body) => core.apply(body)],
  ['POST /v1/apps/check-health', (body) => core.checkHealth(body)],
  ['POST /v1/apps/connect-network', (body) => core.connectNetwork(body)],
  ['POST /v1/apps/snapshot', (body) => core.snapshotPackage(body)],
  ['POST /v1/apps/stop', (body) => core.stop(body)],
  ['POST /v1/apps/remove', (body) => core.remove(body)],
]);

const server = http.createServer(async (request, response) => {
  try {
    const key = `${request.method} ${new URL(request.url || '/', 'http://localhost').pathname}`;
    const handler = routes.get(key);
    if (!handler) { respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' }); return; }
    respond(response, 200, await handler(request.method === 'GET' ? {} : await readBody(request)));
  } catch (error) {
    const known = error instanceof AppRuntimeError || error instanceof AppApplyError;
    respond(response, known ? error.statusCode : 502, {
      code: known ? error.code : 'APP_RUNTIME_APPLY_FAILED',
      details: Array.isArray(error.details) ? error.details : [],
      error: known ? error.message : 'The app runtime operation failed.',
    });
  }
});

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o660); process.stdout.write('[mos-v2-app-agent] ready\n'); });
function shutdown() { server.close(() => { fs.rmSync(socketPath, { force: true }); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
