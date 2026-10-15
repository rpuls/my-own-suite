'use strict';

// The unix-socket JSON server the host agents share. An agent brings its routes
// and how it answers a failure; reading, answering and the socket's life are here.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function respond(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(new Error('BODY_TOO_LARGE'));
    });
    request.on('end', () => {
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { reject(new Error('INVALID_JSON')); }
    });
    request.on('error', reject);
  });
}

function bodyReader(limit) {
  return (request) => readBody(request, limit);
}

// `routes` maps `METHOD /path` to a handler whose result is answered 200. A GET
// handler is given no body; `failure(error)` returns the `{ statusCode, payload }` to answer.
function routeTable(routes, { bodyLimit, failure }) {
  return http.createServer(async (request, response) => {
    try {
      const handler = routes[`${request.method} ${new URL(request.url || '/', 'http://localhost').pathname}`];
      if (!handler) {
        respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' });
        return;
      }
      respond(response, 200, await handler(request.method === 'GET' ? {} : await readBody(request, bodyLimit)));
    } catch (error) {
      const { payload, statusCode } = failure(error);
      respond(response, statusCode, payload);
    }
  });
}

// Group-writable so Suite Manager, in mos-agent, can connect.
function serveOnSocket(server, { name, onReady = () => {}, onShutdown = () => {}, socketPath }) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o660);
    process.stdout.write(`[${name}] ready\n`);
    onReady();
  });
  function shutdown() {
    onShutdown();
    server.close(() => {
      fs.rmSync(socketPath, { force: true });
      process.exit(0);
    });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { bodyReader, readBody, respond, routeTable, serveOnSocket };
