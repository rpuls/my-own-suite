const { requestAgent } = require('../agent-request.cjs');
const HOMEPAGE_AGENT_TIMEOUT_MS = 75_000;

class HomepageAgentClient {
  constructor({ socketPath = process.env.MOS_HOMEPAGE_AGENT_SOCKET || '/run/mos-homepage-agent/agent.sock', timeoutMs = HOMEPAGE_AGENT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(method, requestPath, body) {
    const answer = await requestAgent({ body, method, path: requestPath, socketPath: this.socketPath, timeoutMs: this.timeoutMs }).catch(({ timedOut }) => {
      throw Object.assign(new Error(timedOut ? 'Homepage apply timed out. The previous dashboard remains active.' : 'Homepage system agent is unavailable.'), {
        code: timedOut ? 'HOMEPAGE_AGENT_TIMEOUT' : 'HOMEPAGE_AGENT_UNAVAILABLE',
        statusCode: 503,
      });
    });
    if (answer.ok) return answer.body;
    throw Object.assign(new Error(answer.body.error || 'Homepage agent rejected the operation.'), {
      code: answer.body.code || 'HOMEPAGE_AGENT_REJECTED',
      details: answer.body.details || [],
      statusCode: answer.statusCode,
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  read(file) { return this.request('POST', '/v1/homepage/read', { file }); }
  validate(file, content) { return this.request('POST', '/v1/homepage/validate', { content, file }); }
  apply(input) { return this.request('POST', '/v1/homepage/apply', input); }
  addLink(input) { return this.request('POST', '/v1/homepage/add-link', input); }
  addHomeService(input) { return this.request('POST', '/v1/homepage/add-home-service', input); }
  removeLink(input) { return this.request('POST', '/v1/homepage/remove-link', input); }
  reconcileUrls(input) { return this.request('POST', '/v1/homepage/reconcile-urls', input); }
}

module.exports = { HOMEPAGE_AGENT_TIMEOUT_MS, HomepageAgentClient };
