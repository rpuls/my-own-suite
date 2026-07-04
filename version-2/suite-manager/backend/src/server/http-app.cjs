const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { SetupError, SetupService } = require('../setup/setup-service.cjs');
const { HomepageAgentClient } = require('../homepage/homepage-agent-client.cjs');
const { HomepageService } = require('../homepage/homepage-service.cjs');
const { HttpsAgentClient } = require('../settings/https-agent-client.cjs');
const { HttpsSettingsError } = require('../../../../shared/https-contract.cjs');
const { HttpsSettingsService } = require('../settings/https-settings-service.cjs');
const { createHomepageProxy } = require('./homepage-proxy.cjs');
const { AppPackageService, AppPackageServiceError } = require('../apps/app-package-service.cjs');
const { AppAgentClient } = require('../apps/app-agent-client.cjs');

const SESSION_COOKIE = 'mos_v2_session';
const DEFAULT_FRONTEND_DIST_DIR = path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');
const DEFAULT_APPS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'apps');
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

function isHttpsRequest(request) {
  return String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function sessionCookie(token, secure = false) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(secure = false) {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

function readJsonBody(request, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
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
  if (Number.isInteger(error.statusCode)) {
    return error.statusCode;
  }
  if (error instanceof AppPackageServiceError) {
    return error.statusCode;
  }
  if (error instanceof HttpsSettingsError) {
    return error.statusCode;
  }
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

function appPublicUrlFor(request, packageId) {
  const homeHost = normalizedHost(request);
  const baseHost = homeHost.startsWith('home.') ? homeHost.slice(5) : homeHost;
  const appHost = `${packageId}.${baseHost}`;
  const scheme = isHttpsRequest(request) ? 'https' : 'http';
  return {
    appHost,
    baseHost,
    publicUrl: `${scheme}://${appHost}/`,
    scheme,
  };
}

function appPublicUrlResolver(request) {
  return (packageId) => appPublicUrlFor(request, packageId);
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
  appAgent = new AppAgentClient(),
  appsDir = DEFAULT_APPS_DIR,
  homepageAgent = new HomepageAgentClient(),
  httpsAgent = new HttpsAgentClient(),
  frontendDistDir = DEFAULT_FRONTEND_DIST_DIR,
  frontDoor = process.env.MOS_V2_FRONT_DOOR || 'ssh-bootstrap',
  homeHost = process.env.MOS_V2_HOME_HOST || 'home.localhost',
  homepageUpstream = process.env.MOS_V2_HOMEPAGE_UPSTREAM || 'http://127.0.0.1:3200',
  stateDir = path.join(process.cwd(), '.state'),
} = {}) {
  const setup = new SetupService({ stateDir });
  const httpsSettings = new HttpsSettingsService({
    agent: httpsAgent,
    bootstrapHost: homeHost,
    frontDoor,
    store: setup.store,
  });
  const homepage = createHomepageProxy({ upstream: homepageUpstream, upstreamHost: homeHost });
  const homepageConfig = new HomepageService({
    agent: homepageAgent,
    bootstrapHost: homeHost,
    store: setup.store,
  });
  const appPackages = new AppPackageService({
    agent: appAgent,
    appsDir,
    store: setup.store,
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const requestHost = normalizedHost(request);
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || '';

    try {
      if (!httpsSettings.allowedHosts().has(requestHost)) {
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
          'Set-Cookie': sessionCookie(result.sessionToken, isHttpsRequest(request)),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/auth/login`) {
        const body = await readJsonBody(request);
        const result = setup.login(body);
        jsonResponse(response, 200, { owner: result.owner, status: result.status }, {
          'Set-Cookie': sessionCookie(result.sessionToken, isHttpsRequest(request)),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/auth/logout`) {
        const result = setup.logout(sessionToken);
        jsonResponse(response, 200, result, {
          'Set-Cookie': clearSessionCookie(isHttpsRequest(request)),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/https`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to manage HTTPS settings.' });
          return;
        }
        jsonResponse(response, 200, await httpsSettings.status());
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/https/apply`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to manage HTTPS settings.' });
          return;
        }
        const body = await readJsonBody(request, 16 * 1024);
        jsonResponse(response, 200, await httpsSettings.apply(body));
        return;
      }

      if (url.pathname.startsWith(`${SUITE_MANAGER_API_PREFIX}/customize/`)) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to customize Homepage.' });
          return;
        }
        if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/customize/status`) {
          jsonResponse(response, 200, await homepageConfig.status());
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request, 600 * 1024);
          const handlers = new Map([
            [`${SUITE_MANAGER_API_PREFIX}/customize/file/read`, () => homepageConfig.read(body)],
            [`${SUITE_MANAGER_API_PREFIX}/customize/file/validate`, () => homepageConfig.validate(body)],
            [`${SUITE_MANAGER_API_PREFIX}/customize/file/apply`, () => homepageConfig.apply(body)],
            [`${SUITE_MANAGER_API_PREFIX}/customize/add-link`, () => homepageConfig.add(body, false)],
            [`${SUITE_MANAGER_API_PREFIX}/customize/add-home-service`, () => homepageConfig.add(body, true)],
            [`${SUITE_MANAGER_API_PREFIX}/customize/home-service-preview`, () => homepageConfig.previewHomeService(body)],
          ]);
          const handler = handlers.get(url.pathname);
          if (handler) {
            jsonResponse(response, 200, await handler());
            return;
          }
        }
      }

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/packages`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to review app packages.' });
          return;
        }
        jsonResponse(response, 200, { packages: appPackages.listPackages() });
        return;
      }

      const appIconMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/icon$/u);
      if (request.method === 'GET' && appIconMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to review app packages.' });
          return;
        }
        fileResponse(response, appPackages.iconPath(decodeURIComponent(appIconMatch[1])));
        return;
      }

      const appInstallMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/install$/u);
      if (request.method === 'POST' && appInstallMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to install app packages.' });
          return;
        }
        const body = await readJsonBody(request, 64 * 1024);
        jsonResponse(response, 200, { instance: appPackages.installPackage(decodeURIComponent(appInstallMatch[1]), body) });
        return;
      }

      const appHomepageMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/add-to-homepage$/u);
      if (request.method === 'POST' && appHomepageMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to add app packages to Homepage.' });
          return;
        }
        const packageId = decodeURIComponent(appHomepageMatch[1]);
        jsonResponse(response, 200, await appPackages.addPackageToHomepage(packageId, homepageConfig, appPublicUrlFor(request, packageId)));
        return;
      }

      const appRuntimeMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/apply-runtime$/u);
      if (request.method === 'POST' && appRuntimeMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to apply app runtimes.' });
          return;
        }
        const packageId = decodeURIComponent(appRuntimeMatch[1]);
        jsonResponse(response, 200, await appPackages.applyPackageRuntime(packageId, {
          ...appPublicUrlFor(request, packageId),
          publicUrlFor: appPublicUrlResolver(request),
        }));
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/integrations/connect`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to connect app packages.' });
          return;
        }
        const body = await readJsonBody(request, 16 * 1024);
        jsonResponse(response, 200, await appPackages.connectPackages({
          consumerPackageId: String(body.consumerPackageId || ''),
          providerCapabilityId: String(body.providerCapabilityId || ''),
          providerPackageId: String(body.providerPackageId || ''),
          requestContext: { publicUrlFor: appPublicUrlResolver(request) },
          slotId: String(body.slotId || ''),
        }));
        return;
      }

      const appDisableMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/disable$/u);
      if (request.method === 'POST' && appDisableMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to disable app packages.' });
          return;
        }
        const packageId = decodeURIComponent(appDisableMatch[1]);
        jsonResponse(response, 200, await appPackages.disablePackage(packageId, homepageConfig));
        return;
      }

      const appStopMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/stop$/u);
      if (request.method === 'POST' && appStopMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to stop app packages.' });
          return;
        }
        const packageId = decodeURIComponent(appStopMatch[1]);
        jsonResponse(response, 200, await appPackages.stopPackageRuntime(packageId));
        return;
      }

      const appEnableMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/enable$/u);
      if (request.method === 'POST' && appEnableMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to enable app packages.' });
          return;
        }
        const packageId = decodeURIComponent(appEnableMatch[1]);
        jsonResponse(response, 200, await appPackages.enablePackage(packageId, {
          ...appPublicUrlFor(request, packageId),
          publicUrlFor: appPublicUrlResolver(request),
        }));
        return;
      }

      const appRestartMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/restart$/u);
      if (request.method === 'POST' && appRestartMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to restart app packages.' });
          return;
        }
        const packageId = decodeURIComponent(appRestartMatch[1]);
        jsonResponse(response, 200, await appPackages.restartPackageRuntime(packageId, {
          ...appPublicUrlFor(request, packageId),
          publicUrlFor: appPublicUrlResolver(request),
        }));
        return;
      }

      const appUninstallMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/uninstall$/u);
      if (request.method === 'POST' && appUninstallMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to uninstall app packages.' });
          return;
        }
        const packageId = decodeURIComponent(appUninstallMatch[1]);
        jsonResponse(response, 200, await appPackages.uninstallPackagePreserveData(packageId, homepageConfig));
        return;
      }

      const appRefreshMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/refresh-runtime-status$/u);
      if (request.method === 'POST' && appRefreshMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to refresh app runtime status.' });
          return;
        }
        const packageId = decodeURIComponent(appRefreshMatch[1]);
        jsonResponse(response, 200, await appPackages.refreshPackageRuntimeStatus(packageId));
        return;
      }

      const appGuideMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/guide$/u);
      if (request.method === 'POST' && appGuideMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to update app setup guides.' });
          return;
        }
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
        ...(Array.isArray(error.details) && error.details.length ? { details: error.details } : {}),
        error: error.message || 'Internal server error.',
      });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const requestHost = normalizedHost(request);
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE] || '';

    if (!httpsSettings.allowedHosts().has(requestHost) || !isSignedIn(setup, sessionToken)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }

    if (url.pathname === '/suite-manager' || url.pathname.startsWith(SUITE_MANAGER_BASE_PATH)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    homepage.proxyUpgrade(request, socket, head);
  });

  server.on('close', () => setup.close());

  return server;
}

module.exports = {
  SESSION_COOKIE,
  createV2Server,
};
