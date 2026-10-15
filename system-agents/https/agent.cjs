#!/usr/bin/env node

const { HttpsSettingsError } = require('../../shared/https-contract.cjs');
const { routeTable, serveOnSocket } = require('../lib/agent-server.cjs');
const { HttpsAgentCore, HttpsAgentError } = require('./agent-core.cjs');
const { SystemHttpsAdapter } = require('./system-adapter.cjs');

const socketPath = process.env.MOS_HTTPS_AGENT_SOCKET || '/run/mos-https-agent/agent.sock';
const core = new HttpsAgentCore(new SystemHttpsAdapter());

const server = routeTable({
  'GET /v1/status': () => core.status(),
  'POST /v1/https/ensure': () => core.ensure(),
  'GET /v1/https/easy-door': () => core.easyDoorStatus(),
  'POST /v1/https/apply': (body) => core.apply(body),
  'POST /v1/https/commit': (body) => core.commit(body.rollbackId),
  'POST /v1/https/rollback': (body) => core.rollback(body.rollbackId),
  'POST /v1/https/discard-parked': () => core.discardParkedCredential(),
}, {
  bodyLimit: 16 * 1024,
  // Only an error the agent authored is worth repeating: its message is a
  // fixed sentence and its details were masked before they got here.
  failure(error) {
    const known = error instanceof HttpsAgentError || error instanceof HttpsSettingsError;
    return {
      payload: {
        code: known ? error.code : 'HTTPS_AGENT_REQUEST_FAILED',
        details: known && Array.isArray(error.details) ? error.details : [],
        error: known ? error.message : 'The HTTPS operation could not be completed.',
      },
      statusCode: known ? error.statusCode : 400,
    };
  },
});

serveOnSocket(server, { name: 'mos-https-agent', socketPath });
