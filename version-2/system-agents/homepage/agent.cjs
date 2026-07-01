#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { HomepageConfigError } = require('../../shared/homepage-contract.cjs');
const { HomepageAgentCore } = require('./agent-core.cjs');
const { HomepageApplyError, SystemHomepageAdapter } = require('./system-adapter.cjs');

const socketPath = process.env.MOS_V2_HOMEPAGE_AGENT_SOCKET || '/run/mos-v2-homepage-agent/agent.sock';
const core = new HomepageAgentCore(new SystemHomepageAdapter());

function respond(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 600 * 1024) reject(new Error('BODY_TOO_LARGE')); });
    request.on('end', () => { try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { reject(new Error('INVALID_JSON')); } });
    request.on('error', reject);
  });
}

const routes = new Map([
  ['GET /v1/status', () => core.status()],
  ['POST /v1/homepage/read', (body) => core.read(body)],
  ['POST /v1/homepage/validate', (body) => core.validate(body)],
  ['POST /v1/homepage/apply', (body) => core.apply(body)],
  ['POST /v1/homepage/add-link', (body) => core.add(body, false)],
  ['POST /v1/homepage/add-home-service', (body) => core.add(body, true)],
  ['POST /v1/homepage/remove-link', (body) => core.removeLink(body)],
]);

const server = http.createServer(async (request, response) => {
  try {
    const key = `${request.method} ${new URL(request.url || '/', 'http://localhost').pathname}`;
    const handler = routes.get(key);
    if (!handler) { respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' }); return; }
    respond(response, 200, await handler(request.method === 'GET' ? {} : await readBody(request)));
  } catch (error) {
    const known = error instanceof HomepageConfigError || error instanceof HomepageApplyError;
    respond(response, known ? error.statusCode : 502, {
      code: known ? error.code : 'HOMEPAGE_APPLY_FAILED',
      details: Array.isArray(error.details) ? error.details : [],
      error: known ? error.message : 'The Homepage operation failed; the previous configuration remains active.',
    });
  }
});

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o660); process.stdout.write('[mos-v2-homepage-agent] ready\n'); });
function shutdown() { server.close(() => { fs.rmSync(socketPath, { force: true }); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
