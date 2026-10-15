const { KNOWN_BROWSER_MAX_AGE_MS, SESSION_MAX_AGE_MS } = require('../setup/setup-service.cjs');

const SESSION_COOKIE = 'mos_session';
const KNOWN_BROWSER_COOKIE = 'mos_known_browser';

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

function sessionCookie(token, secure = false) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1_000)}${secure ? '; Secure' : ''}`;
}

function knownBrowserCookie(token, secure = false) {
  return `${KNOWN_BROWSER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(KNOWN_BROWSER_MAX_AGE_MS / 1_000)}${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(secure = false) {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = {
  KNOWN_BROWSER_COOKIE,
  SESSION_COOKIE,
  clearSessionCookie,
  knownBrowserCookie,
  parseCookies,
  sessionCookie,
};
