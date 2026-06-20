const http = require('node:http');
const https = require('node:https');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function externalOrigin(request) {
  const protocol = String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${protocol}://${request.headers.host}`;
}

function upstreamRequestHeaders(request, { upstreamHost = request.headers.host, upgrade = false } = {}) {
  const headers = { ...request.headers };

  delete headers.cookie;
  for (const name of HOP_BY_HOP_HEADERS) {
    delete headers[name];
  }

  headers.host = upstreamHost;
  headers['x-forwarded-host'] = request.headers.host;
  headers['x-forwarded-proto'] = String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();

  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress) {
    const existing = request.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = existing ? `${existing}, ${remoteAddress}` : remoteAddress;
  }

  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = request.headers.upgrade;
  }

  return headers;
}

function responseHeaders(upstreamHeaders, request, upstreamUrl) {
  const headers = { ...upstreamHeaders };

  for (const name of HOP_BY_HOP_HEADERS) {
    delete headers[name];
  }
  delete headers['set-cookie'];

  const location = headers.location;
  if (typeof location === 'string') {
    try {
      const resolved = new URL(location, upstreamUrl);
      if (resolved.origin === upstreamUrl.origin) {
        headers.location = `${externalOrigin(request)}${resolved.pathname}${resolved.search}${resolved.hash}`;
      }
    } catch {
      // Preserve malformed or non-URL Location values exactly as Homepage returned them.
    }
  }

  return headers;
}

function upgradeResponseHeaders(upstreamHeaders) {
  const headers = { ...upstreamHeaders };
  delete headers['set-cookie'];
  return headers;
}

function writeSocketResponse(socket, statusCode, statusText, headers = {}) {
  const lines = [`HTTP/1.1 ${statusCode} ${statusText}`];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`${name}: ${item}`);
      }
    } else if (value !== undefined) {
      lines.push(`${name}: ${value}`);
    }
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
}

function createHomepageProxy({ upstream, upstreamHost }) {
  const upstreamUrl = new URL(upstream);
  const transport = upstreamUrl.protocol === 'https:' ? https : http;

  function requestOptions(request, { upgrade = false } = {}) {
    return {
      headers: upstreamRequestHeaders(request, { upstreamHost, upgrade }),
      hostname: upstreamUrl.hostname,
      method: request.method,
      path: request.url,
      port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
      protocol: upstreamUrl.protocol,
    };
  }

  function proxyHttp(request, response) {
    const upstreamRequest = transport.request(requestOptions(request), (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode || 502,
        responseHeaders(upstreamResponse.headers, request, upstreamUrl),
      );
      upstreamResponse.pipe(response);
    });

    upstreamRequest.on('error', () => {
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      response.end(`${JSON.stringify({ error: 'Homepage is unavailable.' })}\n`);
    });

    request.pipe(upstreamRequest);
  }

  function proxyUpgrade(request, socket, head) {
    const upstreamRequest = transport.request(requestOptions(request, { upgrade: true }));

    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      writeSocketResponse(
        socket,
        upstreamResponse.statusCode || 101,
        upstreamResponse.statusMessage || 'Switching Protocols',
        upgradeResponseHeaders(upstreamResponse.headers),
      );
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    upstreamRequest.on('response', (upstreamResponse) => {
      writeSocketResponse(
        socket,
        upstreamResponse.statusCode || 502,
        upstreamResponse.statusMessage || 'Bad Gateway',
        responseHeaders(upstreamResponse.headers, request, upstreamUrl),
      );
      upstreamResponse.pipe(socket);
    });

    upstreamRequest.on('error', () => {
      writeSocketResponse(socket, 502, 'Bad Gateway', { Connection: 'close' });
      socket.end();
    });

    upstreamRequest.end();
  }

  return { proxyHttp, proxyUpgrade };
}

module.exports = {
  createHomepageProxy,
  upstreamRequestHeaders,
};
