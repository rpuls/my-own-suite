const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { MANAGED_APP_HREF_PREFIX } = require('../../../../shared/homepage-contract.cjs');
const {
  VAULT_TPM_MODES,
  vaultAsksForPassword,
  vaultChipNeedsRepair,
  vaultIsPresent,
} = require('../../../../shared/vault-contract.cjs');
const { OfficialCatalogError } = require('../apps/official-catalog-service.cjs');
const { withUnmetRequirements } = require('../apps/host-requirements.cjs');
const { resolveClientAddress } = require('../auth/login-throttle.cjs');
const { SetupError } = require('../setup/setup-service.cjs');
const {
  KNOWN_BROWSER_COOKIE,
  SESSION_COOKIE,
  clearSessionCookie,
  knownBrowserCookie,
  parseCookies,
  sessionCookie,
} = require('./cookies.cjs');
const { isCrossOriginWrite, isHttpsRequest, normalizedHost, readJsonBody } = require('./request.cjs');
const { fileResponse, htmlResponse, jsonResponse, respondError, textResponse } = require('./responses.cjs');
const { createRouter } = require('./router.cjs');
const { routeTable } = require('./routes/index.cjs');

const SUITE_MANAGER_BASE_PATH = '/suite-manager/';
const SUITE_MANAGER_API_PREFIX = `${SUITE_MANAGER_BASE_PATH}api`;
const FRONTEND_ASSET_PREFIX = `${SUITE_MANAGER_BASE_PATH}assets/`;
const MANAGED_APP_HREF_PATTERN = new RegExp(`^${MANAGED_APP_HREF_PREFIX}([0-9a-f-]{36})$`, 'u');

function secureTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length > 0
    && actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
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

// Which build of the frontend this server is serving. It is a hash of the built
// index.html, so it changes exactly when the bundle it points at changes: a
// restart that shipped no new frontend keeps the same id, and a browser holding
// an older one knows it is running code this server no longer serves.
//
// Cached against the file's mtime and size rather than recomputed, because the
// running frontend asks for it on a timer.
let frontendBuildCache = null;
function frontendBuildId(frontendDistDir) {
  const indexPath = path.join(frontendDistDir, 'index.html');
  let stats = null;
  try { stats = fs.statSync(indexPath); } catch { return ''; }
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  if (frontendBuildCache?.stamp === stamp) return frontendBuildCache.id;
  const html = readFrontendHtml(frontendDistDir);
  if (html === null) return '';
  const id = crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);
  frontendBuildCache = { id, stamp };
  return id;
}

function isSignedIn(setup, sessionToken) {
  return setup.status(sessionToken).status === 'signed-in';
}

// The build output directory holds nothing but bundles whose filename contains
// their own content hash, so a year is safe and a new build is a new URL.
// Everything else served from here — the brand marks, the favicons, the fonts —
// keeps its filename across a rebrand, so it gets an hour instead of forever.
function assetCacheControl(relativePath) {
  return relativePath.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600';
}

function serveFrontendAsset(response, frontendDistDir, pathname) {
  const relativePath = pathname.slice(FRONTEND_ASSET_PREFIX.length);
  const staticPath = resolveStaticPath(frontendDistDir, relativePath);
  if (!staticPath || !fs.existsSync(staticPath) || !fs.statSync(staticPath).isFile()) {
    return false;
  }

  fileResponse(response, staticPath, { 'Cache-Control': assetCacheControl(relativePath) });
  return true;
}

function serveFrontend(response, frontendDistDir) {
  const html = readFrontendHtml(frontendDistDir);
  if (html) {
    const buildId = frontendBuildId(frontendDistDir);
    // Never cached, and it is the one response that must not be: the bundles it
    // names are immutable and permanently cacheable precisely because this
    // document is the thing that says which ones to load. A stale copy of it
    // pins a browser to the previous build with no way to find out.
    htmlResponse(response, 200, buildId
      ? html.replace('</head>', `  <meta name="mos-build" content="${buildId}" />
  </head>`)
      : html, { 'Cache-Control': 'no-store' });
    return;
  }

  textResponse(response, 503, 'Suite Manager frontend is not built yet. Run npm run build:client.');
}

