#!/usr/bin/env node

const http = require('node:http');

const { respond, serveOnSocket } = require('../lib/agent-server.cjs');
const { DiagnosticsAgentCore } = require('./agent-core.cjs');
const { SystemDiagnosticsAdapter } = require('./system-adapter.cjs');

const socketPath = process.env.MOS_DIAGNOSTICS_AGENT_SOCKET || '/run/mos-diagnostics-agent/agent.sock';
const core = new DiagnosticsAgentCore(new SystemDiagnosticsAdapter());

// A collection is expensive and an owner can click twice. One in flight per
// question, with a second identical caller joining the first rather than
// starting a competing sweep of the same machine.
const inFlight = new Map();

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
    // No request body is read, here or anywhere in this agent. A caller may
    // pick collectors by name and one app by id; core.collect() refuses any
    // other name, so a unit, a container, a path or a line count is never input.
    if (request.method === 'POST' && url.pathname === '/v1/diagnostics/collect') {
      const only = url.searchParams.get('only');
      const question = { app: url.searchParams.get('app'), only: only ? only.split(',') : undefined };
      const key = `${question.only || '*'}|${question.app || ''}`;
      if (!inFlight.has(key)) inFlight.set(key, core.collect(question).finally(() => inFlight.delete(key)));
      respond(response, 200, await inFlight.get(key));
      return;
    }
    respond(response, 404, { code: 'NOT_FOUND', error: 'Not found.' });
  } catch (error) {
    if (/^DIAGNOSTICS_UNKNOWN_/u.test(error?.code || '')) {
      respond(response, 400, { code: error.code, error: error.message });
      return;
    }
    respond(response, 500, { code: 'DIAGNOSTICS_AGENT_FAILED', error: 'Diagnostics could not be collected.' });
  }
});

serveOnSocket(server, { name: 'mos-diagnostics-agent', socketPath });
