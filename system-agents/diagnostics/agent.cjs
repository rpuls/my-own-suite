#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { DiagnosticsAgentCore } = require('./agent-core.cjs');
const { SystemDiagnosticsAdapter } = require('./system-adapter.cjs');

const socketPath = process.env.MOS_DIAGNOSTICS_AGENT_SOCKET || '/run/mos-diagnostics-agent/agent.sock';
const core = new DiagnosticsAgentCore(new SystemDiagnosticsAdapter());

function respond(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

// A collection is expensive and an owner can click twice. One in flight at a
// time, with the second caller joining the first rather than starting a
// competing sweep of the same machine.
let inFlight = null;

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  try {
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      respond(response, 200, await core.status());
      return;
    }
    // No request body is read, here or anywhere in this agent. The collector
    // list is compiled in; a caller cannot name a unit, a container, a path or
    // a line count, so there is no input to validate and none to get wrong.
    if (request.method === 'POST' && url.pathname === '/v1/diagnostics/collect') {
      if (!inFlight) inFlight = core.collect().finally(() => { inFlight = null; });
      respond(response, 200, await inFlight);
      return;
    }
    respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' });
  } catch {
    respond(response, 500, { code: 'DIAGNOSTICS_AGENT_FAILED', error: 'Diagnostics could not be collected.' });
  }
});

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.rmSync(socketPath, { force: true });
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o660);
  process.stdout.write('[mos-diagnostics-agent] ready\n');
});

function shutdown() {
  server.close(() => {
    fs.rmSync(socketPath, { force: true });
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
