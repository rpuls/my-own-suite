// Tells the owner, by email, that someone has been trying their password. The
// throttle is what stops the guessing; this is what makes it visible to a person
// who would otherwise learn about it only under Settings after signing in.
//
// Bounded to one message per window, and the window is claimed before the relay
// is tried: an attacker who can provoke a throttled attempt at will must not be
// able to make MOS open a relay connection at will, and a relay that is broken
// must not be retried on every one of their attempts.

const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

function describeWindow(sinceMs) {
  const hours = Math.round(sinceMs / (60 * 60 * 1_000));
  return hours === 24 ? 'the last day' : `the last ${hours} hours`;
}

function renderSignInAlert({ homeHost, summary, windowMs }) {
  const count = summary?.eventCount || 0;
  const addresses = summary?.subjectCount || 0;
  const server = homeHost ? ` at ${homeHost}` : '';
  return {
    subject: 'Someone tried to sign in to your My Own Suite',
    text: [
      `Someone has been trying to sign in to your My Own Suite server${server} as you, and was turned away after repeated wrong passwords.`,
      '',
      `In ${describeWindow(windowMs)}: ${count} attempt${count === 1 ? '' : 's'} turned away, from ${addresses} address${addresses === 1 ? '' : 'es'}. Your password was not accepted.`,
      '',
      'If this was you mistyping your password, there is nothing to do.',
      '',
      'If it was not you, your server is holding: nobody gets in without the password, and every wrong guess is slowed down further. Signing in yourself works as usual from a browser you have used before. If you want to be sure, change your password under Settings once you are signed in.',
      '',
      'My Own Suite sends at most one of these messages a day.',
    ].join('\n'),
  };
}

class SignInAlerts {
  constructor({ homeHost = '', logger = null, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = () => new Date(), smtpSettings, store }) {
    this.homeHost = homeHost;
    this.logger = logger;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.smtpSettings = smtpSettings;
    this.store = store;
  }

  async notify() {
    const at = this.now();
    const lastSentAt = this.store.getSignInAlertSentAt();
    if (lastSentAt && at.getTime() - Date.parse(lastSentAt) < this.minIntervalMs) return { reason: 'recent', sent: false };
    if (!this.smtpSettings.canSendToOwner()) return { reason: 'no-relay', sent: false };

    this.store.markSignInAlertSent(at.toISOString());
    const since = new Date(at.getTime() - this.minIntervalMs).toISOString();
    const summary = this.store.getSecurityEventSummary({ since }).byType.find((row) => row.eventType === 'login-throttled');
    const message = renderSignInAlert({ homeHost: this.homeHost, summary, windowMs: this.minIntervalMs });
    try {
      await this.smtpSettings.sendToOwner(message);
    } catch (error) {
      this.logger?.warn?.('sign-in-alert-failed', { error: error.message });
      return { reason: 'send-failed', sent: false };
    }
    return { sent: true };
  }
}

module.exports = { DEFAULT_MIN_INTERVAL_MS, SignInAlerts, renderSignInAlert };
