const { requestAgent } = require('../agent-request.cjs');

const APP_AGENT_TIMEOUT_MS = 180_000;
// The agent can build up to eight services sequentially, with five minutes
// allowed for each build. Keep the caller alive for that full worst case plus
// a small allowance for request and agent bookkeeping.
const APP_AGENT_UPDATE_BUILD_TIMEOUT_MS = 45 * 60_000;
// Apply builds too, then waits up to the agent's 15 minutes for the app to answer.
// Hanging up first does not stop the agent — it strands an app whose containers
// are running with its projections still unapplied.
const APP_AGENT_APPLY_TIMEOUT_MS = 65 * 60_000;
// Two of the agent's 15-minute health waits: the new version's, then the old one's if it never answers.
const APP_AGENT_ACTIVATE_TIMEOUT_MS = 35 * 60_000;
// The agent gives an app's address five minutes before it reports it still waiting.
const APP_AGENT_ADDRESS_TIMEOUT_MS = 6 * 60_000;

class AppAgentClient {
  constructor({ socketPath = process.env.MOS_APP_AGENT_SOCKET || '/run/mos-app-agent/agent.sock', timeoutMs = APP_AGENT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(method, requestPath, body, { timeoutMs = this.timeoutMs } = {}) {
    const answer = await requestAgent({ body, method, path: requestPath, socketPath: this.socketPath, timeoutMs }).catch(({ timedOut }) => {
      throw Object.assign(new Error(timedOut ? 'App runtime apply timed out.' : 'App runtime system agent is unavailable.'), {
        code: timedOut ? 'APP_AGENT_TIMEOUT' : 'APP_AGENT_UNAVAILABLE',
        statusCode: 503,
      });
    });
    if (answer.ok) return answer.body;
    throw Object.assign(new Error(answer.body.error || 'App runtime agent rejected the operation.'), {
      code: answer.body.code || 'APP_AGENT_REJECTED',
      details: answer.body.details || [],
      statusCode: answer.statusCode,
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  apply(input) { return this.request('POST', '/v1/apps/apply', input, { timeoutMs: APP_AGENT_APPLY_TIMEOUT_MS }); }
  waitForAddress(input) { return this.request('POST', '/v1/apps/address', input, { timeoutMs: APP_AGENT_ADDRESS_TIMEOUT_MS }); }
  checkHealth(input) { return this.request('POST', '/v1/apps/check-health', input); }
  connectNetwork(input) { return this.request('POST', '/v1/apps/connect-network', input); }
  snapshotPackage(input) { return this.request('POST', '/v1/apps/snapshot', input); }
  snapshotExternalPackage(input) { return this.request('POST', '/v1/apps/snapshot-external', input); }
  stagePackageUpdate(input) { return this.request('POST', '/v1/apps/update/stage', input); }
  buildPackageUpdate(input) { return this.request('POST', '/v1/apps/update/build', input, { timeoutMs: APP_AGENT_UPDATE_BUILD_TIMEOUT_MS }); }
  activatePackageUpdate(input) { return this.request('POST', '/v1/apps/update/activate', input, { timeoutMs: APP_AGENT_ACTIVATE_TIMEOUT_MS }); }
  rollbackPackageUpdate(input) { return this.request('POST', '/v1/apps/update/rollback', input, { timeoutMs: APP_AGENT_ACTIVATE_TIMEOUT_MS }); }
  promotePackageUpdate(input) { return this.request('POST', '/v1/apps/update/promote', input); }
  stop(input) { return this.request('POST', '/v1/apps/stop', input); }
  remove(input) { return this.request('POST', '/v1/apps/remove', input); }
}

module.exports = { APP_AGENT_ADDRESS_TIMEOUT_MS, APP_AGENT_APPLY_TIMEOUT_MS, APP_AGENT_TIMEOUT_MS, APP_AGENT_UPDATE_BUILD_TIMEOUT_MS, AppAgentClient };
