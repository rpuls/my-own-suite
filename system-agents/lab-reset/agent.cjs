#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const socketPath = process.env.MOS_V2_LAB_RESET_AGENT_SOCKET || '/run/mos-v2-lab-reset-agent/agent.sock';
const workerPath = path.join(__dirname, 'worker.cjs');

function respond(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { reject(new Error('INVALID_JSON')); }
    });
    request.on('error', reject);
  });
}

function scheduleReset(input = {}) {
  if (Object.keys(input).sort().join(',') !== 'reason' || typeof input.reason !== 'string' || input.reason.length > 120) {
    const error = new Error('Only a short reset reason is accepted.');
    error.statusCode = 400;
    error.code = 'INVALID_LAB_RESET_REQUEST';
    throw error;
  }

  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
  return { scheduled: true };
}

const server = http.createServer(async (request, response) => {
  try {
    const key = `${request.method} ${new URL(request.url || '/', 'http://localhost').pathname}`;
    if (key === 'GET /v1/status') {
      respond(response, 200, { capabilities: ['lab.reset'], service: 'mos-v2-lab-reset-agent' });
      return;
    }
    if (key === 'POST /v1/lab/reset') {
      respond(response, 202, scheduleReset(await readBody(request)));
      return;
    }
    respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' });
  } catch (error) {
    respond(response, error.statusCode || 502, {
      code: error.code || 'LAB_RESET_FAILED',
      error: error.statusCode ? error.message : 'The lab reset operation failed.',
    });
  }
});

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o660); process.stdout.write('[mos-v2-lab-reset-agent] ready\n'); });
function shutdown() { server.close(() => { fs.rmSync(socketPath, { force: true }); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
