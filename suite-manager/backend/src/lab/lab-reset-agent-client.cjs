const { requestAgent } = require('../agent-request.cjs');

const LAB_RESET_AGENT_TIMEOUT_MS = 10_000;

class LabResetAgentClient {
  constructor({ socketPath = process.env.MOS_LAB_RESET_AGENT_SOCKET || '/run/mos-lab-reset-agent/agent.sock', timeoutMs = LAB_RESET_AGENT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(method, requestPath, body) {
    const answer = await requestAgent({ body, method, path: requestPath, socketPath: this.socketPath, timeoutMs: this.timeoutMs }).catch(({ timedOut }) => {
      throw Object.assign(new Error(timedOut ? 'Lab reset scheduling timed out.' : 'Lab reset system agent is unavailable.'), {
        code: timedOut ? 'LAB_RESET_AGENT_TIMEOUT' : 'LAB_RESET_AGENT_UNAVAILABLE',
        statusCode: 503,
      });
    });
    if (answer.ok) return answer.body;
    throw Object.assign(new Error(answer.body.error || 'Lab reset agent rejected the operation.'), {
      code: answer.body.code || 'LAB_RESET_AGENT_REJECTED',
      statusCode: answer.statusCode,
    });
  }

  reset(input) { return this.request('POST', '/v1/lab/reset', input); }

  resetStatus(resetId) { return this.request('GET', `/v1/lab/reset/${encodeURIComponent(resetId)}`); }
}

module.exports = { LabResetAgentClient };
