const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  generateSigningKeyPair,
  readSigningPublicKey,
  signCatalogBytes,
  verifyCatalogSignature,
} = require('../src/apps/catalog-signature.cjs');

const publisher = generateSigningKeyPair();
const catalogText = '{\n  "packages": {},\n  "schemaVersion": 1\n}\n';

function verify(bytes, signature, key = publisher.publicKey) {
  return verifyCatalogSignature({ bytes, publicKey: readSigningPublicKey(key), signature });
}

test('a catalog signed by the publisher verifies against the published key', () => {
  assert.equal(verify(catalogText, signCatalogBytes(catalogText, publisher.privateKey)), true);
  assert.equal(verify(Buffer.from(catalogText), signCatalogBytes(Buffer.from(catalogText), publisher.privateKey)), true);
});

// `.gitattributes` sets `* text=auto`, so the repository stores LF and a Windows
// working tree checks out CRLF, while raw.githubusercontent.com serves the LF
// the commit holds. A signature over the file as it sits on disk would therefore
// verify on the machine that produced it and fail on every installed box —
// silently turning "signed" into "unusable" depending on who ran the release.
test('a signature survives the line endings a checkout gives the signer', () => {
  const crlf = catalogText.replace(/\n/gu, '\r\n');
  assert.notEqual(crlf, catalogText);
  const signedOnWindows = signCatalogBytes(crlf, publisher.privateKey);
  assert.equal(verify(catalogText, signedOnWindows), true, 'a Windows-signed catalog must verify against the LF bytes GitHub serves');
  assert.equal(verify(crlf, signCatalogBytes(catalogText, publisher.privateKey)), true);
});

test('a catalog changed after signing does not verify', () => {
  const signature = signCatalogBytes(catalogText, publisher.privateKey);
  assert.equal(verify(catalogText.replace('"schemaVersion": 1', '"schemaVersion": 2'), signature), false);
  assert.equal(verify(`${catalogText} `, signature), false);
  assert.equal(verify('', signature), false);
});

test('a catalog signed by any other key does not verify', () => {
  const impostor = generateSigningKeyPair();
  assert.equal(verify(catalogText, signCatalogBytes(catalogText, impostor.privateKey)), false);
  assert.equal(verify(catalogText, signCatalogBytes(catalogText, publisher.privateKey), impostor.publicKey), false);
});

// Every one of these is the same answer to the only question being asked, so
// none of them may be distinguishable to a caller who could then treat one of
// them more leniently than a forgery.
test('a signature that is missing, malformed, or the wrong size is refused like a forgery', () => {
  for (const signature of [undefined, null, '', 'not base64 at all!', Buffer.alloc(63).toString('base64'), Buffer.alloc(65).toString('base64'), signCatalogBytes(catalogText, publisher.privateKey).slice(0, -4)]) {
    assert.equal(verify(catalogText, signature), false, `expected ${JSON.stringify(signature)} to be refused`);
  }
});

test('only an Ed25519 public key is accepted as a publisher key', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
  assert.throws(() => readSigningPublicKey(rsa), { code: 'CATALOG_SIGNATURE_INVALID' });
  assert.throws(() => readSigningPublicKey('-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----'), { code: 'CATALOG_SIGNATURE_INVALID' });
});

// Node derives a public key from a private one without complaint, so a release
// that shipped the signing key where the public key belongs would verify every
// catalog perfectly and give no sign at all that the secret had been published.
// Nothing downstream can tell the difference, which is exactly why this refuses.
test('a private key is refused where a release expects the public one', () => {
  assert.throws(
    () => readSigningPublicKey(publisher.privateKey),
    (error) => error.code === 'CATALOG_SIGNATURE_INVALID' && /private key/u.test(error.message),
  );
});
