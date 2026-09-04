'use strict';

// The relay input contract: what a valid relay is, and what the form is refused
// for. These are the rules the settings service leans on, so they are pinned
// here rather than discovered when a bad relay reaches the wire.

const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_SMTP_PORTS, SmtpSettingsError, validateSmtpInput } = require('../../../shared/smtp-contract.cjs');

const base = { fromAddress: 'me@example.com', host: 'smtp.example.com', password: 'a-password', security: 'starttls', username: 'me@example.com' };

function rejects(input, code, options) {
  assert.throws(() => validateSmtpInput(input, options), (error) => {
    assert.ok(error instanceof SmtpSettingsError, `expected SmtpSettingsError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('a complete relay normalizes, trimming and defaulting the port', () => {
  const result = validateSmtpInput({ ...base, fromName: '  My Suite  ', host: '  smtp.example.com  ', port: '' });
  assert.equal(result.host, 'smtp.example.com');
  assert.equal(result.fromName, 'My Suite');
  assert.equal(result.port, DEFAULT_SMTP_PORTS.starttls);
  assert.equal(result.security, 'starttls');
  assert.equal(result.password, 'a-password');
});

test('each security mode has its own default port, and an explicit port wins', () => {
  assert.equal(validateSmtpInput({ ...base, port: '' }).port, 587);
  assert.equal(validateSmtpInput({ ...base, security: 'tls', port: '' }).port, 465);
  assert.equal(validateSmtpInput({ ...base, security: 'none', password: '', username: '', port: '' }).port, 25);
  assert.equal(validateSmtpInput({ ...base, port: '2525' }).port, 2525);
});

test('an unknown security mode falls back to starttls rather than failing', () => {
  assert.equal(validateSmtpInput({ ...base, security: 'ssl-maybe' }).security, 'starttls');
});

test('"auto" (and an unspecified mode) match the encryption to the port', () => {
  // The owner enters only the port their provider gave them.
  assert.equal(validateSmtpInput({ ...base, security: 'auto', port: '465' }).security, 'tls');
  assert.equal(validateSmtpInput({ ...base, security: 'auto', password: '', username: '', port: '25' }).security, 'none');
  assert.equal(validateSmtpInput({ ...base, security: 'auto', port: '587' }).security, 'starttls');
  assert.equal(validateSmtpInput({ ...base, security: 'auto', port: '2525' }).security, 'starttls');
  // Auto with no port at all defaults to STARTTLS on 587.
  const noPort = validateSmtpInput({ ...base, security: 'auto', port: '' });
  assert.equal(noPort.security, 'starttls');
  assert.equal(noPort.port, 587);
  // An empty security string behaves like auto.
  assert.equal(validateSmtpInput({ ...base, security: '', port: '465' }).security, 'tls');
});

test('a host with a scheme, a port, or a space is refused', () => {
  rejects({ ...base, host: 'https://smtp.example.com' }, 'INVALID_SMTP_HOST');
  rejects({ ...base, host: 'smtp.example.com:587' }, 'INVALID_SMTP_HOST');
  rejects({ ...base, host: 'smtp .example.com' }, 'INVALID_SMTP_HOST');
  // A bare IP is a valid relay host.
  assert.equal(validateSmtpInput({ ...base, host: '10.0.0.5' }).host, '10.0.0.5');
});

test('a port out of range is refused', () => {
  rejects({ ...base, port: '0' }, 'INVALID_SMTP_PORT');
  rejects({ ...base, port: '70000' }, 'INVALID_SMTP_PORT');
  rejects({ ...base, port: 'abc' }, 'INVALID_SMTP_PORT');
});

test('a from address must be a real email, and a from name cannot break the header', () => {
  rejects({ ...base, fromAddress: 'not-an-email' }, 'INVALID_SMTP_FROM_ADDRESS');
  rejects({ ...base, fromName: 'Evil"\r\nBcc: victim@example.com' }, 'INVALID_SMTP_FROM_NAME');
});

test('half a credential is refused in either direction', () => {
  rejects({ ...base, password: '' }, 'INVALID_SMTP_CREDENTIALS');
  rejects({ ...base, username: '' }, 'INVALID_SMTP_CREDENTIALS');
});

test('a credential over an unencrypted relay is refused unless acknowledged', () => {
  rejects({ ...base, security: 'none' }, 'INSECURE_SMTP_CREDENTIALS');
  assert.equal(validateSmtpInput({ ...base, allowInvalidCert: true, security: 'none' }).security, 'none');
});

test('a blank password keeps the stored one when the caller allows it', () => {
  const kept = validateSmtpInput({ ...base, password: '' }, { keepExistingPassword: true });
  assert.equal(Object.prototype.hasOwnProperty.call(kept, 'password'), false, 'no password is returned, meaning "unchanged"');
  // A new password still replaces it.
  assert.equal(validateSmtpInput({ ...base, password: 'new-one' }, { keepExistingPassword: true }).password, 'new-one');
});

test('an unauthenticated relay is valid with no username or password', () => {
  const result = validateSmtpInput({ fromAddress: 'me@example.com', host: 'smtp.example.com', password: '', security: 'starttls', username: '' });
  assert.equal(result.username, '');
  assert.equal(result.password, '');
});
