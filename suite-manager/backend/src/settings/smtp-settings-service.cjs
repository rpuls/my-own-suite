'use strict';

// Owns the owner's outbound email relay: storing it, proving it works, and
// sending the one test message that proves it end to end. Modeled on the HTTPS
// settings service — validate, attempt, record the outcome honestly — but with
// no host agent, because talking to an SMTP relay is an ordinary outbound
// connection the unprivileged backend makes itself. Apps read the stored relay
// through the ${smtp.*} template namespace; this service never touches app
// runtimes.

const { SmtpSettingsError, validateSmtpInput } = require('../../../../shared/smtp-contract.cjs');
const { buildOperationDiagnostics } = require('../diagnostics/operation-diagnostics.cjs');
const { readSecretValue, secretFilePath, writeSecretFile } = require('../apps/app-package-internals.cjs');
const { readStoredRelay } = require('./smtp-relay.cjs');
const smtpClient = require('./smtp-client.cjs');

// The relay password lives beside the app secrets so the diagnostics bundle's
// secret sweep already redacts it, under a reserved segment no app instance id
// (a UUID) can collide with.
const SECRET_INSTANCE = '_settings';
const SECRET_KEY = 'smtp-password';

const TEST_SUBJECT = 'My Own Suite test message';
const TEST_BODY = [
  'This is a test message from My Own Suite.',
  '',
  'If you are reading it, your outbound email relay is configured correctly and',
  'the apps you install can use it to send mail.',
].join('\n');

function publicStatus(settings, ownerEmail) {
  const configured = Boolean(settings?.host);
  return {
    allowInvalidCert: settings?.allowInvalidCert === 1 || settings?.allowInvalidCert === true,
    configured,
    configuredAt: settings?.configuredAt || null,
    fromAddress: settings?.fromAddress || null,
    fromName: settings?.fromName || null,
    host: settings?.host || null,
    lastVerify: {
      at: settings?.lastVerifyAt || null,
      diagnostics: settings?.lastVerifyDiagnostics || null,
      errorCode: settings?.lastVerifyErrorCode || null,
      status: settings?.lastVerifyStatus || 'never',
    },
    ownerEmail: ownerEmail || null,
    passwordConfigured: Boolean(settings?.passwordRef),
    port: settings?.port || null,
    security: settings?.security || 'starttls',
    username: settings?.username || null,
  };
}

class SmtpSettingsService {
  constructor({ client = smtpClient, now = () => new Date(), secretDir, store }) {
    this.client = client;
    this.now = now;
    this.secretDir = secretDir;
    this.store = store;
  }

  ownerEmail() {
    try { return this.store.getOwner()?.email || null; } catch { return null; }
  }

  status() {
    return publicStatus(this.store.getSmtpSettings(), this.ownerEmail());
  }

  // The password secrets an error message might contain, so a recorded failure
  // never carries the relay password. The stored one and any just-submitted one.
  redactionSecrets(submittedPassword) {
    const secrets = [];
    if (typeof submittedPassword === 'string' && submittedPassword) secrets.push(submittedPassword);
    const ref = this.store.getSmtpSettings()?.passwordRef;
    if (ref) {
      try { secrets.push(readSecretValue(this.secretDir, ref)); } catch { /* unreadable secret cannot leak */ }
    }
    return secrets;
  }

