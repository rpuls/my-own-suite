#!/usr/bin/env node

const { routeTable, serveOnSocket } = require('../lib/agent-server.cjs');
const { AppAgentCore, AppRuntimeError } = require('./agent-core.cjs');
const { AppApplyError, SystemAppAdapter } = require('./system-adapter.cjs');

const socketPath = process.env.MOS_APP_AGENT_SOCKET || '/run/mos-app-agent/agent.sock';
const adapter = new SystemAppAdapter();
const core = new AppAgentCore(adapter);

const server = routeTable({
  'GET /v1/status': () => core.status(),
  'POST /v1/apps/apply': (body) => core.apply(body),
  'POST /v1/apps/address': (body) => core.waitForAddress(body),
  'POST /v1/apps/check-health': (body) => core.checkHealth(body),
  'POST /v1/apps/connect-network': (body) => core.connectNetwork(body),
  'POST /v1/apps/snapshot': (body) => core.snapshotPackage(body),
  'POST /v1/apps/snapshot-external': (body) => core.snapshotExternalPackage(body),
  'POST /v1/apps/update/stage': (body) => core.stagePackageUpdate(body),
  'POST /v1/apps/update/build': (body) => core.buildPackageUpdate(body),
  'POST /v1/apps/update/activate': (body) => core.activatePackageUpdate(body),
  'POST /v1/apps/update/rollback': (body) => core.rollbackPackageUpdate(body),
  'POST /v1/apps/update/promote': (body) => core.promotePackageUpdate(body),
  'POST /v1/apps/stop': (body) => core.stop(body),
  'POST /v1/apps/remove': (body) => core.remove(body),
}, {
  bodyLimit: 64 * 1024,
  failure(error) {
    const known = error instanceof AppRuntimeError || error instanceof AppApplyError;
    return {
      payload: {
        code: known ? error.code : 'APP_RUNTIME_APPLY_FAILED',
        details: Array.isArray(error.details) ? error.details : [],
        error: known ? error.message : 'The app runtime operation failed.',
      },
      statusCode: known ? error.statusCode : 502,
    };
  },
});

// Repair any promotion a crash interrupted before accepting requests, so no
// operation can ever observe an instance with its installed snapshot missing.
adapter.sweepInterruptedPromotions()
  .then((repaired) => { if (repaired) process.stdout.write(`[mos-app-agent] repaired ${repaired} interrupted snapshot promotion(s)\n`); })
  .catch(() => {})
  .then(() => serveOnSocket(server, { name: 'mos-app-agent', socketPath }));
