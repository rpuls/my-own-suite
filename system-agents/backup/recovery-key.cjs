// The recovery key: the one backup secret an owner holds themselves.
//
// The key IS the repository password. There is no wrapping layer and no derived
// secret, so the string printed on an owner's recovery kit is the string that
// opens the encrypted store in a bucket after the server that wrote it is gone.
// A repository may accept more than one of them, which is what lets a
// replacement machine take over backups the original wrote.
//
// Crockford base32 because it is the alphabet that survives handwriting: it
// leaves out I, L, O and U, and reading a written I or L back as 1 and a written
// O as 0 turns the four remaining confusions into the character the writer
// meant. The trailing group is a checksum, so a mistyped key is answered as a
// typo rather than as a wrong key — the difference between "look again" and
// "your backups are lost".

const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'MOS';
const PAYLOAD_LENGTH = 28;
const CHECKSUM_LENGTH = 4;
const GROUP_LENGTH = 4;
const MISTYPED_SHAPE = 'That recovery key looks mistyped: a MOS recovery key is MOS- followed by eight groups of four characters.';
const MISTYPED_CHECKSUM = 'That recovery key looks mistyped. Check it against your recovery kit — one of its characters does not match the rest.';
const MISSING_KEY = 'Enter the recovery key from your recovery kit.';

// The first 20 bits of SHA-256 over the payload characters, in the same
// alphabet: four more characters, and a single-character slip has one chance in
// a million of passing.
function encodeChecksum(payload) {
  const digest = crypto.createHash('sha256').update(payload, 'utf8').digest();
  const bits = (digest[0] << 12) | (digest[1] << 4) | (digest[2] >> 4);
  let checksum = '';
  for (let index = CHECKSUM_LENGTH - 1; index >= 0; index -= 1) checksum += ALPHABET[(bits >> (index * 5)) & 31];
  return checksum;
}

function canonical(body) {
  const groups = [];
  for (let index = 0; index < body.length; index += GROUP_LENGTH) groups.push(body.slice(index, index + GROUP_LENGTH));
  return `${PREFIX}-${groups.join('-')}`;
}

// 140 bits of random material. Masking each random byte to five bits is uniform
// rather than biased, because 256 divides exactly by 32.
function generate() {
  let payload = '';
  for (const byte of crypto.randomBytes(PAYLOAD_LENGTH)) payload += ALPHABET[byte & 31];
  return { key: canonical(payload + encodeChecksum(payload)) };
}

// Forgiving on the way in, canonical on the way out: case, hyphens, spaces and
// the MOS- prefix are all optional, because someone reading their own
// handwriting back into a browser at the worst moment of their year should not
// be fighting the field.
function normalize(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: MISSING_KEY };
  let compact = raw.toUpperCase().replace(/[\s_-]+/gu, '');
  if (compact.startsWith(PREFIX) && compact.length === PREFIX.length + PAYLOAD_LENGTH + CHECKSUM_LENGTH) compact = compact.slice(PREFIX.length);
  const body = compact.replace(/[IL]/gu, '1').replace(/O/gu, '0');
  if (body.length !== PAYLOAD_LENGTH + CHECKSUM_LENGTH) return { error: MISTYPED_SHAPE };
  if ([...body].some((character) => !ALPHABET.includes(character))) return { error: MISTYPED_SHAPE };
  const payload = body.slice(0, PAYLOAD_LENGTH);
  if (body.slice(PAYLOAD_LENGTH) !== encodeChecksum(payload)) return { error: MISTYPED_CHECKSUM };
  return { key: canonical(body) };
}

// A short digest that says whether two machines hold the same key without
// showing either of them. This is what the UI and the acknowledgement record
// carry; the key itself is never written into either.
function fingerprint(key) {
  const { key: normalized } = normalize(key);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

// True only for a key already in canonical form, which is the form MOS writes.
// A pre-release 64-hex repository password fails it, and that is how the agent
// recognises one at startup.
function isRecoveryKey(value) {
  return normalize(value).key === String(value ?? '').trim();
}

module.exports = {
  fingerprint,
  generate,
  isRecoveryKey,
  MISTYPED_CHECKSUM,
  MISTYPED_SHAPE,
  normalize,
  RECOVERY_KEY_PREFIX: PREFIX,
};
