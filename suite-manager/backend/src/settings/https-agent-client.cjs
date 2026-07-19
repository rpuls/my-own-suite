const http = require('node:http');

class HttpsAgentClient {
  constructor({ socketPath = process.env.MOS_HTTPS_AGENT_SOCKET || '/run/mos-https-agent/agent.sock', timeoutMs = 120000 } = {}) {
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
          reject(new Error('HTTPS_AGENT_REJECTED'));
        });
      });
      request.on('error', () => reject(new Error('HTTPS_AGENT_UNAVAILABLE')));
      request.on('timeout', () => request.destroy(new Error('HTTPS_AGENT_TIMEOUT')));
      if (payload) request.write(payload);
      request.end();
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  apply(input) { return this.request('POST', '/v1/https/apply', input); }
  commit(rollbackId) { return this.request('POST', '/v1/https/commit', { rollbackId }); }
  rollback(rollbackId) { return this.request('POST', '/v1/https/rollback', { rollbackId }); }
}

module.exports = { HttpsAgentClient };
