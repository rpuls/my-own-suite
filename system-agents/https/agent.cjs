#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { HttpsAgentCore, HttpsAgentError } = require('./agent-core.cjs');
const { SystemHttpsAdapter } = require('./system-adapter.cjs');
const { HttpsSettingsError } = require('../../shared/https-contract.cjs');

const socketPath = process.env.MOS_HTTPS_AGENT_SOCKET || '/run/mos-https-agent/agent.sock';
const core = new HttpsAgentCore(new SystemHttpsAdapter());

function respond(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 16 * 1024) reject(new Error('BODY_TOO_LARGE'));
    });
    request.on('end', () => {
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); }
      catch { reject(new Error('INVALID_JSON')); }
    });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  try {
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      respond(response, 200, await core.status());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/https/apply') {
      respond(response, 200, await core.apply(await readBody(request)));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/https/commit') {
      const body = await readBody(request);
      respond(response, 200, await core.commit(body.rollbackId));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/https/rollback') {
      const body = await readBody(request);
      respond(response, 200, await core.rollback(body.rollbackId));
      return;
    }
    respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' });
  } catch (error) {
    // Only an error the agent authored is worth repeating: its message is a
    // fixed sentence and its details were masked before they got here.
    const known = error instanceof HttpsAgentError || error instanceof HttpsSettingsError;
    respond(response, known ? error.statusCode : 400, {
      code: known ? error.code : 'HTTPS_AGENT_REQUEST_FAILED',
      details: known && Array.isArray(error.details) ? error.details : [],
      error: known ? error.message : 'The HTTPS operation could not be completed.',
    });
  }
});

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o660);
  process.stdout.write('[mos-https-agent] ready\n');
});

function shutdown() {
  server.close(() => {
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
