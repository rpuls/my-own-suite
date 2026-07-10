const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,4096}$/u;

class HttpsSettingsError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeBaseDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/u, '');
}

function validateHttpsInput(input) {
  const baseDomain = normalizeBaseDomain(input?.baseDomain);
  const acmeEmail = String(input?.acmeEmail || '').trim().toLowerCase();
  const cloudflareApiToken = String(input?.cloudflareApiToken || '').trim();

  if (!DOMAIN_PATTERN.test(baseDomain) || baseDomain === 'localhost' || baseDomain.endsWith('.localhost')) {
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

module.exports = { HttpsSettingsError, normalizeBaseDomain, validateHttpsInput };
