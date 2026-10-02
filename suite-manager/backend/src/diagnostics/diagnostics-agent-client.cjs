'use strict';

const http = require('node:http');

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

  request(method, requestPath, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const request = http.request({ method, path: requestPath, socketPath: this.socketPath, timeout: timeoutMs }, (response) => {
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
          const error = new Error(parsed.error || 'The diagnostics agent rejected the request.');
          error.code = parsed.code || 'DIAGNOSTICS_AGENT_REJECTED';
          reject(error);
        });
      });
      request.on('error', () => {
        const error = new Error('The diagnostics system agent is unavailable.');
        error.code = 'DIAGNOSTICS_AGENT_UNAVAILABLE';
        reject(error);
      });
      request.on('timeout', () => request.destroy(new Error('DIAGNOSTICS_AGENT_TIMEOUT')));
      request.end();
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  collect() { return this.request('POST', '/v1/diagnostics/collect'); }
  // Cheap next to collect(): two commands and four files, so the Updates screen
  // can poll it without sweeping the machine.
  hostPatches() { return this.request('GET', '/v1/host/patches', HOST_PATCHES_TIMEOUT_MS); }
}

module.exports = { DIAGNOSTICS_TIMEOUT_MS, DiagnosticsAgentClient, HOST_PATCHES_TIMEOUT_MS };
