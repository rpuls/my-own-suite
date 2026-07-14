const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SetupError, SetupService } = require('../setup/setup-service.cjs');
const { LoginThrottle, resolveClientAddress } = require('../auth/login-throttle.cjs');
const { HomepageAgentClient } = require('../homepage/homepage-agent-client.cjs');
const { HomepageService } = require('../homepage/homepage-service.cjs');
const { HttpsAgentClient } = require('../settings/https-agent-client.cjs');
const { HttpsSettingsError } = require('../../../../shared/https-contract.cjs');
const { HttpsSettingsService } = require('../settings/https-settings-service.cjs');
const { LabResetAgentClient } = require('../lab/lab-reset-agent-client.cjs');
const { createHomepageProxy } = require('./homepage-proxy.cjs');
const { AppPackageService, AppPackageServiceError } = require('../apps/app-package-service.cjs');
const { AppAgentClient } = require('../apps/app-agent-client.cjs');
const { BackupAgentClient } = require('../backups/backup-agent-client.cjs');
const { BackupInventoryService } = require('../backups/backup-inventory-service.cjs');
const { UpdateAgentClient } = require('../updates/update-agent-client.cjs');
const { UpdateService } = require('../updates/update-service.cjs');

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

function downloadResponse(response, filePath, filename) {
  response.writeHead(200, {
    'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9_.-]/g, '_')}"`,
    'Content-Type': 'application/gzip',
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

function secureTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length > 0
    && actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
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

function appPublicUrlFor(request, packageId, httpsSettings = null) {
  const homeHost = normalizedHost(request);
  const baseHost = homeHost.startsWith('home.') ? homeHost.slice(5) : homeHost;
  const appHost = `${packageId}.${baseHost}`;
  const fallbackScheme = isHttpsRequest(request) ? 'https' : 'http';
  const scheme = httpsSettings?.publicUrlSchemeForHost(homeHost, fallbackScheme) || fallbackScheme;
  return {
    appHost,
    baseHost,
    publicUrl: `${scheme}://${appHost}/`,
    scheme,
  };
}

function appPublicUrlResolver(request, httpsSettings = null) {
  return (packageId) => appPublicUrlFor(request, packageId, httpsSettings);
}

function appPublicUrlResolverForBase(baseHost, scheme = 'http') {
  const normalizedBase = String(baseHost || '').trim().toLowerCase();
  const normalizedScheme = scheme === 'https' ? 'https' : 'http';
  return (packageId) => {
    const appHost = `${packageId}.${normalizedBase}`;
    return {
      appHost,
      baseHost: normalizedBase,
      publicUrl: `${normalizedScheme}://${appHost}/`,
      scheme: normalizedScheme,
    };
  };
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

  textResponse(response, 503, 'Suite Manager frontend is not built yet. Run npm run build:client.');
}

function createV2Server({
  appAgent = new AppAgentClient(),
  backupAgent = new BackupAgentClient(),
  appsDir = DEFAULT_APPS_DIR,
  homepageAgent = new HomepageAgentClient(),
  httpsAgent = new HttpsAgentClient(),
  labResetAgent = new LabResetAgentClient(),
  updateAgent = new UpdateAgentClient(),
  frontendDistDir = DEFAULT_FRONTEND_DIST_DIR,
  frontDoor = process.env.MOS_V2_FRONT_DOOR || 'ssh-bootstrap',
  homeHost = process.env.MOS_V2_HOME_HOST || 'home.localhost',
  homepageUpstream = process.env.MOS_V2_HOMEPAGE_UPSTREAM || 'http://127.0.0.1:3200',
  labResetEnabled = process.env.MOS_V2_LAB_RESET_ENABLED === '1',
  loginThrottle = new LoginThrottle(),
  securityLogger = (event) => console.warn(JSON.stringify(event)),
  securityEventRecorder = null,
  ownerClaimToken = process.env.MOS_V2_OWNER_CLAIM_TOKEN || '',
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
  const backupInventory = new BackupInventoryService({
    appsDir,
    stateDir,
    store: setup.store,
  });
  const updates = new UpdateService({ agent: updateAgent });
  const recordSecurityEvent = securityEventRecorder || ((event) => setup.store.recordSecurityEvent(event));

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
        jsonResponse(response, 200, {
          ...setup.status(sessionToken),
          ownerClaimRequired: Boolean(ownerClaimToken),
          secureTransport: isHttpsRequest(request),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/lab/reset`) {
        if (!labResetEnabled) {
          jsonResponse(response, 404, { code: 'LAB_RESET_DISABLED', error: 'Lab reset is not enabled on this install.' });
          return;
        }
        const result = await labResetAgent.reset({ reason: 'hyperv-e2e' });
        jsonResponse(response, 202, result, {
          'Set-Cookie': clearSessionCookie(isHttpsRequest(request)),
        });
        return;
      }

      const labResetStatusMatch = url.pathname.match(/^\/suite-manager\/api\/lab\/reset\/([^/]+)$/u);
      if (request.method === 'GET' && labResetStatusMatch) {
        if (!labResetEnabled) {
          jsonResponse(response, 404, { code: 'LAB_RESET_DISABLED', error: 'Lab reset is not enabled on this install.' });
          return;
        }
        jsonResponse(response, 200, await labResetAgent.resetStatus(decodeURIComponent(labResetStatusMatch[1])));
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/setup/owner`) {
        const body = await readJsonBody(request);
        if (ownerClaimToken && !isHttpsRequest(request)) {
          jsonResponse(response, 403, {
            code: 'HTTPS_REQUIRED_FOR_OWNER_SETUP',
            error: 'Owner setup is locked until this cloud server is reachable over HTTPS. Check that inbound ports 80 and 443 are allowed by the VPS provider firewall.',
          });
          return;
        }
        if (ownerClaimToken && !secureTokenEqual(body.claimToken, ownerClaimToken)) {
          jsonResponse(response, 403, {
            code: 'OWNER_CLAIM_REQUIRED',
            error: 'Use the secure one-time owner setup URL printed by the MOS installer.',
          });
          return;
        }
        const result = setup.createOwner(body);
        jsonResponse(response, 201, { owner: result.owner, status: result.status }, {
          'Set-Cookie': sessionCookie(result.sessionToken, isHttpsRequest(request)),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/auth/login`) {
        const body = await readJsonBody(request);
        const attempt = { email: body.email, ip: resolveClientAddress(request) };
        const retryAfterMs = loginThrottle.retryAfterMs(attempt);
        if (retryAfterMs > 0) {
          const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
          const securityEvent = {
            clientFingerprint: crypto.createHash('sha256').update(attempt.ip).digest('hex').slice(0, 12),
            event: 'login-throttled',
            retryAfterSeconds,
          };
          try {
            recordSecurityEvent({
              at: new Date().toISOString(),
              clientFingerprint: securityEvent.clientFingerprint,
              eventType: securityEvent.event,
              retryAfterSeconds,
            });
          } catch {
            securityLogger({ event: 'security-event-persistence-failed' });
          }
          securityLogger(securityEvent);
          jsonResponse(response, 429, {
            code: 'LOGIN_THROTTLED',
            error: 'Too many sign-in attempts. Wait a moment and try again.',
          }, {
            'Retry-After': String(retryAfterSeconds),
          });
          return;
        }

        let result;
        try {
          result = setup.login(body);
        } catch (error) {
          if (error instanceof SetupError && (error.code === 'INVALID_LOGIN' || error.code === 'OWNER_NOT_CREATED')) {
            loginThrottle.recordFailure(attempt);
          }
          throw error;
        }
        loginThrottle.recordSuccess(attempt);
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
        const applied = await httpsSettings.apply(body);
        let appReconciliation = { skipped: true };
        try {
          const baseDomain = new URL(applied.homeUrl).hostname.replace(/^home\./u, '');
          appReconciliation = await appPackages.reconcilePublicUrls(homepageConfig, {
            publicUrlFor: appPublicUrlResolverForBase(baseDomain, 'https'),
          });
        } catch (error) {
          appReconciliation = {
            errorCode: error.code || 'APP_PUBLIC_URL_RECONCILE_FAILED',
            skipped: false,
            status: 'failed',
          };
        }
        jsonResponse(response, 200, { ...applied, appReconciliation });
        return;
      }

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/backups/inventory`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to review backup readiness.' });
          return;
        }
        jsonResponse(response, 200, backupInventory.inventory());
        return;
      }

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/updates/status`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to review updates.' });
          return;
        }
        jsonResponse(response, 200, await updates.status());
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/updates/start`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to update My Own Suite.' });
          return;
        }
        jsonResponse(response, 202, await updates.start({ initiator: setup.status(sessionToken).owner?.email || 'owner' }));
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/updates/track`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to switch update tracks.' });
          return;
        }
        const body = await readJsonBody(request, 8 * 1024);
        if (body.track !== 'stable' && body.track !== 'staging') {
          jsonResponse(response, 400, { code: 'INVALID_UPDATE_TRACK', error: 'Update track must be stable or staging.' });
          return;
        }
        jsonResponse(response, 200, await updates.configureTrack(body));
        return;
      }

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/backups/status`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to manage backups.' });
          return;
        }
        try {
          jsonResponse(response, 200, {
            ...(await backupAgent.status()),
            inventory: backupInventory.inventory(),
            serviceAvailable: true,
          });
        } catch (error) {
          jsonResponse(response, 200, {
            backups: [],
            currentJob: null,
            destinations: [],
            error: error.message || 'Backup agent is unavailable.',
            inventory: backupInventory.inventory(),
            lastJob: null,
            serviceAvailable: false,
          });
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/backups/mount`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to manage backups.' });
          return;
        }
        const body = await readJsonBody(request, 8 * 1024);
        jsonResponse(response, 200, await backupAgent.mount(String(body.destinationId || '')));
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/backups/start`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to manage backups.' });
          return;
        }
        const body = await readJsonBody(request, 8 * 1024);
        jsonResponse(response, 202, await backupAgent.startBackup({ destinationId: String(body.destinationId || '') }));
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/backups/restore`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to restore backups.' });
          return;
        }
        const body = await readJsonBody(request, 8 * 1024);
        jsonResponse(response, 202, await backupAgent.startRestore({
          backupPath: String(body.backupPath || ''),
          confirmation: String(body.confirmation || ''),
        }));
        return;
      }

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/backups/download`) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to download backups.' });
          return;
        }
        const backupPath = url.searchParams.get('path') || '';
        const status = await backupAgent.status();
        const backup = (status.backups || []).find((item) => item.path === backupPath);
        if (!backup || !backup.archivePath || !fs.existsSync(backup.archivePath)) {
          jsonResponse(response, 404, { error: 'Backup bundle is no longer available.' });
          return;
        }
        downloadResponse(response, backup.archivePath, `${backup.id || 'mos-v2-backup'}.tar.gz`);
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
        jsonResponse(response, 200, { instance: await appPackages.installPackage(decodeURIComponent(appInstallMatch[1]), body) });
        return;
      }

      const appHomepageMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/packages\/([^/]+)\/add-to-homepage$/u);
      if (request.method === 'POST' && appHomepageMatch) {
        if (!isSignedIn(setup, sessionToken)) {
          jsonResponse(response, 401, { code: 'AUTH_REQUIRED', error: 'Sign in to add app packages to Homepage.' });
          return;
        }
        const packageId = decodeURIComponent(appHomepageMatch[1]);
        jsonResponse(response, 200, await appPackages.addPackageToHomepage(packageId, homepageConfig, appPublicUrlFor(request, packageId, httpsSettings)));
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
          ...appPublicUrlFor(request, packageId, httpsSettings),
          publicUrlFor: appPublicUrlResolver(request, httpsSettings),
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
          requestContext: { publicUrlFor: appPublicUrlResolver(request, httpsSettings) },
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
          ...appPublicUrlFor(request, packageId, httpsSettings),
          publicUrlFor: appPublicUrlResolver(request, httpsSettings),
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
          ...appPublicUrlFor(request, packageId, httpsSettings),
          publicUrlFor: appPublicUrlResolver(request, httpsSettings),
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
        jsonResponse(response, 200, await appPackages.uninstallPackage(packageId, homepageConfig));
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
  server.migrateAppPackages = () => appPackages.migrateLegacyPackages();

  return server;
}

module.exports = {
  SESSION_COOKIE,
  createV2Server,
};
