'use strict';

// The shape of an owner's SMTP relay, shared by the backend service that stores
// and applies it and by the validator that lets an app reference it. It is the
// single source of truth for two things: what a relay is allowed to look like,
// and which `${smtp.*}` keys exist — so the manifest grammar, the runtime
// projection, and the settings form can never drift apart on the key names.

class SmtpSettingsError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// How the connection is protected. `starttls` upgrades a plaintext connection
// on the submission port and is the modern default; `tls` is implicit TLS from
// the first byte (the historical smtps port); `none` is an unencrypted relay,
// only sane on a trusted LAN and never the default.
const SMTP_SECURITY_MODES = Object.freeze(['starttls', 'tls', 'none']);

// The conventional port for each mode. Only a default: an owner may override.
const DEFAULT_SMTP_PORTS = Object.freeze({ none: 25, starttls: 587, tls: 465 });

// The keys an app may read as ${smtp.<key>}. Canonical here so the manifest
// validator (which decides what is a valid reference) and the runtime resolver
// (which decides what a reference becomes) enumerate the same set. `password` is
// secret-grade and resolves like ${secret.*}: real only at materialize time,
// redacted everywhere it could be logged.
//
// Encryption is offered in every shape a real app wants, all derived by MOS from
// the owner's single choice, so no app's own vocabulary has to leak into MOS:
// `security` is the canonical word (none|starttls|tls) for an app that takes one
// string; `startTls` and `implicitTls` are "true"/"false" for the many apps
// (Django's EMAIL_USE_TLS/EMAIL_USE_SSL, and others) that take two booleans.
const SMTP_TEMPLATE_KEYS = Object.freeze([
  // "true" when the owner accepted a relay whose TLS certificate is not trusted,
  // so an app connecting to the same relay makes the same choice MOS did rather
  // than failing where MOS succeeded.
  'allowInvalidCert',
  // "true" when a relay is configured, "false" otherwise — for an app with an
  // explicit on/off switch. Every other key is empty when no relay is set, so an
  // app that gates on a non-empty host is off too, and none is ever fed the
  // literal reference text.
  'configured',
  'fromAddress',
  'fromName',
  'host',
  'implicitTls',
  'port',
  'security',
  'startTls',
  'username',
  'password',
]);

// Deliberately permissive: a relay host is a hostname or a bare IP, and an
// owner running one on their LAN may well point at `10.0.0.5`. Rejects only what
// could not be a host at all — whitespace, a scheme, a path, a port suffix.
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// A display name that will sit inside a mail header. No control characters and
// no bare quotes or angle brackets, so it cannot break out of the header it is
// placed in.
const FROM_NAME_PATTERN = /^[^\r\n<>"]{0,120}$/u;

function asString(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function normalizeSecurity(value) {
  const security = asString(value).trim().toLowerCase();
  return SMTP_SECURITY_MODES.includes(security) ? security : 'starttls';
}

// The encryption that goes with a port, so an owner who only knows the port
// their provider gave them never has to choose an acronym. 465 is implicit TLS,
// 25 is unencrypted, and everything else (587, 2525, …) is STARTTLS — the modern
// submission default.
function inferSecurityFromPort(port) {
  if (port === 465) return 'tls';
  if (port === 25) return 'none';
  return 'starttls';
}

// Turns whatever the form submitted into either a valid, normalized relay or a
// coded error. `keepExistingPassword` is set by the service when the password
// field came back empty on an already-configured relay: an owner editing the
// from-name should not have to retype the relay password, exactly as the HTTPS
// form never returns the Cloudflare token. When it is set, an empty password is
// carried through as `undefined` (meaning "unchanged") instead of failing.
function validateSmtpInput(rawInput, { keepExistingPassword = false } = {}) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};

  const host = asString(input.host).trim();
  const username = asString(input.username).trim();
  const fromAddress = asString(input.fromAddress).trim();
  const fromName = asString(input.fromName).trim();
  const rawPassword = asString(input.password);
  const allowInvalidCert = input.allowInvalidCert === true;

  // "auto" (and an unspecified choice) match the encryption to the port, so an
  // owner only has to enter the host, port and login their provider gave them.
  // An explicit mode is honoured as-is.
  const requestedSecurity = asString(input.security).trim().toLowerCase();
  const portGiven = !(input.port === undefined || input.port === null || asString(input.port).trim() === '');
  const givenPort = portGiven ? Number(input.port) : null;
  let security;
  let portRaw;
  if (requestedSecurity === 'auto' || requestedSecurity === '') {
    security = portGiven ? inferSecurityFromPort(givenPort) : 'starttls';
    portRaw = portGiven ? givenPort : DEFAULT_SMTP_PORTS.starttls;
  } else {
    security = normalizeSecurity(requestedSecurity);
    portRaw = portGiven ? givenPort : DEFAULT_SMTP_PORTS[security];
  }

  if (!HOST_PATTERN.test(host)) {
    throw new SmtpSettingsError('INVALID_SMTP_HOST', 'Enter the relay host as a hostname or IP address, with no scheme or port.');
  }
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new SmtpSettingsError('INVALID_SMTP_PORT', 'Enter a relay port between 1 and 65535.');
  }
  if (!EMAIL_PATTERN.test(fromAddress)) {
    throw new SmtpSettingsError('INVALID_SMTP_FROM_ADDRESS', 'Enter the address messages should be sent from as a valid email address.');
  }
  if (fromName && !FROM_NAME_PATTERN.test(fromName)) {
    throw new SmtpSettingsError('INVALID_SMTP_FROM_NAME', 'The sender display name cannot contain quotes, angle brackets, or line breaks.');
  }

  // Auth is optional — an open LAN relay needs none — but half a credential is
  // always a mistake worth catching before it reaches the wire.
  const password = keepExistingPassword && rawPassword.trim() === '' ? undefined : rawPassword;
  const hasUsername = username.length > 0;
  const hasPassword = password !== undefined ? password.length > 0 : keepExistingPassword;
  if (hasUsername !== hasPassword) {
    throw new SmtpSettingsError(
      'INVALID_SMTP_CREDENTIALS',
      hasUsername
        ? 'This relay has a username but no password. Enter the password, or clear the username for an unauthenticated relay.'
        : 'This relay has a password but no username. Enter the username, or clear the password for an unauthenticated relay.',
    );
  }
  if (security === 'none' && hasUsername && !allowInvalidCert) {
    // Sending a password over an unencrypted connection is a downgrade an owner
    // should have to opt into on purpose, not something the form does quietly.
    throw new SmtpSettingsError(
      'INSECURE_SMTP_CREDENTIALS',
      'Sending a username and password without encryption exposes them on your network. Choose STARTTLS or TLS, or acknowledge the insecure relay explicitly.',
    );
  }

  return {
    allowInvalidCert,
    fromAddress,
    fromName,
    host,
    // Only present when the caller supplied one; `undefined` means "keep what is
    // stored", which the service turns into no write of the password secret.
    ...(password === undefined ? {} : { password }),
    port: portRaw,
    security,
    username,
  };
}

module.exports = {
  DEFAULT_SMTP_PORTS,
  EMAIL_PATTERN,
  SMTP_SECURITY_MODES,
  SMTP_TEMPLATE_KEYS,
  SmtpSettingsError,
  inferSecurityFromPort,
  normalizeSecurity,
  validateSmtpInput,
};
