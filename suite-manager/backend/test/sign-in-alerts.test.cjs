const assert = require('node:assert/strict');
const test = require('node:test');

const { SignInAlerts, renderSignInAlert } = require('../src/auth/sign-in-alerts.cjs');

function fakeStore({ lastSentAt = null, summary = { eventCount: 7, eventType: 'login-throttled', subjectCount: 2 } } = {}) {
  return {
    getSecurityEventSummary: () => ({ byType: summary ? [summary] : [] }),
    getSignInAlertSentAt: function get() { return this.lastSentAt; },
    lastSentAt,
    markSignInAlertSent: function mark(at) { this.lastSentAt = at; },
  };
}

function fakeRelay({ configured = true, fail = false } = {}) {
  return {
    canSendToOwner: () => configured,
    sent: [],
    async sendToOwner(message) {
      if (fail) throw new Error('relay refused');
      this.sent.push(message);
      return { messageId: '<id@example.com>' };
    },
  };
}

test('the first throttled sign-in sends one message naming the count, and the next day another', async () => {
  let now = Date.parse('2026-09-07T10:00:00.000Z');
  const store = fakeStore();
  const relay = fakeRelay();
  const alerts = new SignInAlerts({ homeHost: 'home.example.net', now: () => new Date(now), smtpSettings: relay, store });

  assert.deepEqual(await alerts.notify(), { sent: true });
  assert.equal(relay.sent.length, 1);
  assert.match(relay.sent[0].subject, /tried to sign in/u);
  assert.match(relay.sent[0].text, /home\.example\.net/u);
  assert.match(relay.sent[0].text, /7 attempts turned away, from 2 addresses/u);

  now += 6 * 60 * 60 * 1_000;
  assert.deepEqual(await alerts.notify(), { reason: 'recent', sent: false });
  assert.equal(relay.sent.length, 1);

  now += 19 * 60 * 60 * 1_000;
  assert.deepEqual(await alerts.notify(), { sent: true });
  assert.equal(relay.sent.length, 2);
});

test('no relay means no message and nothing claimed', async () => {
  const store = fakeStore();
  const relay = fakeRelay({ configured: false });
  const alerts = new SignInAlerts({ smtpSettings: relay, store });

  assert.deepEqual(await alerts.notify(), { reason: 'no-relay', sent: false });
  assert.equal(store.lastSentAt, null);
});

// The window is claimed before the relay is tried, so an attacker who can
// provoke throttled attempts cannot make MOS hammer a broken relay.
test('a relay that fails is not retried until the next window', async () => {
  const warnings = [];
  const store = fakeStore();
  const relay = fakeRelay({ fail: true });
  const alerts = new SignInAlerts({ logger: { warn: (event, detail) => warnings.push([event, detail]) }, smtpSettings: relay, store });

  assert.deepEqual(await alerts.notify(), { reason: 'send-failed', sent: false });
  assert.ok(store.lastSentAt);
  assert.deepEqual(await alerts.notify(), { reason: 'recent', sent: false });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'sign-in-alert-failed');
});

test('the message carries counts and the server name, never an address or the email', () => {
  const { subject, text } = renderSignInAlert({ homeHost: 'home.mos.home', summary: { eventCount: 1, subjectCount: 1 }, windowMs: 24 * 60 * 60 * 1_000 });
  assert.equal(subject, 'Someone tried to sign in to your My Own Suite');
  assert.match(text, /1 attempt turned away, from 1 address\./u);
  assert.match(text, /at most one of these messages a day/u);
  assert.doesNotMatch(text, /\d+\.\d+\.\d+\.\d+|@/u);
});
