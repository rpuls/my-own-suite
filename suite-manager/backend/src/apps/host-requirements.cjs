const { storageRequired } = require('./app-storage.cjs');
const { effectiveRouteHost, validateArchitectureCompatibility } = require('./package-contracts.cjs');

// What a package needs from the server it runs on, as the Apps list, an install
// and an update preview all judge it. Absent declarations are "no requirement".
function declaredHostRequirements(manifest) {
  return {
    architectures: manifest?.architectures ?? null,
    https: manifest?.requirements?.https === true,
    storageDrive: storageRequired(manifest),
  };
}

// `host` facts are null when MOS cannot tell, and an unknown fact refuses
// nothing: these checks explain a failure that was coming, never invent one.
function unmetHostRequirements(declared, host = {}) {
  const unmet = declared.architectures !== null
    ? validateArchitectureCompatibility({ architectures: declared.architectures }, host.architecture ?? null)
      .map((reason) => ({ id: 'architecture', reason }))
    : [];
  if (declared.https && host.https === false) {
    unmet.push({
      id: 'https',
      reason: host.httpsPending
        ? 'This app only works over HTTPS. Your suite\'s certificate is on its way, and the app becomes available by itself when it arrives.'
        : 'This app only works over HTTPS. Serve your suite from the Easy Door or your own domain in Settings first.',
    });
  }
  if (declared.storageDrive && host.storageDrives === 0) {
    unmet.push({ id: 'storage', reason: 'Requires an extra storage device. Plug in a drive formatted as exFAT, NTFS or FAT32 to install this app.' });
  }
  return unmet;
}

// The Homepage link already serving one of the app's addresses, as an owner reads it, or null.
// `homeLinks` maps a subdomain to its link's name; Caddy refuses two sites on one address.
function addressTaken(packageId, routes, { baseHost = null, homeLinks = null } = {}) {
  for (const route of routes || []) {
    const subdomain = effectiveRouteHost(route.host, packageId);
    const link = homeLinks?.get(subdomain);
    if (link) return `${baseHost ? `${subdomain}.${baseHost}` : subdomain} is used by your Homepage link ${link}. Rename or remove that link first.`;
  }
  return null;
}

function withUnmetRequirements(cards, host) {
  return cards.map((card) => {
    const unmet = card.hostRequirements ? unmetHostRequirements(card.hostRequirements, host) : [];
    const taken = addressTaken(card.id, card.routes, host);
    return { ...card, unmetRequirements: taken ? [...unmet, { id: 'address', reason: taken }] : unmet };
  });
}

module.exports = {
  addressTaken,
  declaredHostRequirements,
  unmetHostRequirements,
  withUnmetRequirements,
};
