const http = require('node:http');

// What the HTTPS agent answered, or why it could not be asked. `details` is
// the agent's own explanation of a failure — the failing command's last output,
// what Cloudflare replied — already masked of the token before it left root.
class HttpsAgentError extends Error {
  constructor(code, message, { details = [], statusCode = 502 } = {}) {
    super(message);
    this.name = 'HttpsAgentError';
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

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
          reject(new HttpsAgentError(
            typeof parsed.code === 'string' ? parsed.code : 'HTTPS_AGENT_REJECTED',
            typeof parsed.error === 'string' ? parsed.error : 'The HTTPS system agent rejected the request.',
            { details: Array.isArray(parsed.details) ? parsed.details.filter((detail) => typeof detail === 'string') : [], statusCode: response.statusCode },
          ));
        });
      });
      request.on('error', (cause) => reject(cause instanceof HttpsAgentError ? cause : new HttpsAgentError('HTTPS_AGENT_UNAVAILABLE', 'The HTTPS system agent did not answer.', { statusCode: 503 })));
      request.on('timeout', () => request.destroy(new HttpsAgentError('HTTPS_AGENT_TIMEOUT', 'The HTTPS system agent did not finish in time.', { statusCode: 504 })));
      if (payload) request.write(payload);
      request.end();
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  apply(input) { return this.request('POST', '/v1/https/apply', input); }
  commit(rollbackId) { return this.request('POST', '/v1/https/commit', { rollbackId }); }
  rollback(rollbackId) { return this.request('POST', '/v1/https/rollback', { rollbackId }); }
}

module.exports = { HttpsAgentClient, HttpsAgentError };
