'use strict';

// The one place a stored SMTP relay is read back into a usable shape, shared by
// the settings service (which verifies and sends through it) and the app runtime
// (which resolves ${smtp.*} from it). Keeping it here means the password is read
// from disk by exactly one rule, and the key names an app sees can never drift
// from the columns the store persists.

const { SMTP_TEMPLATE_KEYS } = require('../../../../shared/smtp-contract.cjs');

// Reads the configured relay and its password into a plain object, or reports it
// unconfigured. `readSecret(ref)` is injected so the caller supplies its own
// secret reader bound to the right directory; it is only called when a password
// reference exists, and a password that cannot be read is surfaced as an error
// by the caller rather than silently blanked.
function readStoredRelay(store, readSecret) {
  const settings = store.getSmtpSettings();
  if (!settings || !settings.host) return { configured: false, relay: null, settings: settings || null };
  const password = settings.passwordRef ? readSecret(settings.passwordRef) : '';
  return {
    configured: true,
    relay: {
      allowInvalidCert: settings.allowInvalidCert === 1 || settings.allowInvalidCert === true,
      fromAddress: settings.fromAddress || '',
      fromName: settings.fromName || '',
      host: settings.host,
      password,
      port: settings.port,
      security: settings.security || 'starttls',
      username: settings.username || '',
    },
    settings,
  };
}

// The ${smtp.*} values an app resolves, as a Map keyed by SMTP_TEMPLATE_KEYS.
// Everything is a string because it lands in a container's environment; the port
// becomes its decimal text.
//
// It always returns a full map — even for no relay, where every value is empty
// and `configured` is "false". That is deliberate and different from an unset
// owner-env name: an app wired to ${smtp.host} must see an empty host when there
// is no relay (so its own mailer stays off), never the literal reference text.
// Materialize passes this map; the store-time render passes no smtp option at
// all, which is what keeps ${smtp.*} literal in the stored projection and out of
// the digest.
function smtpTemplateValues(relay) {
  const configured = Boolean(relay);
  const security = relay?.security || 'starttls';
  const map = new Map();
  const source = {
    allowInvalidCert: configured && relay?.allowInvalidCert ? 'true' : 'false',
    configured: configured ? 'true' : 'false',
    fromAddress: relay?.fromAddress || '',
    fromName: relay?.fromName || '',
    host: relay?.host || '',
    // Two booleans derived from the one choice, so an app that wants the
    // Django-style pair maps ${smtp.startTls}/${smtp.implicitTls} directly. Both
    // are "false" with no relay.
    implicitTls: configured && security === 'tls' ? 'true' : 'false',
    password: relay?.password || '',
    port: relay?.port === undefined || relay?.port === null ? '' : String(relay.port),
    security: configured ? security : '',
    startTls: configured && security === 'starttls' ? 'true' : 'false',
    username: relay?.username || '',
  };
  for (const key of SMTP_TEMPLATE_KEYS) map.set(key, source[key]);
  return map;
}

module.exports = { readStoredRelay, smtpTemplateValues };
