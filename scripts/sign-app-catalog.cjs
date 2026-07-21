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
// The private key never lives in this repository. It stays in the publisher's
// password manager or a CI secret and reaches this script only for the moment a
// release is signed: pasted at a hidden interactive prompt, piped on stdin, or —
// for CI — named by MOS_CATALOG_SIGNING_KEY as either a file path or the PEM
// itself. It is deliberately never accepted as a command-line argument, because
// arguments land in shell history and are visible to every process on the host.
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
    '  npm run apps:catalog:sign   (prompts you to paste the key; input stays hidden)',
    '',
  ].join('\n'));
}

// Password managers flatten multi-line secrets in ways PEM parsing rejects:
// header/body/footer joined onto one line, literal "\n" sequences, stray spaces
// in the base64 body. Terminals add their own noise around a paste (bracketed
// paste escape sequences, carriage returns). Rebuilding the PEM from its BEGIN/
// END span makes every one of those pastes sign identically to the original
// file, and drops anything outside the markers so terminal noise never reaches
// the parser.
function normalizePastedKey(raw) {
  const text = String(raw).replace(/\\n/gu, '\n');
  const match = text.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/u);
  if (!match) return text.trim();
  const body = match[2].replace(/\s+/gu, '');
  return `-----BEGIN ${match[1]}-----\n${(body.match(/.{1,64}/gu) || []).join('\n')}\n-----END ${match[1]}-----\n`;
}

// Reads the key at an interactive prompt with echo disabled, so the key shows
// up neither on screen nor in terminal scrollback. The prompt finishes on its
// own once the PEM footer has arrived — a paste needs no extra keypress — and
// prompt text goes to stderr so redirecting stdout never captures anything
// prompt-related.
function readKeyInteractively() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write('Paste the publisher signing key PEM (input is hidden): ');
    let buffer = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      if (chunk.includes('\u0003')) {
        stdin.setRawMode(false);
        process.stderr.write('\nCancelled.\n');
        process.exit(130);
      }
      buffer += chunk;
      if (/-----END [A-Z0-9 ]+-----/u.test(buffer)) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\nKey received.\n');
        resolve(buffer);
      }
    };
    stdin.on('data', onData);
  });
}

function readKeyFromPipe() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function resolvePrivateKey() {
  const configured = process.env.MOS_CATALOG_SIGNING_KEY;
  if (configured) {
    if (/PRIVATE KEY/u.test(configured)) return configured;
    if (!fs.existsSync(configured)) fail(`No signing key at ${configured}.`);
    return fs.readFileSync(configured, 'utf8');
  }
  return process.stdin.isTTY ? readKeyInteractively() : readKeyFromPipe();
}

async function sign() {
  const privateKey = normalizePastedKey(await resolvePrivateKey());
  if (!/PRIVATE KEY/u.test(privateKey)) {
    fail('That input does not look like a private key PEM. Paste the full key including its BEGIN/END lines, pipe it on stdin, or set MOS_CATALOG_SIGNING_KEY to the key file path.');
  }
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
      '  npm run apps:catalog:sign   (prompts you to paste the key; input stays hidden)',
    ].join('\n'));
  }
  process.stdout.write('Catalog and advisory signatures verify against the committed public key.\n');
}

const [command, argument] = process.argv.slice(2);
if (command === '--generate-key') generateKey(argument);
else if (command === '--check') verify();
else if (!command) sign();
else fail('Usage: sign-app-catalog.cjs [--generate-key <path> | --check]');
