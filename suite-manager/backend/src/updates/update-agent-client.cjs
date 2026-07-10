const http = require('node:http');

const UPDATE_AGENT_TIMEOUT_MS = 30_000;

class UpdateAgentClient {
  constructor({ socketPath = process.env.MOS_V2_UPDATE_AGENT_SOCKET || '/run/mos-v2-update-agent/agent.sock', timeoutMs = UPDATE_AGENT_TIMEOUT_MS } = {}) {
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
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed);
            return;
          }
          const error = new Error(parsed.error || 'Update agent rejected the operation.');
          error.code = parsed.code || 'UPDATE_AGENT_REJECTED';
          error.statusCode = response.statusCode;
          reject(error);
        });
      });
      request.on('error', () => {
        const error = new Error('Update system agent is unavailable.');
        error.code = 'UPDATE_AGENT_UNAVAILABLE';
        error.statusCode = 503;
        reject(error);
      });
      request.on('timeout', () => request.destroy(new Error('UPDATE_AGENT_TIMEOUT')));
      if (payload) request.write(payload);
      request.end();
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  startUpdate(input) { return this.request('POST', '/v1/jobs', input); }
  configureTrack(input) { return this.request('POST', '/v1/track', input); }
}

module.exports = { UPDATE_AGENT_TIMEOUT_MS, UpdateAgentClient };
