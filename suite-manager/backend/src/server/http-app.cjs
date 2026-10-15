const http = require('node:http');

const { MANAGED_APP_HREF_PREFIX } = require('../../../../shared/homepage-contract.cjs');
const { SESSION_COOKIE, parseCookies } = require('./cookies.cjs');
const { FRONTEND_ASSET_PREFIX, SUITE_MANAGER_BASE_PATH, serveFrontend, serveFrontendAsset, serveHomeIcon } = require('./frontend.cjs');
const { isCrossOriginWrite, isHttpsRequest, normalizedHost } = require('./request.cjs');
const { jsonResponse, respondError } = require('./responses.cjs');
const { createRouter } = require('./router.cjs');
const { routeTable } = require('./routes/index.cjs');

const SUITE_MANAGER_API_PREFIX = `${SUITE_MANAGER_BASE_PATH}api`;
const MANAGED_APP_HREF_PATTERN = new RegExp(`^${MANAGED_APP_HREF_PREFIX}([0-9a-f-]{36})$`, 'u');

function isSignedIn(setup, sessionToken) {
  return setup.status(sessionToken).status === 'signed-in';
}

function createRequestHandler(services) {
  const { addressService, appPackages, appUrls, frontendDistDir, homepage, logger, setup } = services;
  const dispatch = createRouter(routeTable(services), { isSignedIn: (sessionToken) => isSignedIn(setup, sessionToken) });

  return async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const requestHost = normalizedHost(request);
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || '';

    try {
      if (!addressService.allowedHosts().has(requestHost)) {
        jsonResponse(response, 421, { error: 'Unknown MOS host.' });
        return;
      }

      if (url.pathname.startsWith(SUITE_MANAGER_API_PREFIX) && isCrossOriginWrite(request)) {
        jsonResponse(response, 403, { code: 'CROSS_ORIGIN_REJECTED', error: 'Suite Manager only accepts changes made from its own pages.' });
        return;
      }

      const httpsOrigin = isHttpsRequest(request) ? null : addressService.httpsRedirectFor(requestHost);
      if (httpsOrigin && ['GET', 'HEAD'].includes(request.method) && !url.pathname.startsWith(SUITE_MANAGER_API_PREFIX)) {
        response.writeHead(308, { 'Cache-Control': 'no-store', Location: `${httpsOrigin}${request.url || '/'}` });
        response.end();
        return;
      }

      if (url.pathname.startsWith(SUITE_MANAGER_API_PREFIX)) {
        const context = { cookies, request, requestHost, response, secure: isHttpsRequest(request), sessionToken, url };
        if (await dispatch(url.pathname.slice(SUITE_MANAGER_API_PREFIX.length), context)) return;
      }

      if (url.pathname === SUITE_MANAGER_API_PREFIX || url.pathname.startsWith(`${SUITE_MANAGER_API_PREFIX}/`)) {
        jsonResponse(response, 404, { error: 'Not found.' });
        return;
      }

      // Every managed dashboard tile links here. Nothing in the URL can steer the
      // target, and it needs no session: the app behind the tile does its own auth.
      const appOpenMatch = url.pathname.match(MANAGED_APP_HREF_PATTERN);
      if (request.method === 'GET' && appOpenMatch) {
        const packageId = appPackages.installedPackageIdForInstance(appOpenMatch[1]);
        const appHost = packageId ? appUrls.hostFor(packageId) : null;
        if (!appHost) {
          jsonResponse(response, 404, { code: 'APP_NOT_INSTALLED', error: 'That app is not installed on this server.' });
          return;
        }
        response.writeHead(302, {
          'Cache-Control': 'no-store',
          Location: appUrls.publicUrlOf(packageId).publicUrl,
        });
        response.end();
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

      if (request.method === 'GET' && serveHomeIcon(response, frontendDistDir, url.pathname)) {
        return;
      }

      if (!isSignedIn(setup, sessionToken)) {
        response.writeHead(302, { Location: SUITE_MANAGER_BASE_PATH });
        response.end();
        return;
      }

      homepage.proxyHttp(request, response);
    } catch (error) {
      respondError(response, error, { logger, method: request.method, requestPath: url.pathname });
    }
  };
}

function createUpgradeHandler({ addressService, homepage, setup }) {
  return (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const requestHost = normalizedHost(request);
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || '';

    if (!addressService.allowedHosts().has(requestHost) || !isSignedIn(setup, sessionToken)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }

    if (url.pathname === '/suite-manager' || url.pathname.startsWith(SUITE_MANAGER_BASE_PATH)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    homepage.proxyUpgrade(request, socket, head);
  };
}

function createMOSServer(services) {
  const server = http.createServer(createRequestHandler(services));
  server.on('upgrade', createUpgradeHandler(services));
  server.on('close', () => services.stop());
  return server;
}

module.exports = {
  createMOSServer,
  createRequestHandler,
};
