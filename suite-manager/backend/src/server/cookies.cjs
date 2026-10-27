const { KNOWN_BROWSER_MAX_AGE_MS, SESSION_MAX_AGE_MS } = require('../setup/setup-service.cjs');

// One name per transport. A browser refuses to let a plain-http response touch a
// Secure cookie of the same name, so an https session left behind by a browser
// would block every http sign-in at the same address until it expired.
const SESSION_COOKIE = 'mos_session';
const SESSION_COOKIE_HTTP = 'mos_session_http';
const KNOWN_BROWSER_COOKIE = 'mos_known_browser';
const KNOWN_BROWSER_COOKIE_HTTP = 'mos_known_browser_http';

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

function sessionCookieName(secure) {
  return secure ? SESSION_COOKIE : SESSION_COOKIE_HTTP;
}

function knownBrowserCookieName(secure) {
  return secure ? KNOWN_BROWSER_COOKIE : KNOWN_BROWSER_COOKIE_HTTP;
}

// The browser decides which names reach the server: over https both, over http
// never the Secure one. MOS reads whichever arrives, the transport's own name first,
// so a session begun before the certificate arrived carries over to https.
function sessionTokenFrom(cookies, secure) {
  const [own, other] = secure ? [SESSION_COOKIE, SESSION_COOKIE_HTTP] : [SESSION_COOKIE_HTTP, SESSION_COOKIE];
  return cookies[own] || cookies[other] || '';
}

function knownBrowserTokenFrom(cookies, secure) {
  const [own, other] = secure ? [KNOWN_BROWSER_COOKIE, KNOWN_BROWSER_COOKIE_HTTP] : [KNOWN_BROWSER_COOKIE_HTTP, KNOWN_BROWSER_COOKIE];
  return cookies[own] || cookies[other] || undefined;
}

function sessionCookie(token, secure = false) {
  return `${sessionCookieName(secure)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1_000)}${secure ? '; Secure' : ''}`;
}

function knownBrowserCookie(token, secure = false) {
  return `${knownBrowserCookieName(secure)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(KNOWN_BROWSER_MAX_AGE_MS / 1_000)}${secure ? '; Secure' : ''}`;
}

// An https response may clear the http cookie too; an http response cannot reach the Secure one.
function clearSessionCookies(secure = false) {
  const cleared = [`${SESSION_COOKIE_HTTP}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`];
  if (secure) cleared.unshift(`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`);
  return cleared;
}

module.exports = {
  KNOWN_BROWSER_COOKIE,
  KNOWN_BROWSER_COOKIE_HTTP,
  SESSION_COOKIE,
  SESSION_COOKIE_HTTP,
  clearSessionCookies,
  knownBrowserCookie,
  knownBrowserTokenFrom,
  parseCookies,
  sessionCookie,
  sessionTokenFrom,
};