function createRequestHandler(services) {
  const {
    addressService, alerts, appPackages, appUrls, catalogService, consoleLogin, externalSourceService,
    frontendDistDir, handover, homepage, homepageConfig, installJobs, logger, ownerClaimToken, recordSecurityEvent,
    repairChipOnSignIn, securityLogger, setup, teachChipOwnerPassword, throttle, updateJobs, vaultAgent,
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

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/setup/status`) {
        const status = setup.status(sessionToken);
        jsonResponse(response, 200, {
          ...status,
          // Only a signed-in caller is told what the machine still holds for its
          // owner, and it rides on the bootstrap payload for the same reason the
          // terms do: the gate has to be up before the first screen paints.
          ...(status.status === 'signed-in' ? { handover: await handover.state() } : {}),
          ownerClaimRequired: Boolean(ownerClaimToken),
          secureTransport: isHttpsRequest(request),
        });
        return;
      }

      // Unauthenticated because the frontend it identifies is served to anyone
      // who can reach this port, so the hash of it reveals nothing that the
      // bundle does not. The sign-in screen is left running across an update the
      // same as any other screen, and needs the same way to notice.
      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/build`) {
        jsonResponse(response, 200, { id: frontendBuildId(frontendDistDir) }, { 'Cache-Control': 'no-store' });
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
        const result = await setup.createOwner(body);
        // The owner finished setup through this door, so this is where the suite
        // is published from now on. Recorded after the owner exists so a refused
        // attempt from another door cannot move the address.
        try {
          addressService.recordDoor(requestHost, { scheme: isHttpsRequest(request) ? 'https' : 'http' });
        } catch (error) {
          logger.error('suite-address-record-failed', { error, host: requestHost });
        }
        jsonResponse(response, 201, { owner: result.owner, status: result.status }, {
          'Set-Cookie': sessionCookie(result.sessionToken, isHttpsRequest(request)),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/auth/login`) {
        const body = await readJsonBody(request);
        const knownBrowser = setup.isKnownBrowser(cookies[KNOWN_BROWSER_COOKIE] || '');
        const attempt = { email: body.email, ip: resolveClientAddress(request), knownBrowser };
        const retryAfterMs = throttle.retryAfterMs(attempt);
        if (retryAfterMs > 0) {
          const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
          const securityEvent = {
            clientFingerprint: throttle.fingerprint(attempt.ip),
            event: 'login-throttled',
            retryAfterSeconds,
          };
          try {
            recordSecurityEvent({
              at: new Date().toISOString(),
              eventType: securityEvent.event,
              retryAfterSeconds,
              subject: securityEvent.clientFingerprint,
            });
          } catch {
            securityLogger({ event: 'security-event-persistence-failed' });
          }
          securityLogger(securityEvent);
          // Not awaited: the 429 must not wait on a relay, and a relay that
          // fails is logged rather than allowed to change the answer.
          alerts.notify().catch((error) => securityLogger({ error: error.message, event: 'sign-in-alert-failed' }));
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
          result = await setup.login(body);
        } catch (error) {
          if (error instanceof SetupError && (error.code === 'INVALID_LOGIN' || error.code === 'OWNER_NOT_CREATED')) {
            throttle.recordFailure(attempt);
          }
          throw error;
        }
        throttle.recordSuccess(attempt);
        // The one moment MOS holds this password without being asked to change
        // it, and therefore the only chance to finish a chip enrollment that
        // failed earlier. Nothing about the sign-in depends on it.
        repairChipOnSignIn(body.password);
        const secure = isHttpsRequest(request);
        const cookiesToSet = [sessionCookie(result.sessionToken, secure)];
        if (!knownBrowser) cookiesToSet.push(knownBrowserCookie(setup.rememberBrowser(), secure));
        jsonResponse(response, 200, { owner: result.owner, status: result.status }, { 'Set-Cookie': cookiesToSet });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/setup/terms/accept`) {
        if (signedOut('Sign in to accept the MOS terms.')) return;
        jsonResponse(response, 200, setup.acceptTerms(await readJsonBody(request, 4 * 1024)));
        return;
      }

      // Changing the owner password rotates the session cookie in the same
      // response that ends every other session, so the browser that made the
      // change is the only one still signed in when this returns.
      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/owner/password`) {
        if (signedOut('Sign in to change the owner password.')) return;
        const result = await setup.changeOwnerPassword(await readJsonBody(request, 8 * 1024), {
          beforeCommit: teachChipOwnerPassword,
        });
        // Every known browser was forgotten with the old password; the one that
        // proved it is remembered again, like the session it keeps.
        const secure = isHttpsRequest(request);
        jsonResponse(response, 200, { owner: result.owner, startupProtection: result.startupProtection, status: result.status }, {
          'Set-Cookie': [sessionCookie(result.sessionToken, secure), knownBrowserCookie(setup.rememberBrowser(), secure)],
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

      // Owner preferences are one keyed route rather than one route each, so a
      // new preference is a key in setup-service rather than another endpoint.
      // The service owns the closed set of keys and their types; an unknown key
      // or a value of the wrong type is a 400, never a stored row.
      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/preferences`) {
        if (signedOut('Sign in to change your Suite Manager preferences.')) return;
        jsonResponse(response, 200, { preferences: setup.setPreference(await readJsonBody(request, 4 * 1024)) });
        return;
      }

      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/security-events`) {
        if (signedOut('Sign in to review security activity.')) return;
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
        jsonResponse(response, 200, { since, ...setup.store.getSecurityEventSummary({ since }) });
        return;
      }

      // The machine's own console/SSH login, generated by this machine on first
      // boot. Whether one is waiting rides on the setup status; these two routes
      // show it once and delete it, the whole lifecycle of a credential MOS
      // holds but does not own.
      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/console-login/reveal`) {
        if (signedOut('Sign in to see the server login.')) return;
        // No-store because this is the one response in the API that carries a
        // plaintext credential the owner is expected to copy elsewhere.
        jsonResponse(response, 200, consoleLogin.reveal(), { 'Cache-Control': 'no-store' });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/console-login/acknowledge`) {
        if (signedOut('Sign in to confirm you saved the server login.')) return;
        jsonResponse(response, 200, consoleLogin.acknowledge());
        return;
      }

      // What this machine's vault is doing, in the predicates the screens need.
      // An unavailable vault agent answers 200 with `state: 'unknown'` rather
      // than failing the request, so the encryption panel can say MOS could not
      // tell instead of rendering nothing — and `unknown` is never "not
      // encrypted".
      if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/vault`) {
        if (signedOut('Sign in to review this server\'s encryption.')) return;
        let vault = { state: 'unknown' };
        try {
          vault = await vaultAgent.status();
        } catch (error) {
          logger.warn('vault-agent-unavailable', { error });
        }
        // `encrypted` is the answer, not the state string. A screen that decided
        // for itself which states count as encrypted would be a fifth copy of
        // one predicate, and the fifth copy is the one that gets it wrong. The
        // same goes for the two startup questions, which the encryption
        // statement, the restart dialog and the handover page all ask and none
        // of them re-derives.
        jsonResponse(response, 200, {
          asksForPassword: vaultAsksForPassword(vault),
          chipNeedsRepair: vaultChipNeedsRepair(vault),
          encrypted: vaultIsPresent(vault),
          vault,
        });
        return;
      }

      // Startup protection: whether this machine's chip requires the owner's
      // password before it opens the disk. The current password is the
      // confirmation and the secret in one — it is what gets enrolled — so this
      // route is the only place MOS sends that password to the vault agent
      // outside a password change and a sign-in repair.
      if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/settings/vault/startup-password`) {
        if (signedOut('Sign in to change how this server starts.')) return;
        const body = await readJsonBody(request, 8 * 1024);
        const wanted = body.enabled === true;
        if (!await setup.verifyOwnerPassword(body.password)) {
          jsonResponse(response, 400, { code: 'INVALID_PASSWORD', error: 'Your current password is incorrect.' });
          return;
        }
        let enrolled;
        try {
          // A password the owner may forget must not become the only way in
          // before they hold the key that is the other way in — and while the
          // key is still escrowed on the plaintext side, the switch would
          // protect nothing anyway.
          if (wanted && (await vaultAgent.status()).handover === 'pending') {
            jsonResponse(response, 409, {
              code: 'VAULT_KEY_UNSAVED',
              error: 'Save your recovery key first. It is the only way back in if you forget your password.',
            });
            return;
          }
          enrolled = await vaultAgent.enrollChip({
            mode: wanted ? VAULT_TPM_MODES.PASSWORD : VAULT_TPM_MODES.AUTOMATIC,
            pin: wanted ? String(body.password) : null,
          });
        } catch (error) {
          logger.warn('vault-agent-unavailable', { error });
          jsonResponse(response, 503, {
            code: 'VAULT_AGENT_UNAVAILABLE',
            error: 'This server\'s vault agent is not answering, so how it starts was not changed.',
          });
          return;
        }
        if (!enrolled.ok) {
          // Reported rather than hidden, and the state it left behind is named:
          // the recovery key opens this machine whatever the chip is doing.
          jsonResponse(response, 409, {
            code: 'VAULT_TPM_REFUSED',
            error: enrolled.reason === 'no-tpm'
              ? 'This machine has no security chip, so it always asks for your recovery key after a restart.'
              : 'This machine\'s security chip would not take the change, so it now opens nothing on its own and this server asks for your recovery key after a restart. Try again, and use your recovery key if it restarts first.',
            reason: enrolled.reason || null,
          });
          return;
        }
        jsonResponse(response, 200, {
          asksForPassword: enrolled.mode === VAULT_TPM_MODES.PASSWORD,
          vault: await vaultAgent.status().catch(() => ({ state: 'unknown' })),
        });
        return;
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

      if (url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/sources` || url.pathname.startsWith(`${SUITE_MANAGER_API_PREFIX}/apps/sources/`)) {
        if (signedOut('Sign in to manage app package sources.')) return;
        if (request.method === 'GET' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/sources`) {
          jsonResponse(response, 200, { sources: externalSourceService.listSources() });
          return;
        }
        if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/sources`) {
          const body = await readJsonBody(request, 8 * 1024);
          jsonResponse(response, 201, {
            source: await externalSourceService.addSource({
              catalogPath: body.catalogPath,
              kind: body.kind,
              publisher: body.publisher,
              repository: body.repository,
              signature: body.signature,
              trust: body.trust,
            }, { ref: typeof body.ref === 'string' && body.ref ? body.ref : 'main' }),
          });
          return;
        }
        if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/sources/resolve`) {
          const body = await readJsonBody(request, 4 * 1024);
          const resolved = await externalSourceService.resolveUrl(String(body.url || ''));
          jsonResponse(response, 200, { ...resolved, packages: withUnmetRequirements(resolved.packages, await appPackages.hostFacts()) });
          return;
        }
        if (request.method === 'POST' && url.pathname === `${SUITE_MANAGER_API_PREFIX}/apps/sources/install`) {
          const body = await readJsonBody(request, 16 * 1024);
          jsonResponse(response, 201, await externalSourceService.installUrl(String(body.url || ''), {
            config: body.config,
            packageId: typeof body.packageId === 'string' && body.packageId ? body.packageId : null,
          }));
          return;
        }
        const sourceStatusMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/sources\/([^/]+)\/status$/u);
        const sourcePreviewMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/sources\/([^/]+)\/preview$/u);
        const sourceRefreshMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/sources\/([^/]+)\/refresh$/u);
        const sourceRemoveMatch = url.pathname.match(/^\/suite-manager\/api\/apps\/sources\/([^/]+)\/remove$/u);
        // The owner asking directly, which is the one check that ignores both the
        // interval and the failure back-off — the warning on a failing source is
        // what prompts the click, so making the click wait would strand them.
        if (request.method === 'POST' && sourceRefreshMatch) {
          const id = decodeURIComponent(sourceRefreshMatch[1]);
          jsonResponse(response, 200, await externalSourceService.refreshSource(id, { force: true }));
          return;
        }
        if (request.method === 'POST' && sourceStatusMatch) {
          const body = await readJsonBody(request, 4 * 1024);
          jsonResponse(response, 200, {
            source: externalSourceService.setSourceStatus(decodeURIComponent(sourceStatusMatch[1]), String(body.status || ''), typeof body.reason === 'string' ? body.reason : null),
          });
          return;
        }
        if (request.method === 'POST' && sourcePreviewMatch) {
          const body = await readJsonBody(request, 4 * 1024).catch(() => ({}));
          jsonResponse(response, 200, {
            candidate: await externalSourceService.previewCandidate(decodeURIComponent(sourcePreviewMatch[1]), {
              packageId: typeof body?.packageId === 'string' && body.packageId ? body.packageId : null,
            }),
          });
          return;
        }
        if (request.method === 'POST' && sourceRemoveMatch) {
          jsonResponse(response, 200, await externalSourceService.removeSource(decodeURIComponent(sourceRemoveMatch[1])));
          return;
        }
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
