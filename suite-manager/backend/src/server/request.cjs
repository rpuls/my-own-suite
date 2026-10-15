const { CodedError } = require('../../../../shared/coded-error.cjs');

function isHttpsRequest(request) {
  return String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function normalizedHost(request) {
  return String(request.headers.host || '').toLowerCase().replace(/:\d+$/, '');
}

// Installed apps are served on sibling subdomains, which browsers count as the
// same site, so a SameSite=Lax session alone would let an app's page act as the owner.
function isCrossOriginWrite(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false;
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;
  const { origin } = request.headers;
  return Boolean(origin) && !isOriginOfHost(origin, request.headers.host);
}

function isOriginOfHost(origin, hostHeader) {
  try {
    const { host, protocol } = new URL(origin);
    return host === new URL(`${protocol}//${hostHeader}`).host;
  } catch {
    return false;
  }
}

function readJsonBody(request, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    // The rest of an oversized body is read and dropped rather than the socket
    // cut, so the caller receives the 413 instead of a connection reset.
    request.on('data', (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > maxBytes) {
        tooLarge = true;
        raw = '';
        reject(new CodedError('REQUEST_BODY_TOO_LARGE', 'Request body is too large.', { statusCode: 413 }));
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new CodedError('REQUEST_BODY_INVALID', 'Request body must be valid JSON.', { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

module.exports = {
  isCrossOriginWrite,
  isHttpsRequest,
  normalizedHost,
  readJsonBody,
};
