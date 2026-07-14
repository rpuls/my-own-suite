const http = require('node:http');

const APP_AGENT_TIMEOUT_MS = 180_000;
const APP_AGENT_UPDATE_BUILD_TIMEOUT_MS = 30 * 60_000;

class AppAgentClient {
  constructor({ socketPath = process.env.MOS_V2_APP_AGENT_SOCKET || '/run/mos-v2-app-agent/agent.sock', timeoutMs = APP_AGENT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, requestPath, body, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const request = http.request({
        headers: payload ? { 'Content-Length': Buffer.byteLength(payload), 'Content-Type': 'application/json' } : {},
        method,
        path: requestPath,
        socketPath: this.socketPath,
        timeout: timeoutMs,
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
          const error = new Error(parsed.error || 'App runtime agent rejected the operation.');
          error.code = parsed.code || 'APP_AGENT_REJECTED';
          error.details = parsed.details || [];
          error.statusCode = response.statusCode;
          reject(error);
        });
      });
      request.on('error', (cause) => {
        const timedOut = cause?.message === 'APP_AGENT_TIMEOUT';
        const error = new Error(timedOut ? 'App runtime apply timed out.' : 'App runtime system agent is unavailable.');
        error.code = timedOut ? 'APP_AGENT_TIMEOUT' : 'APP_AGENT_UNAVAILABLE';
        error.statusCode = 503;
        reject(error);
      });
      request.on('timeout', () => request.destroy(new Error('APP_AGENT_TIMEOUT')));
      if (payload) request.write(payload);
      request.end();
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  apply(input) { return this.request('POST', '/v1/apps/apply', input); }
  checkHealth(input) { return this.request('POST', '/v1/apps/check-health', input); }
  connectNetwork(input) { return this.request('POST', '/v1/apps/connect-network', input); }
  snapshotPackage(input) { return this.request('POST', '/v1/apps/snapshot', input); }
  stagePackageUpdate(input) { return this.request('POST', '/v1/apps/update/stage', input); }
  buildPackageUpdate(input) { return this.request('POST', '/v1/apps/update/build', input, { timeoutMs: APP_AGENT_UPDATE_BUILD_TIMEOUT_MS }); }
  activatePackageUpdate(input) { return this.request('POST', '/v1/apps/update/activate', input); }
  promotePackageUpdate(input) { return this.request('POST', '/v1/apps/update/promote', input); }
  stop(input) { return this.request('POST', '/v1/apps/stop', input); }
  remove(input) { return this.request('POST', '/v1/apps/remove', input); }
}

module.exports = { APP_AGENT_TIMEOUT_MS, APP_AGENT_UPDATE_BUILD_TIMEOUT_MS, AppAgentClient };
