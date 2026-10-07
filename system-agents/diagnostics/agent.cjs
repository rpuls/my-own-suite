#!/usr/bin/env node

const http = require('node:http');

const { respond, serveOnSocket } = require('../lib/agent-server.cjs');
const { DiagnosticsAgentCore } = require('./agent-core.cjs');
const { SystemDiagnosticsAdapter } = require('./system-adapter.cjs');

const socketPath = process.env.MOS_DIAGNOSTICS_AGENT_SOCKET || '/run/mos-diagnostics-agent/agent.sock';
const core = new DiagnosticsAgentCore(new SystemDiagnosticsAdapter());

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
    // The host's own patch state. A fixed source like every other one in this
    // agent: the caller names nothing, so this is a read of four files and two
    // commands decided in system-adapter.cjs, not a question a web app gets to ask.
    if (request.method === 'GET' && url.pathname === '/v1/host/patches') {
      respond(response, 200, await core.hostPatches());
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

serveOnSocket(server, { name: 'mos-diagnostics-agent', socketPath });
