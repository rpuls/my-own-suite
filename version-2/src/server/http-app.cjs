const http = require('node:http');
const path = require('node:path');

const { SetupError, SetupService } = require('../setup/setup-service.cjs');

const SESSION_COOKIE = 'mos_v2_session';

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

function setupPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Set up My Own Suite</title>
  </head>
  <body>
    <main>
      <h1>Create your MOS owner account</h1>
      <form method="post" action="/api/setup/owner">
        <label>Name <input autocomplete="name" name="name" required></label>
        <label>Email <input autocomplete="email" name="email" required type="email"></label>
        <label>Password <input autocomplete="new-password" minlength="12" name="password" required type="password"></label>
        <button type="submit">Create owner</button>
      </form>
    </main>
  </body>
</html>
`;
}

function dashboardPage(owner) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>My Own Suite</title>
  </head>
  <body>
    <main>
      <h1>My Own Suite</h1>
      <p>Signed in as ${owner.name}.</p>
    </main>
  </body>
</html>
`;
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

function createV2Server({ stateDir = path.join(process.cwd(), '.state') } = {}) {
  const setup = new SetupService({ stateDir });

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || '';

    try {
      if (request.method === 'GET' && url.pathname === '/') {
        const status = setup.status(sessionToken);
        if (status.status === 'needs-owner') {
          htmlResponse(response, 200, setupPage());
          return;
        }
        htmlResponse(response, 200, dashboardPage(status.owner));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/setup/status') {
        jsonResponse(response, 200, setup.status(sessionToken));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/setup/owner') {
        const body = await readJsonBody(request);
        const result = setup.createOwner(body);
        jsonResponse(response, 201, { owner: result.owner, status: result.status }, {
          'Set-Cookie': sessionCookie(result.sessionToken),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJsonBody(request);
        const result = setup.login(body);
        jsonResponse(response, 200, { owner: result.owner, status: result.status }, {
          'Set-Cookie': sessionCookie(result.sessionToken),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const result = setup.logout(sessionToken);
        jsonResponse(response, 200, result, {
          'Set-Cookie': clearSessionCookie(),
        });
        return;
      }

      jsonResponse(response, 404, { error: 'Not found.' });
    } catch (error) {
      jsonResponse(response, errorStatus(error), {
        code: error.code || 'INTERNAL_ERROR',
        error: error.message || 'Internal server error.',
      });
    }
  });
}

module.exports = {
  SESSION_COOKIE,
  createV2Server,
};
