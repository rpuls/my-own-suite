#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const {
  generateSigningKeyPair,
  readSigningPublicKey,
  signCatalogBytes,
  verifyCatalogSignature,
} = require('../suite-manager/backend/src/apps/catalog-signature.cjs');

// Signs the generated catalog and the authored advisory feed with the MOS
// publisher's Ed25519 key. Installed MOS boxes verify these against the public
// key in `trust/`, which ships with the release, so pushing to this repository
// is not by itself enough to change what an installed box treats as reviewed or
// to withhold an advisory from it.
//
// The private key never lives in this repository. It is read from the file named
// by MOS_CATALOG_SIGNING_KEY, so it can sit in a password manager or a CI secret
// and be written to a temporary file only for the moment a release is signed.
const repoRoot = path.resolve(__dirname, '..');
const publicKeyPath = path.join(repoRoot, 'trust', 'official-catalog.pub');
const signedFiles = ['catalog.json', 'advisories.json'].map((name) => ({
  name,
  path: path.join(repoRoot, 'apps', name),
  signaturePath: path.join(repoRoot, 'apps', `${name}.sig`),
}));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function generateKey(destination) {
  if (!destination) {
    fail('Pass the path to write the private key to: npm run apps:catalog:sign -- --generate-key <path>\nWrite it outside this repository.');
  }
  if (fs.existsSync(destination)) {
    fail(`Refusing to overwrite an existing key at ${destination}. Signing keys are not recoverable once replaced.`);
  }
  if (path.resolve(destination).startsWith(`${repoRoot}${path.sep}`)) {
    fail('Refusing to write a signing key inside the repository. Choose a path outside it.');
  }
  const { privateKey, publicKey } = generateSigningKeyPair();
  fs.writeFileSync(destination, privateKey, { mode: 0o600 });
  fs.mkdirSync(path.dirname(publicKeyPath), { recursive: true });
  fs.writeFileSync(publicKeyPath, publicKey);
  process.stdout.write([
    `Wrote the private key to ${destination} (keep it; it is not recoverable).`,
    `Wrote the public key to ${path.relative(repoRoot, publicKeyPath)} (commit it).`,
    '',
    'Every installed MOS verifies the catalog against the committed public key, so',
    'replacing it only takes effect for a box once it takes a MOS release carrying',
    'the new key. Re-sign the catalog before committing:',
    `  MOS_CATALOG_SIGNING_KEY=${destination} npm run apps:catalog:sign`,
    '',
  ].join('\n'));
}

function sign() {
  const keyPath = process.env.MOS_CATALOG_SIGNING_KEY;
  if (!keyPath) fail('Set MOS_CATALOG_SIGNING_KEY to the path of the publisher signing key.');
  if (!fs.existsSync(keyPath)) fail(`No signing key at ${keyPath}.`);
  const privateKey = fs.readFileSync(keyPath, 'utf8');
  for (const file of signedFiles) {
    if (!fs.existsSync(file.path)) fail(`Nothing to sign at ${path.relative(repoRoot, file.path)}. Run npm run apps:catalog first.`);
    const signature = signCatalogBytes(fs.readFileSync(file.path), privateKey);
    fs.writeFileSync(file.signaturePath, `${signature}\n`);
    process.stdout.write(`Signed ${path.relative(repoRoot, file.path)}.\n`);
  }
  verify();
}

// Run after signing as well as on its own: a signature that does not verify
// against the committed public key is a release that every installed box will
// refuse, and finding that out here is far cheaper than finding it out there.
function verify() {
  if (!fs.existsSync(publicKeyPath)) fail(`No catalog signing key at ${path.relative(repoRoot, publicKeyPath)}. Generate one with --generate-key.`);
  const publicKey = readSigningPublicKey(fs.readFileSync(publicKeyPath, 'utf8'));
  const stale = signedFiles.filter((file) => !fs.existsSync(file.signaturePath)
    || !verifyCatalogSignature({
      bytes: fs.readFileSync(file.path),
      publicKey,
      signature: fs.readFileSync(file.signaturePath, 'utf8'),
    }));
  if (stale.length) {
    fail([
      `These files are not signed by ${path.relative(repoRoot, publicKeyPath)}: ${stale.map((file) => file.name).join(', ')}.`,
      'Every installed MOS will refuse this catalog. Re-sign it:',
      '  MOS_CATALOG_SIGNING_KEY=<key path> npm run apps:catalog:sign',
    ].join('\n'));
  }
  process.stdout.write('Catalog and advisory signatures verify against the committed public key.\n');
}

const [command, argument] = process.argv.slice(2);
if (command === '--generate-key') generateKey(argument);
else if (command === '--check') verify();
else if (!command) sign();
else fail('Usage: sign-app-catalog.cjs [--generate-key <path> | --check]');
