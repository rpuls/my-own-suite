const http = require('node:http');

// One JSON request to a host agent over its unix socket. Resolves with whatever
// the agent answered; rejects only when it did not answer, with `timedOut`
// telling a slow agent from an absent one. Each client words its own errors.
function requestAgent({ body = null, method, path, socketPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const request = http.request({
      headers: payload === null ? {} : { 'Content-Length': Buffer.byteLength(payload), 'Content-Type': 'application/json' },
      method,
      path,
      socketPath,
      timeout: timeoutMs,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let parsed = {};
        try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch {}
        resolve({ body: parsed, ok: response.statusCode >= 200 && response.statusCode < 300, statusCode: response.statusCode });
      });
    });
    let timedOut = false;
    request.on('timeout', () => {
      timedOut = true;
      request.destroy(new Error('The agent did not answer in time.'));
    });
    request.on('error', () => reject(Object.assign(new Error('The agent did not answer.'), { timedOut })));
    if (payload !== null) request.write(payload);
    request.end();
  });
}

module.exports = { requestAgent };
