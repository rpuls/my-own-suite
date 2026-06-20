const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { SetupError, SetupService } = require('../setup/setup-service.cjs');
const { createHomepageProxy } = require('./homepage-proxy.cjs');

const SESSION_COOKIE = 'mos_v2_session';
const DEFAULT_FRONTEND_DIST_DIR = path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');
const SUITE_MANAGER_BASE_PATH = '/suite-manager/';
const SUITE_MANAGER_API_PREFIX = `${SUITE_MANAGER_BASE_PATH}api`;
const FRONTEND_ASSET_PREFIX = `${SUITE_MANAGER_BASE_PATH}assets/`;

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

function htmlResponse(response, statusCode, html) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
  });
  response.end(html);
}

function textResponse(response, statusCode, text) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(text);
}

function fileResponse(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(response);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator === -1) {
          return [part, ''];
        }
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function errorStatus(error) {
  if (!(error instanceof SetupError)) {
    return 500;
  }

  if (error.code === 'OWNER_ALREADY_EXISTS') {
    return 409;
  }

  if (error.code === 'INVALID_LOGIN' || error.code === 'OWNER_NOT_CREATED') {
    return 401;
  }

  return 400;
}

function resolveStaticPath(rootDir, requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const rootPath = path.resolve(rootDir);
  const filePath = path.resolve(rootDir, normalizedPath.replace(/^[/\\]+/, ''));
  const relativePath = path.relative(rootPath, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return filePath;
}

function readFrontendHtml(frontendDistDir) {
  const indexPath = path.join(frontendDistDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  return fs.readFileSync(indexPath, 'utf8');
}

function normalizedHost(request) {
  return String(request.headers.host || '').toLowerCase().replace(/:\d+$/, '');
}

function isSignedIn(setup, sessionToken) {
  return setup.status(sessionToken).status === 'signed-in';
}

function serveFrontendAsset(response, frontendDistDir, pathname) {
  const relativePath = pathname.slice(FRONTEND_ASSET_PREFIX.length);
  const staticPath = resolveStaticPath(frontendDistDir, relativePath);
  if (!staticPath || !fs.existsSync(staticPath) || !fs.statSync(staticPath).isFile()) {
    return false;
  }

  fileResponse(response, staticPath);
  return true;
}

function serveFrontend(response, frontendDistDir) {
  const html = readFrontendHtml(frontendDistDir);
  if (html) {
    htmlResponse(response, 200, html);
    return;
  }

  textResponse(response, 503, 'Suite Manager frontend is not built yet. Run npm --prefix version-2 run build:client.');
}

function createV2Server({
  frontendDistDir = DEFAULT_FRONTEND_DIST_DIR,
  homeHost = process.env.MOS_V2_HOME_HOST || 'home.localhost',
  homepageUpstream = process.env.MOS_V2_HOMEPAGE_UPSTREAM || 'http://127.0.0.1:3200',
  stateDir = path.join(process.cwd(), '.state'),
} = {}) {
  const setup = new SetupService({ stateDir });
  const homepage = createHomepageProxy({ upstream: homepageUpstream });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const requestHost = normalizedHost(request);
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || '';

    try {
      if (requestHost !== homeHost) {
        jsonResponse(response, 421, { error: 'Unknown MOS host.' });
        return;
      }

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/setup/status`) {
        jsonResponse(response, 200, setup.status(sessionToken));
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/setup/owner`) {
        const body = await readJsonBody(request);
        const result = setup.createOwner(body);
        jsonResponse(response, 201, { owner: result.owner, status: result.status }, {
          'Set-Cookie': sessionCookie(result.sessionToken),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/auth/login`) {
        const body = await readJsonBody(request);
        const result = setup.login(body);
        jsonResponse(response, 200, { owner: result.owner, status: result.status }, {
          'Set-Cookie': sessionCookie(result.sessionToken),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/auth/logout`) {
        const result = setup.logout(sessionToken);
        jsonResponse(response, 200, result, {
          'Set-Cookie': clearSessionCookie(),
        });
        return;
      }

      if (url.pathname === SUITE_MANAGER_API_PREFIX || url.pathname.startsWith(`${SUITE_MANAGER_API_PREFIX}/`)) {
        jsonResponse(response, 404, { error: 'Not found.' });
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith(FRONTEND_ASSET_PREFIX)) {
        if (serveFrontendAsset(response, frontendDistDir, url.pathname)) {
          return;
        }
        jsonResponse(response, 404, { error: 'Not found.' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/suite-manager') {
        response.writeHead(308, { Location: SUITE_MANAGER_BASE_PATH });
        response.end();
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith(SUITE_MANAGER_BASE_PATH)) {
        serveFrontend(response, frontendDistDir);
        return;
      }

      if (url.pathname.startsWith(SUITE_MANAGER_BASE_PATH)) {
        jsonResponse(response, 404, { error: 'Not found.' });
        return;
      }

      if (!isSignedIn(setup, sessionToken)) {
        response.writeHead(302, { Location: SUITE_MANAGER_BASE_PATH });
        response.end();
        return;
      }

      homepage.proxyHttp(request, response);
    } catch (error) {
      jsonResponse(response, errorStatus(error), {
        code: error.code || 'INTERNAL_ERROR',
        error: error.message || 'Internal server error.',
      });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const requestHost = normalizedHost(request);
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || '';

    if (requestHost !== homeHost || !isSignedIn(setup, sessionToken)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }

    if (url.pathname === '/suite-manager' || url.pathname.startsWith(SUITE_MANAGER_BASE_PATH)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    homepage.proxyUpgrade(request, socket, head);
  });

  return server;
}

module.exports = {
  SESSION_COOKIE,
  createV2Server,
};
