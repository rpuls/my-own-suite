const { requestAgent } = require('../agent-request.cjs');

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
  // Long enough for the agent to restart Caddy and wait for the certificate to
  // be issued, which is part of an apply now rather than something that happens
  // after success has been reported.
  constructor({ socketPath = process.env.MOS_HTTPS_AGENT_SOCKET || '/run/mos-https-agent/agent.sock', timeoutMs = 300000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(method, requestPath, body) {
    const answer = await requestAgent({ body, method, path: requestPath, socketPath: this.socketPath, timeoutMs: this.timeoutMs }).catch(({ timedOut }) => {
      throw timedOut
        ? new HttpsAgentError('HTTPS_AGENT_TIMEOUT', 'The HTTPS system agent did not finish in time.', { statusCode: 504 })
        : new HttpsAgentError('HTTPS_AGENT_UNAVAILABLE', 'The HTTPS system agent did not answer.', { statusCode: 503 });
    });
    if (answer.ok) return answer.body;
    throw new HttpsAgentError(
      typeof answer.body.code === 'string' ? answer.body.code : 'HTTPS_AGENT_REJECTED',
      typeof answer.body.error === 'string' ? answer.body.error : 'The HTTPS system agent rejected the request.',
      { details: Array.isArray(answer.body.details) ? answer.body.details.filter((detail) => typeof detail === 'string') : [], statusCode: answer.statusCode },
    );
  }

  status() { return this.request('GET', '/v1/status'); }
  ensure() { return this.request('POST', '/v1/https/ensure'); }
  easyDoorStatus() { return this.request('GET', '/v1/https/easy-door'); }
  apply(input) { return this.request('POST', '/v1/https/apply', input); }
  commit(rollbackId) { return this.request('POST', '/v1/https/commit', { rollbackId }); }
  rollback(rollbackId) { return this.request('POST', '/v1/https/rollback', { rollbackId }); }
  discardParkedCredential() { return this.request('POST', '/v1/https/discard-parked'); }
}

module.exports = { HttpsAgentClient, HttpsAgentError };
