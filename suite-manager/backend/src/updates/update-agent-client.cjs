const { requestAgent } = require('../agent-request.cjs');

const UPDATE_AGENT_TIMEOUT_MS = 30_000;

class UpdateAgentClient {
  constructor({ socketPath = process.env.MOS_UPDATE_AGENT_SOCKET || '/run/mos-update-agent/agent.sock', timeoutMs = UPDATE_AGENT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(method, requestPath, body) {
    const answer = await requestAgent({ body, method, path: requestPath, socketPath: this.socketPath, timeoutMs: this.timeoutMs }).catch(() => {
      throw Object.assign(new Error('Update system agent is unavailable.'), {
        code: 'UPDATE_AGENT_UNAVAILABLE',
        statusCode: 503,
      });
    });
    if (answer.ok) return answer.body;
    throw Object.assign(new Error(answer.body.error || 'Update agent rejected the operation.'), {
      code: answer.body.code || 'UPDATE_AGENT_REJECTED',
      statusCode: answer.statusCode,
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  // The current job alone. A full status runs an update check against the
  // origin, which is far more than a caller asking "is an update running" wants
  // to pay for or wait on.
  summary() { return this.request('GET', '/v1/summary'); }
  startUpdate(input) { return this.request('POST', '/v1/jobs', input); }
  cancelUpdate(id) { return this.request('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, {}); }
  skipBackup(id) { return this.request('POST', `/v1/jobs/${encodeURIComponent(id)}/skip-backup`, {}); }
  configureTrack(input) { return this.request('POST', '/v1/track', input); }
  // The restart a patched kernel needs, and the packages the signed advisory
  // feed says not to install. Both are privileged writes to the host, which is
  // why they go through this agent and not the read-only diagnostics one.
  restartHost() { return this.request('POST', '/v1/host/restart', {}); }
  applyHostHolds(input) { return this.request('POST', '/v1/host/holds', input); }
}

module.exports = { UpdateAgentClient };
