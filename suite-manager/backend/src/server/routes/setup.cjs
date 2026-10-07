const crypto = require('node:crypto');

const { resolveClientAddress } = require('../../auth/login-throttle.cjs');
const { KNOWN_BROWSER_COOKIE, clearSessionCookie, knownBrowserCookie, sessionCookie } = require('../cookies.cjs');
const { frontendBuildId } = require('../frontend.cjs');
const { jsonResponse } = require('../responses.cjs');

function secureTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length > 0
    && actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function setupRoutes({ addressService, frontendDistDir, handover, logger, ownerClaimToken, setup, signIn, vault }) {
  return [
    {
      method: 'GET',
      path: '/setup/status',
      handler: async ({ response, secure, sessionToken }) => {
        const status = setup.status(sessionToken);
        jsonResponse(response, 200, {
          ...status,
          // Only a signed-in caller learns what the machine still holds for its
          // owner, and on this payload because the gate is up before the first paint.
          ...(status.status === 'signed-in' ? { handover: await handover.state() } : {}),
          ownerClaimRequired: Boolean(ownerClaimToken),
          secureTransport: secure,
        });
      },
    },
    // Public: anyone who can reach the port is served the frontend it identifies,
    // and the sign-in screen has to notice an update like any other screen.
    {
      method: 'GET',
      path: '/build',
      handler: async ({ response }) => {
        jsonResponse(response, 200, { id: frontendBuildId(frontendDistDir) }, { 'Cache-Control': 'no-store' });
      },
    },
    {
      method: 'POST',
      path: '/setup/owner',
      handler: async ({ body, requestHost, response, secure }) => {
        const input = await body();
        if (ownerClaimToken && !secure) {
          jsonResponse(response, 403, {
            code: 'HTTPS_REQUIRED_FOR_OWNER_SETUP',
            error: 'Owner setup is locked until this cloud server is reachable over HTTPS. Check that inbound ports 80 and 443 are allowed by the VPS provider firewall.',
          });
          return;
        }
        if (ownerClaimToken && !secureTokenEqual(input.claimToken, ownerClaimToken)) {
          jsonResponse(response, 403, {
            code: 'OWNER_CLAIM_REQUIRED',
            error: 'Use the secure one-time owner setup URL printed by the MOS installer.',
          });
          return;
        }
        const result = await setup.createOwner(input);
        // The door the owner finished setup through is where the suite is published,
        // recorded after the owner exists so a refused attempt cannot move it.
        try {
          addressService.recordDoor(requestHost, { scheme: secure ? 'https' : 'http' });
        } catch (error) {
          logger.error('suite-address-record-failed', { error, host: requestHost });
        }
        jsonResponse(response, 201, { owner: result.owner, status: result.status }, {
          'Set-Cookie': sessionCookie(result.sessionToken, secure),
        });
      },
    },
    {
      method: 'POST',
      path: '/auth/login',
      handler: async ({ body, cookies, request, response, secure }) => {
        const input = await body();
        const result = await signIn.signIn({ credentials: input, ip: resolveClientAddress(request), knownBrowserToken: cookies[KNOWN_BROWSER_COOKIE] });
        const cookiesToSet = [sessionCookie(result.sessionToken, secure)];
        if (result.knownBrowserToken) cookiesToSet.push(knownBrowserCookie(result.knownBrowserToken, secure));
        jsonResponse(response, 200, { owner: result.owner, status: result.status }, { 'Set-Cookie': cookiesToSet });
      },
    },
    {
      method: 'POST',
      path: '/setup/terms/accept',
      signIn: 'Sign in to accept the MOS terms.',
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, setup.acceptTerms(input));
      },
    },
    // Every other session ends with the old password; this browser gets a fresh
    // session and is remembered again in the same response.
    {
      method: 'POST',
      path: '/settings/owner/password',
      signIn: 'Sign in to change the owner password.',
      bodyLimit: 8 * 1024,
      handler: async ({ body, response, secure }) => {
        const input = await body();
        const result = await setup.changeOwnerPassword(input, {
          beforeCommit: (password) => vault.teachOwnerPassword(password),
        });
        jsonResponse(response, 200, { owner: result.owner, startupProtection: result.startupProtection, status: result.status }, {
          'Set-Cookie': [sessionCookie(result.sessionToken, secure), knownBrowserCookie(setup.rememberBrowser(), secure)],
        });
      },
    },
    {
      method: 'POST',
      path: '/auth/logout',
      handler: async ({ response, secure, sessionToken }) => {
        const result = setup.logout(sessionToken);
        jsonResponse(response, 200, result, {
          'Set-Cookie': clearSessionCookie(secure),
        });
      },
    },
  ];
}

module.exports = { setupRoutes };
