const crypto = require('node:crypto');

// The official catalog and advisory feed are fetched over the network and then
// decide which packages MOS treats as reviewed and which installed versions have
// advisories against them. Until now the only thing standing behind that was
// "GitHub served it from the commit we asked for", which makes anyone who can
// push to the repository — or anyone who can make MOS believe they are GitHub —
// able to change that decision on every installed box at once.
//
// A detached signature moves the trust from whoever can push to whoever holds
// the signing key. The public half is read from the installed release rather
// than fetched next to the thing it verifies, because a key served by whoever
// served the catalog proves nothing about the catalog.
//
// Ed25519: small keys, no parameter choices to get wrong, and verification needs
// nothing but the bytes and the key, so a box with no network and no clock can
// still tell whether its cache was signed.
const SIGNATURE_BYTES = 64;

class CatalogSignatureError extends Error {
  constructor(message) {
    super(message);
    this.code = 'CATALOG_SIGNATURE_INVALID';
  }
}

// Git normalizes text to LF in the repository and checks it out with the
// platform's line endings (`* text=auto`), so the bytes a signer reads from a
// Windows working tree are not the bytes raw.githubusercontent.com serves for
// the same commit. Signing the file as it sits on disk would therefore verify on
// some machines and not others. Both sides canonicalize to LF first instead, the
// same normalization package digests already use.
function canonicalSignedBytes(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  return Buffer.from(text.replace(/\r\n?/gu, '\n'), 'utf8');
}

function readSigningPublicKey(pem) {
  // `crypto.createPublicKey` accepts a private key and quietly derives the public
  // half from it, so a release that shipped the signing key in place of the
  // public one would verify catalogs perfectly and never give a sign that the
  // secret was published. Nothing downstream can notice, so it is caught here.
  if (/PRIVATE KEY/u.test(String(pem))) {
    throw new CatalogSignatureError('The official catalog signing key file contains a private key; only the public key belongs in a release.');
  }
  let key;
  try {
    key = crypto.createPublicKey(String(pem));
  } catch {
    throw new CatalogSignatureError('Official catalog signing key is not a readable public key.');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new CatalogSignatureError('Official catalog signing key must be an Ed25519 public key.');
  }
  return key;
}

function readSigningPrivateKey(pem) {
  let key;
  try {
    key = crypto.createPrivateKey(String(pem));
  } catch {
    throw new CatalogSignatureError('Official catalog signing key is not a readable private key.');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new CatalogSignatureError('Official catalog signing key must be an Ed25519 private key.');
  }
  return key;
}

function signCatalogBytes(bytes, privateKey) {
  return crypto.sign(null, canonicalSignedBytes(bytes), readSigningPrivateKey(privateKey)).toString('base64');
}

// Returns a boolean rather than throwing on a bad signature: a forgery, a
// truncated file, and a key that does not match are the same answer to the only
// question being asked, and every one of them must be indistinguishable to the
// caller so none of them can be handled more leniently than the others.
function verifyCatalogSignature({ bytes, publicKey, signature }) {
  try {
    const raw = Buffer.from(String(signature || '').trim(), 'base64');
    if (raw.length !== SIGNATURE_BYTES) return false;
    return crypto.verify(null, canonicalSignedBytes(bytes), publicKey, raw);
  } catch {
    return false;
  }
}

function generateSigningKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

module.exports = {
  CatalogSignatureError,
  canonicalSignedBytes,
  generateSigningKeyPair,
  readSigningPrivateKey,
  readSigningPublicKey,
  signCatalogBytes,
  verifyCatalogSignature,
};
