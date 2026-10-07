const http = require('node:http');

const { MANAGED_APP_HREF_PREFIX } = require('../../../../shared/homepage-contract.cjs');
const { OfficialCatalogError } = require('../apps/official-catalog-service.cjs');
const { SESSION_COOKIE, parseCookies } = require('./cookies.cjs');
const { FRONTEND_ASSET_PREFIX, SUITE_MANAGER_BASE_PATH, serveFrontend, serveFrontendAsset } = require('./frontend.cjs');
const { isCrossOriginWrite, isHttpsRequest, normalizedHost, readJsonBody } = require('./request.cjs');
const { fileResponse, jsonResponse, respondError } = require('./responses.cjs');
const { createRouter } = require('./router.cjs');
const { routeTable } = require('./routes/index.cjs');

const SUITE_MANAGER_API_PREFIX = `${SUITE_MANAGER_BASE_PATH}api`;
const MANAGED_APP_HREF_PATTERN = new RegExp(`^${MANAGED_APP_HREF_PREFIX}([0-9a-f-]{36})$`, 'u');

function isSignedIn(setup, sessionToken) {
  return setup.status(sessionToken).status === 'signed-in';
}

function createRequestHandler(services) {
  const {
    addressService, appPackages, appUrls, catalogService, externalSourceService, frontendDistDir, homepage,
    homepageConfig, installJobs, logger, setup, updateJobs,
  } = services;
  const { hostFor: appHostFor, publicUrlOf, publicUrls } = appUrls;
  // The UI follows this URL rather than rebuilding it from a manifest host, which
  // for an external app would drop the `ext-` prefix it is really served under.
  const withPublicUrl = (app) => ({ ...app, publicUrl: appHostFor(app.id) ? publicUrlOf(app.id).publicUrl : '' });
  const dispatch = createRouter(routeTable(services), { isSignedIn: (sessionToken) => isSignedIn(setup, sessionToken) });

  return async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const requestHost = normalizedHost(request);
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || '';
    const signedOut = (message) => {
      if (isSignedIn(setup, sessionToken)) return false;
      jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: message });
      return true;
    };

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

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/packages`) {
        if (signedOut('Sign in to review app packages.')) return;
        // Answer from what is already on disk, then let any sources that are due a
        // check catch up behind the response. Deliberately not awaited: the Apps
        // page must never wait on a git host, and a source found to have moved
        // shows up on the next load.
        jsonResponse(response, 200, {
          catalog: catalogService.status(),
          packages: appPackages.listPackages(await appPackages.hostFacts()).map((app) => ({ ...withPublicUrl(app), installJob: installJobs.get(app.id), updateJob: updateJobs.get(app.id) })),
        });
        externalSourceService.sweep();
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/catalog/refresh`) {
        if (signedOut('Sign in to refresh the app catalog.')) return;
        try {
          const result = await catalogService.refresh();
          jsonResponse(response, 200, result);
        } catch (error) {
          if (!(error instanceof OfficialCatalogError)) throw error;
          jsonResponse(response, 502, {
            code: error.code,
            error: error.message,
            status: error.catalogStatus || catalogService.status(),
          });
        }
        return;
      }

      const appIconMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/icon$/u);
      if (request.method === 'GET' && appIconMatch) {
        if (signedOut('Sign in to review app packages.')) return;
        fileResponse(response, appPackages.iconPath(decodeURIComponent(appIconMatch[1])));
        return;
      }

      const appScreenshotMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/screenshots\/(\d{1,3})$/u);
      if (request.method === 'GET' && appScreenshotMatch) {
        if (signedOut('Sign in to review app packages.')) return;
        fileResponse(response, appPackages.screenshotPath(decodeURIComponent(appScreenshotMatch[1]), Number(appScreenshotMatch[2])));
        return;
      }

      const appInstallMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/install$/u);
      const appPrepareUpdateMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/prepare-update$/u);
      const appUpdateJobMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/update-job$/u);
      if (request.method === 'POST' && appPrepareUpdateMatch) {
        if (signedOut('Sign in to review app updates.')) return;
        jsonResponse(response, 200, { comparison: await appPackages.preparePackageUpdate(decodeURIComponent(appPrepareUpdateMatch[1])) });
        return;
      }

      if (request.method === 'POST' && appUpdateJobMatch) {
        if (signedOut('Sign in to update app packages.')) return;
        const body = await readJsonBody(request, 4 * 1024);
        jsonResponse(response, 202, { updateJob: updateJobs.begin(decodeURIComponent(appUpdateJobMatch[1]), body) });
        return;
      }

      const appRecoverUpdateMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/recover-update$/u);
      if (request.method === 'POST' && appRecoverUpdateMatch) {
        if (signedOut('Sign in to recover app updates.')) return;
        const packageId = decodeURIComponent(appRecoverUpdateMatch[1]);
        jsonResponse(response, 200, await appPackages.recoverPackageUpdate(packageId, {
          ...publicUrlOf(packageId),
          homepageService: homepageConfig,
          publicUrlFor: publicUrls(),
        }));
        return;
      }

      if (request.method === 'POST' && appInstallMatch) {
        if (signedOut('Sign in to install app packages.')) return;
        const body = await readJsonBody(request, 64 * 1024);
        jsonResponse(response, 200, { instance: await appPackages.installPackage(decodeURIComponent(appInstallMatch[1]), body) });
        return;
      }

      const appInstallJobMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/install-job$/u);
      if (request.method === 'POST' && appInstallJobMatch) {
        if (signedOut('Sign in to install app packages.')) return;
        const body = await readJsonBody(request, 64 * 1024);
        const packageId = decodeURIComponent(appInstallJobMatch[1]);
        jsonResponse(response, 202, { installJob: installJobs.begin(packageId, { config: body.config || {}, showOnHomepage: body.showOnHomepage === true }) });
        return;
      }

      const appHomepageMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/add-to-homepage$/u);
      if (request.method === 'POST' && appHomepageMatch) {
        if (signedOut('Sign in to add app packages to Homepage.')) return;
        const packageId = decodeURIComponent(appHomepageMatch[1]);
        jsonResponse(response, 200, await appPackages.addPackageToHomepage(packageId, homepageConfig, publicUrlOf(packageId)));
        return;
      }

      const appRuntimeMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/apply-runtime$/u);
      if (request.method === 'POST' && appRuntimeMatch) {
        if (signedOut('Sign in to apply app runtimes.')) return;
        const packageId = decodeURIComponent(appRuntimeMatch[1]);
        jsonResponse(response, 200, await appPackages.startPackageRuntime(packageId, {
          ...publicUrlOf(packageId),
          publicUrlFor: publicUrls(),
        }));
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/integrations/connect`) {
        if (signedOut('Sign in to connect app packages.')) return;
        const body = await readJsonBody(request, 16 * 1024);
        jsonResponse(response, 200, await appPackages.connectPackages({
          consumerPackageId: String(body.consumerPackageId || ''),
          providerCapabilityId: String(body.providerCapabilityId || ''),
          providerPackageId: String(body.providerPackageId || ''),
          requestContext: { publicUrlFor: publicUrls() },
          slotId: String(body.slotId || ''),
        }));
        return;
      }

      const appStopMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/stop$/u);
      if (request.method === 'POST' && appStopMatch) {
        if (signedOut('Sign in to stop app packages.')) return;
        const packageId = decodeURIComponent(appStopMatch[1]);
        jsonResponse(response, 200, await appPackages.disablePackage(packageId));
        return;
      }

      const appEnableMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/enable$/u);
      if (request.method === 'POST' && appEnableMatch) {
        if (signedOut('Sign in to enable app packages.')) return;
        const packageId = decodeURIComponent(appEnableMatch[1]);
        jsonResponse(response, 200, await appPackages.enablePackage(packageId, {
          ...publicUrlOf(packageId),
          publicUrlFor: publicUrls(),
        }));
        return;
      }

      const appRestartMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/restart$/u);
      if (request.method === 'POST' && appRestartMatch) {
        if (signedOut('Sign in to restart app packages.')) return;
        const packageId = decodeURIComponent(appRestartMatch[1]);
        jsonResponse(response, 200, await appPackages.restartPackageRuntime(packageId, {
          ...publicUrlOf(packageId),
          publicUrlFor: publicUrls(),
        }));
        return;
      }

      const appEnvMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/env$/u);
      if (request.method === 'POST' && appEnvMatch) {
        if (signedOut('Sign in to change app environment variables.')) return;
        const packageId = decodeURIComponent(appEnvMatch[1]);
        const body = await readJsonBody(request, 64 * 1024);
        jsonResponse(response, 200, await appPackages.savePackageEnvironment(packageId, body, {
          ...publicUrlOf(packageId),
          publicUrlFor: publicUrls(),
        }));
        return;
      }

      const appUninstallMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/uninstall$/u);
      if (request.method === 'POST' && appUninstallMatch) {
        if (signedOut('Sign in to uninstall app packages.')) return;
        const packageId = decodeURIComponent(appUninstallMatch[1]);
        jsonResponse(response, 200, await appPackages.uninstallPackage(packageId, homepageConfig));
        return;
      }

      const appRefreshMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/refresh-runtime-status$/u);
      if (request.method === 'POST' && appRefreshMatch) {
        if (signedOut('Sign in to refresh app runtime status.')) return;
        const packageId = decodeURIComponent(appRefreshMatch[1]);
        jsonResponse(response, 200, await appPackages.refreshPackageRuntimeStatus(packageId));
        return;
      }

      const appGuideMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/guide$/u);
      if (request.method === 'POST' && appGuideMatch) {
        if (signedOut('Sign in to update app setup guides.')) return;
        const body = await readJsonBody(request, 8 * 1024);
        const status = String(body.status || '');
        if (!['viewed', 'completed', 'skipped'].includes(status)) {
          jsonResponse(response, 400, { code: 'INVALID_GUIDE_STATUS', error: 'Guide status must be viewed, completed, or skipped.' });
          return;
        }
        jsonResponse(response, 200, appPackages.setPackageGuideStatus(decodeURIComponent(appGuideMatch[1]), status));
        return;
      }

      if (url.pathname === SUITE_MANAGER_API_PREFIX || url.pathname.startsWith(`${SUITE_MANAGER_API_PREFIX}/`)) {
        jsonResponse(response, 404, { error: 'Not found.' });
        return;
      }

      // What every managed dashboard tile links to. The target is built from
      // this request's own Host plus the app the id resolves to, so one tile is
      // correct on every door the box answers on — and nothing in the URL or
      // query can steer it, which is what keeps this from being an open
      // redirector. Deliberately not behind sign-in: an app handles its own auth,
      // and a tile that only works for a signed-in owner is a broken tile.
      const appOpenMatch = url.pathname.match(MANAGED_APP_HREF_PATTERN);
      if (request.method === 'GET' && appOpenMatch) {
        const packageId = appPackages.installedPackageIdForInstance(appOpenMatch[1]);
        const appHost = packageId ? appHostFor(packageId) : null;
        if (!appHost) {
          jsonResponse(response, 404, { code: 'APP_NOT_INSTALLED', error: 'That app is not installed on this server.' });
          return;
        }
        response.writeHead(302, {
          'Cache-Control': 'no-store',
          Location: publicUrlOf(packageId).publicUrl,
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
