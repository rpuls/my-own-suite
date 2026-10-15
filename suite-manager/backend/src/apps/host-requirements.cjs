const { validateArchitectureCompatibility } = require('./package-contracts.cjs');

// What a package needs from the server it runs on, as the Apps list, an install
// and an update preview all judge it. Absent declarations are "no requirement".
function declaredHostRequirements(manifest) {
  return {
    architectures: manifest?.architectures ?? null,
    https: manifest?.requirements?.https === true,
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
  return unmet;
}

function withUnmetRequirements(cards, host) {
  return cards.map((card) => ({ ...card, unmetRequirements: card.hostRequirements ? unmetHostRequirements(card.hostRequirements, host) : [] }));
}

module.exports = {
  declaredHostRequirements,
  unmetHostRequirements,
  withUnmetRequirements,
};
