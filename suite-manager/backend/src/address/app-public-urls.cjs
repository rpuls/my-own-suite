const { baseHostOf } = require('../../../../shared/suite-address.cjs');

// An app is served on its projected route host, never its package id. The id
// stands in only for a package that is not installed, to keep a well-formed URL
// for callers that echo it; runtime application derives the host itself.
function appHostLabelFor(packageId, hostFor) {
  const host = typeof hostFor === 'function' ? hostFor(packageId) : null;
  return typeof host === 'string' && host ? host : packageId;
}

// Built from the suite's one recorded address and nothing else, so every door,
// a reconcile at boot and a restore all name the same place.
function appPublicUrlFor(address, packageId, hostFor = null) {
  const baseHost = baseHostOf(address);
  const appHost = `${appHostLabelFor(packageId, hostFor)}.${baseHost}`;
  const scheme = address.scheme === 'https' ? 'https' : 'http';
  return {
    appHost,
    baseHost,
    publicUrl: `${scheme}://${appHost}/`,
    scheme,
  };
}

function appPublicUrlResolver(address, hostFor = null) {
  return (packageId) => appPublicUrlFor(address, packageId, hostFor);
}

function createAppPublicUrls({ appPackages, homepageConfig, suiteAddress }) {
  const hostFor = (packageId) => appPackages.publicRouteHostFor(packageId);
  const publicUrls = () => appPublicUrlResolver(suiteAddress.read(), hostFor);
  return {
    hostFor,
    publicUrlOf: (packageId) => publicUrls()(packageId),
    publicUrls,
    rebake: (address) => appPackages.reconcilePublicUrls(homepageConfig, { publicUrlFor: appPublicUrlResolver(address, hostFor) }),
  };
}

module.exports = { createAppPublicUrls };
