#!/usr/bin/env node

const { HomepageConfigError } = require('../../shared/homepage-contract.cjs');
const { routeTable, serveOnSocket } = require('../lib/agent-server.cjs');
const { HomepageAgentCore } = require('./agent-core.cjs');
const { HomepageApplyError, SystemHomepageAdapter } = require('./system-adapter.cjs');

const socketPath = process.env.MOS_HOMEPAGE_AGENT_SOCKET || '/run/mos-homepage-agent/agent.sock';
const core = new HomepageAgentCore(new SystemHomepageAdapter());

const server = routeTable({
  'GET /v1/status': () => core.status(),
  'POST /v1/homepage/read': (body) => core.read(body),
  'POST /v1/homepage/validate': (body) => core.validate(body),
  'POST /v1/homepage/apply': (body) => core.apply(body),
  'POST /v1/homepage/add-link': (body) => core.add(body, false),
  'POST /v1/homepage/add-home-service': (body) => core.add(body, true),
  'POST /v1/homepage/remove-link': (body) => core.removeLink(body),
  'POST /v1/homepage/reconcile-urls': (body) => core.reconcileUrls(body),
}, {
  bodyLimit: 600 * 1024,
  failure(error) {
    const known = error instanceof HomepageConfigError || error instanceof HomepageApplyError;
    return {
      payload: {
        code: known ? error.code : 'HOMEPAGE_APPLY_FAILED',
        details: Array.isArray(error.details) ? error.details : [],
        error: known ? error.message : 'The Homepage operation failed; the previous configuration remains active.',
      },
      statusCode: known ? error.statusCode : 502,
    };
  },
});

serveOnSocket(server, { name: 'mos-homepage-agent', socketPath });
