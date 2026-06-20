const http = require('node:http');

class HomepageAgentClient {
  constructor({ socketPath = process.env.MOS_V2_HOMEPAGE_AGENT_SOCKET || '/run/mos-v2-homepage-agent/agent.sock', timeoutMs = 120000 } = {}) {
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
          const error = new Error(parsed.error || 'Homepage agent rejected the operation.');
          error.code = parsed.code || 'HOMEPAGE_AGENT_REJECTED';
          error.details = parsed.details || [];
          error.statusCode = response.statusCode;
          reject(error);
        });
      });
      request.on('error', () => { const error = new Error('Homepage system agent is unavailable.'); error.code = 'HOMEPAGE_AGENT_UNAVAILABLE'; error.statusCode = 503; reject(error); });
      request.on('timeout', () => request.destroy(new Error('HOMEPAGE_AGENT_TIMEOUT')));
      if (payload) request.write(payload);
      request.end();
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  read(file) { return this.request('POST', '/v1/homepage/read', { file }); }
  validate(file, content) { return this.request('POST', '/v1/homepage/validate', { content, file }); }
  apply(input) { return this.request('POST', '/v1/homepage/apply', input); }
  addLink(input) { return this.request('POST', '/v1/homepage/add-link', input); }
  addHomeService(input) { return this.request('POST', '/v1/homepage/add-home-service', input); }
}

module.exports = { HomepageAgentClient };
