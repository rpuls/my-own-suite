const { CodedError } = require('./coded-error.cjs');

const DOMAIN_PATTERN =/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,4096}$/u;

class HttpsSettingsError extends CodedError {
  constructor(code, message, statusCode = 400) {
    super(code, message, { statusCode });
  }
}

function normalizeBaseDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/u, '');
}

// The normalized domain, or null when a certificate could never be issued for it.
function validBaseDomain(value) {
  const baseDomain = normalizeBaseDomain(value);
  return DOMAIN_PATTERN.test(baseDomain) && baseDomain !== 'localhost' && !baseDomain.endsWith('.localhost') ? baseDomain : null;
}

function validateHttpsInput(input) {
  const baseDomain = validBaseDomain(input?.baseDomain);
  const acmeEmail = String(input?.acmeEmail || '').trim().toLowerCase();
  const cloudflareApiToken = String(input?.cloudflareApiToken || '').trim();

  if (!baseDomain) {
    throw new HttpsSettingsError('INVALID_BASE_DOMAIN', 'Enter a valid Cloudflare-managed base domain.');
  }
  if (!EMAIL_PATTERN.test(acmeEmail)) {
    throw new HttpsSettingsError('INVALID_ACME_EMAIL', 'Enter a valid ACME contact email address.');
  }
  if (!TOKEN_PATTERN.test(cloudflareApiToken)) {
    throw new HttpsSettingsError('INVALID_CLOUDFLARE_TOKEN', 'A valid Cloudflare API token is required.');
  }

  return { acmeEmail, baseDomain, cloudflareApiToken };
}

module.exports = { HttpsSettingsError, normalizeBaseDomain, validBaseDomain, validateHttpsInput };
