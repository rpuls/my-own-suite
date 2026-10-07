const fs = require('node:fs');
const path = require('node:path');

const { requestId } = require('./logger.cjs');

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

function jsonResponse(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function htmlResponse(response, statusCode, html, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    ...headers,
  });
  response.end(html);
}

function textResponse(response, statusCode, text) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(text);
}

function fileResponse(response, filePath, headers = {}) {
  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
    ...headers,
  });
  fs.createReadStream(filePath).pipe(response);
}

// An internal error reaches the owner as one generic sentence, so its reason is
// logged under a reference the response also carries (docs/decisions.md, 2026-09-01).
// `requestPath` is the path without its query string, which carries claim tokens.
function respondError(response, error, { logger, method, requestPath }) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const internal = statusCode >= 500 && (error.internal === true || !Number.isInteger(error.statusCode));
  const reference = internal ? requestId() : null;
  if (internal) {
    logger.error('request-failed', { error, method, path: requestPath, reference, statusCode });
  }
  jsonResponse(response, statusCode, {
    code: error.code || 'INTERNAL_ERROR',
    ...(!internal && Array.isArray(error.details) && error.details.length ? { details: error.details } : {}),
    error: internal ? 'Internal server error.' : error.message || 'Internal server error.',
    ...(reference ? { reference } : {}),
  }, Number.isInteger(error.retryAfterSeconds)
    ? { 'Retry-After': String(error.retryAfterSeconds) }
    : {});
}

module.exports = {
  fileResponse,
  htmlResponse,
  jsonResponse,
  respondError,
  textResponse,
};
