const { CodedError } = require('../../../../shared/coded-error.cjs');
const { SetupError } = require('../setup/setup-service.cjs');

// A sign-in from the throttle to the session. The route sets the cookies.
class SignInService {
  constructor({ alerts, recordSecurityEvent, securityLogger, setup, throttle, vault }) {
    this.alerts = alerts;
    this.recordSecurityEvent = recordSecurityEvent;
    this.securityLogger = securityLogger;
    this.setup = setup;
    this.throttle = throttle;
    this.vault = vault;
  }

  // Answers the session token, plus a known-browser token for a browser that has
  // not signed in before.
  async signIn({ credentials, ip, knownBrowserToken }) {
    const knownBrowser = this.setup.isKnownBrowser(knownBrowserToken || '');
    const attempt = { email: credentials.email, ip, knownBrowser };
    const retryAfterMs = this.throttle.retryAfterMs(attempt);
    if (retryAfterMs > 0) throw this.#throttled(attempt, retryAfterMs);

    let result;
    try {
      result = await this.setup.login(credentials);
    } catch (error) {
      if (error instanceof SetupError && (error.code === 'INVALID_LOGIN' || error.code === 'OWNER_NOT_CREATED')) {
        this.throttle.recordFailure(attempt);
      }
      throw error;
    }
    this.throttle.recordSuccess(attempt);
    // The one moment MOS holds this password unasked, so the only chance to
    // finish a chip enrollment that failed earlier. The sign-in does not wait.
    void this.vault.repairOnSignIn(credentials.password);
    return {
      knownBrowserToken: knownBrowser ? null : this.setup.rememberBrowser(),
      owner: result.owner,
      sessionToken: result.sessionToken,
      status: result.status,
    };
  }

  #throttled(attempt, retryAfterMs) {
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
    const securityEvent = {
      clientFingerprint: this.throttle.fingerprint(attempt.ip),
      event: 'login-throttled',
      retryAfterSeconds,
    };
    try {
      this.recordSecurityEvent({
        at: new Date().toISOString(),
        eventType: securityEvent.event,
        retryAfterSeconds,
        subject: securityEvent.clientFingerprint,
      });
    } catch {
      this.securityLogger({ event: 'security-event-persistence-failed' });
    }
    this.securityLogger(securityEvent);
    // Not awaited: the refusal must not wait on a relay, and a relay that fails
    // is logged rather than allowed to change the answer.
    this.alerts.notify().catch((error) => this.securityLogger({ error: error.message, event: 'sign-in-alert-failed' }));
    return new CodedError('LOGIN_THROTTLED', 'Too many sign-in attempts. Wait a moment and try again.', { retryAfterSeconds, statusCode: 429 });
  }
}

module.exports = { SignInService };
