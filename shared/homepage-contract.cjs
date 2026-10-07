const { CodedError } = require('./coded-error.cjs');

const HOMEPAGE_FILES = Object.freeze([
  'bookmarks.yaml',
  'services.template.yaml',
  'settings.yaml',
  'widgets.yaml',
]);

const PROTOCOLS = new Set(['http', 'https']);
// The URL parser drops a port that is its scheme's default, so `https://nas.lan`
// and `https://nas.lan:443` both arrive with no port at all — and an app already
// served over HTTPS at home is reached at exactly those. What has to be explicit
// is the upstream MOS records and hands to the web server, not what its owner
// types, so the scheme supplies the number instead of the form refusing it.
const DEFAULT_PORTS = Object.freeze({ http: 80, https: 443 });
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

// A managed app tile links to Suite Manager's own redirect rather than to the
// app's absolute address. Homepage is a separate container serving one file to
// every visitor, so an absolute href is a snapshot of whichever door installed
// the app and is dead through the other one; a relative href resolves in the
// visitor's browser against the origin they already reached. The path is derived
// from the entry id and never from anything the caller supplies, which is what
// keeps a tile from being aimed anywhere Suite Manager did not resolve itself.
const MANAGED_APP_HREF_PREFIX = '/suite-manager/open/';

class HomepageConfigError extends CodedError {
  constructor(code, message, statusCode = 400, details = []) {
    super(code, message, { details, statusCode });
  }
}

function validateProxy(proxy) {
  const keys = Object.keys(proxy && typeof proxy === 'object' && !Array.isArray(proxy) ? proxy : {}).sort();
  if (keys.join(',') !== 'subdomain,upstream') {
    throw new HomepageConfigError('INVALID_PROXY_METADATA', 'Home service proxy metadata has an unsupported field.');
  }
  let upstream;
  try { upstream = new URL(proxy.upstream); } catch {
    throw new HomepageConfigError('INVALID_PROXY_UPSTREAM', 'The upstream must be a valid HTTP or HTTPS URL.');
  }
  const protocol = upstream.protocol.replace(':', '');
  if (!PROTOCOLS.has(protocol) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new HomepageConfigError('INVALID_PROXY_UPSTREAM', 'The upstream must contain only protocol, host, and port.');
  }
  if (!HOST_PATTERN.test(upstream.hostname.toLowerCase())) {
    throw new HomepageConfigError('INVALID_PROXY_UPSTREAM', 'The upstream needs the name or address the app answers at.');
  }
  const port = Number(upstream.port || DEFAULT_PORTS[protocol]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HomepageConfigError('INVALID_PROXY_PORT', 'The upstream port must be between 1 and 65535.');
  }
  const subdomain = String(proxy.subdomain || '').trim().toLowerCase();
  if (!SUBDOMAIN_PATTERN.test(subdomain) || subdomain === 'home' || subdomain === 'www') {
    throw new HomepageConfigError('INVALID_PROXY_SUBDOMAIN', 'Enter a valid subdomain other than home or www.');
  }
  return { subdomain, upstream: `${protocol}://${upstream.hostname.toLowerCase()}:${port}` };
}

// `domainState` is the suite's recorded address as the base its hosts hang
// under and the scheme it is served on: `{ baseDomain, scheme }`. Nothing here
// decides whether a name is secure; the address that was recorded says so.
function publicUrlFor(proxy, domainState) {
  const baseDomain = String(domainState?.baseDomain || '').trim().toLowerCase();
  if (!HOST_PATTERN.test(baseDomain) || baseDomain === 'localhost') {
    throw new HomepageConfigError('PUBLIC_DOMAIN_REQUIRED', 'Configure a usable MOS domain before adding a home service.');
  }
  return `${domainState?.scheme === 'https' ? 'https' : 'http'}://${proxy.subdomain}.${baseDomain}/`;
}

module.exports = {
  HOMEPAGE_FILES,
  HomepageConfigError,
  MANAGED_APP_HREF_PREFIX,
  PROTOCOLS,
  publicUrlFor,
  validateProxy,
};