  // Validates and stores the relay, then verifies it. Storing and verifying are
  // one action from the owner's side, but a verify failure does not discard what
  // they typed: the relay is saved either way — our probe may be wrong where the
  // owner is right — and the failure is reported so they know it did not check
  // out. Mirrors how an HTTPS apply records its own outcome.
  async save(rawInput) {
    const existing = this.store.getSmtpSettings();
    const input = validateSmtpInput(rawInput, { keepExistingPassword: Boolean(existing?.passwordRef) });
    const at = this.now().toISOString();

    const passwordProvided = Object.prototype.hasOwnProperty.call(input, 'password');
    let passwordRef = existing?.passwordRef || null;
    if (passwordProvided) {
      passwordRef = input.password
        ? writeSecretFile(this.secretDir, SECRET_INSTANCE, SECRET_KEY, input.password)
        : this.deletePasswordSecret();
    }

    this.store.saveSmtpSettings({
      allowInvalidCert: input.allowInvalidCert,
      at,
      fromAddress: input.fromAddress,
      fromName: input.fromName,
      host: input.host,
      keepPasswordRef: !passwordProvided,
      passwordRef,
      port: input.port,
      security: input.security,
      username: input.username,
    });

    let verify = null;
    try {
      verify = await this.verify();
    } catch (error) {
      // The relay is saved; the verify result rides along so the caller can show
      // the reason without a second request. Non-SmtpSettingsError is unexpected
      // and surfaces as a generic failure rather than a stack.
      verify = {
        diagnostics: error instanceof SmtpSettingsError ? this.store.getSmtpSettings()?.lastVerifyDiagnostics || null : null,
        errorCode: error.code || 'SMTP_VERIFY_FAILED',
        reason: error.message,
        status: 'failed',
      };
    }
    return { status: this.status(), verify };
  }

  async verify() {
    const { configured, relay } = readStoredRelay(this.store, (ref) => readSecretValue(this.secretDir, ref));
    if (!configured) throw new SmtpSettingsError('SMTP_NOT_CONFIGURED', 'Configure the relay before verifying it.', 409);
    const at = this.now().toISOString();
    this.store.beginSmtpVerify(at);
    try {
      const result = await this.client.verifyRelay(relay);
      this.store.completeSmtpVerify(this.now().toISOString());
      return { secured: result.secured, status: 'verified' };
    } catch (error) {
      return this.recordFailure(error, { fallbackCode: 'SMTP_VERIFY_FAILED', password: relay.password });
    }
  }

  // Sends the fixed test message to `to`, defaulting to the owner's own address.
  // A successful send is the strongest possible verification, so it also marks
  // the relay verified.
  async sendTest({ to } = {}) {
    const { configured, relay } = readStoredRelay(this.store, (ref) => readSecretValue(this.secretDir, ref));
    if (!configured) throw new SmtpSettingsError('SMTP_NOT_CONFIGURED', 'Configure the relay before sending a test message.', 409);
    const recipient = String(to || this.ownerEmail() || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)) {
      throw new SmtpSettingsError('INVALID_SMTP_TEST_RECIPIENT', 'Enter a valid email address to send the test message to.');
    }
    const at = this.now().toISOString();
    this.store.beginSmtpVerify(at);
    try {
      const result = await this.client.sendTestMessage(relay, { subject: TEST_SUBJECT, text: TEST_BODY, to: recipient });
      this.store.completeSmtpVerify(this.now().toISOString());
      return { messageId: result.messageId, sentTo: recipient, status: 'sent' };
    } catch (error) {
      return this.recordFailure(error, { fallbackCode: 'SMTP_TEST_FAILED', password: relay.password, throwOnFailure: true });
    }
  }

  // Records a verify/send failure as a diagnostics row and either returns a
  // failed result (verify, whose caller reads status) or rethrows as an
  // SmtpSettingsError (send, whose caller expects a thrown error to surface).
  recordFailure(error, { fallbackCode, password, throwOnFailure = false }) {
    const { diagnostics, errorCode } = buildOperationDiagnostics(error, {
      fallbackCode,
      secrets: [password, ...this.redactionSecrets()].filter(Boolean),
    });
    this.store.failSmtpVerify({ at: this.now().toISOString(), diagnostics, errorCode });
    if (throwOnFailure) {
      throw new SmtpSettingsError(errorCode, error.message || 'The relay could not be reached.', 502);
    }
    return { diagnostics, errorCode, reason: error.message, status: 'failed' };
  }

  deletePasswordSecret() {
    try {
      const target = secretFilePath(this.secretDir, SECRET_INSTANCE, SECRET_KEY);
      require('node:fs').rmSync(target, { force: true });
    } catch { /* absent is the desired state */ }
    return null;
  }

  remove() {
    this.deletePasswordSecret();
    this.store.clearSmtpSettings(this.now().toISOString());
    return this.status();
  }
}

module.exports = { SmtpSettingsService, publicStatus };
