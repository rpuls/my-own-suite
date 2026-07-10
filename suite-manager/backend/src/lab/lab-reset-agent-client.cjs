const http = require('node:http');

const LAB_RESET_AGENT_TIMEOUT_MS = 10_000;

class LabResetAgentClient {
  constructor({ socketPath = process.env.MOS_V2_LAB_RESET_AGENT_SOCKET || '/run/mos-v2-lab-reset-agent/agent.sock', timeoutMs = LAB_RESET_AGENT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, requestPath, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const request = http.request({
        headers: payload ? { 'Content-Length': Buffer.byteLength(payload), 'Content-Type': 'application/json' } : {},
        method,
        path: requestPath,
        socketPath: this.socketPath,
        timeout: this.timeoutMs,
      }, (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => {
          let parsed = {};
          try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch {}
          if (response.statusCode >= 200 && response.statusCode < 300) { resolve(parsed); return; }
          const error = new Error(parsed.error || 'Lab reset agent rejected the operation.');
          error.code = parsed.code || 'LAB_RESET_AGENT_REJECTED';
          error.statusCode = response.statusCode;
          reject(error);
        });
      });
      request.on('error', (cause) => {
        const timedOut = cause?.message === 'LAB_RESET_AGENT_TIMEOUT';
        const error = new Error(timedOut ? 'Lab reset scheduling timed out.' : 'Lab reset system agent is unavailable.');
        error.code = timedOut ? 'LAB_RESET_AGENT_TIMEOUT' : 'LAB_RESET_AGENT_UNAVAILABLE';
        error.statusCode = 503;
        reject(error);
      });
      request.on('timeout', () => request.destroy(new Error('LAB_RESET_AGENT_TIMEOUT')));
      if (payload) request.write(payload);
      request.end();
    });
  }

  reset(input) { return this.request('POST', '/v1/lab/reset', input); }
}

module.exports = { LAB_RESET_AGENT_TIMEOUT_MS, LabResetAgentClient };
