'use strict';

const { requestAgent } = require('../agent-request.cjs');

// A collection sweeps every MOS unit and container. Generous, because the
// machine it runs on is by definition not well.
const DIAGNOSTICS_TIMEOUT_MS = 120_000;
// The host patch read is two commands and four files, and it sits on a screen an
// owner is watching. It must not inherit the budget a full collection needs.
const HOST_PATCHES_TIMEOUT_MS = 20_000;

class DiagnosticsAgentClient {
  constructor({ socketPath = process.env.MOS_DIAGNOSTICS_AGENT_SOCKET || '/run/mos-diagnostics-agent/agent.sock', timeoutMs = DIAGNOSTICS_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(method, requestPath, timeoutMs = this.timeoutMs) {
    const answer = await requestAgent({ method, path: requestPath, socketPath: this.socketPath, timeoutMs }).catch(() => {
      throw Object.assign(new Error('The diagnostics system agent is unavailable.'), {
        code: 'DIAGNOSTICS_AGENT_UNAVAILABLE',
      });
    });
    if (answer.ok) return answer.body;
    throw Object.assign(new Error(answer.body.error || 'The diagnostics agent rejected the request.'), {
      code: answer.body.code || 'DIAGNOSTICS_AGENT_REJECTED',
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  collect() { return this.request('POST', '/v1/diagnostics/collect'); }
  // Cheap next to collect(): two commands and four files, so the Updates screen
  // can poll it without sweeping the machine.
  hostPatches() { return this.request('GET', '/v1/host/patches', HOST_PATCHES_TIMEOUT_MS); }
}

module.exports = { DiagnosticsAgentClient, HOST_PATCHES_TIMEOUT_MS };
