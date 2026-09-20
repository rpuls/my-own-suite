// The one answer to "what address does this machine serve right now". Suite
// Manager's host gate, the app routes and the Homepage links all need it, and
// three independently-derived answers is exactly how a restored machine ends up
// serving a name that Suite Manager refuses.
//
// The order is the whole rule:
//
//   1. A domain the owner applied, whatever module serves it. The test is that
//      a domain is being served — never which provider serves it, because the
//      module that owns domains is free to grow a second one without every
//      caller learning its name.
//   2. The Easy Door, which is derived from the machine's live address and is
//      therefore still correct on hardware the suite has just been moved onto.
//   3. The install-time name, last, because it describes where this machine was
//      born. On a restored machine that can name the server it was restored
//      away from — which is how a restore leaves apps pointing at the machine
//      their owner is migrating off.
//
// The door is passed in rather than detected here: the host agents read the
// live Caddyfile for its marker, Suite Manager derives it from the address
// alone, and both were already right before this module existed.

function servedDomain(httpsSettings) {
  const domain = httpsSettings?.baseDomain;
  if (!domain) return null;
  return httpsSettings.tlsMode && httpsSettings.tlsMode !== 'off' ? domain : null;
}

function servedAddress({ bootstrapContract = {}, easyDoorHost = null, environment = {}, httpsSettings = null } = {}) {
  const domain = servedDomain(httpsSettings);
  if (domain) return { host: `home.${domain}`, scheme: 'https' };
  if (easyDoorHost) return { host: easyDoorHost, scheme: 'http' };
  if (environment.MOS_HOME_HOST) return { host: environment.MOS_HOME_HOST, scheme: 'http' };
  if (bootstrapContract.MOS_HOME_URL) {
    try {
      const parsed = new URL(bootstrapContract.MOS_HOME_URL);
      return { host: parsed.hostname, scheme: parsed.protocol === 'https:' ? 'https' : 'http' };
    } catch {}
  }
  if (bootstrapContract.MOS_DOMAIN) return { host: `home.${bootstrapContract.MOS_DOMAIN}`, scheme: 'http' };
  return { host: 'home.mos.home', scheme: 'http' };
}

module.exports = { servedAddress, servedDomain };
