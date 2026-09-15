// The recovery key is the one MOS secret a person copies by hand, so what this
// covers is handwriting rather than cryptography: the forms a key comes back in
// when it is read off paper, and the difference between a slip and a key that
// simply is not the right one.

const assert = require('node:assert/strict');
const test = require('node:test');

const { fingerprint, generate, isRecoveryKey, MISTYPED_CHECKSUM, MISTYPED_SHAPE, normalize } = require('./recovery-key.cjs');

const KEY = generate().key;
const BODY = KEY.replace(/^MOS-/u, '').replace(/-/gu, '');

test('a generated key is MOS- and eight groups of four, in the confusable-free alphabet', () => {
  assert.match(KEY, /^MOS(-[0-9A-HJKMNP-TV-Z]{4}){8}$/u);
  // Two keys generated a moment apart must not share their random material.
  assert.notEqual(generate().key, generate().key);
});

test('a generated key normalizes back to itself', () => {
  for (let round = 0; round < 200; round += 1) {
    const { key } = generate();
    assert.equal(normalize(key).key, key);
  }
});

test('a key read off paper is accepted however it was typed back', () => {
  const variants = [
    KEY.toLowerCase(),
    BODY,
    BODY.toLowerCase(),
    `  ${KEY}  `,
    KEY.replace(/-/gu, ' '),
    KEY.replace(/-/gu, ''),
    `mos ${BODY.match(/.{4}/gu).join(' ')}`,
    // Crockford's reading rule: a written I or L is the digit 1, a written O is
    // the digit 0. A key with none of those characters in it is unaffected.
    BODY.replace(/1/gu, 'I'),
    BODY.replace(/1/gu, 'l'),
    BODY.replace(/0/gu, 'O'),
  ];
  for (const variant of variants) assert.equal(normalize(variant).key, KEY, variant);
});

test('a mistyped key is reported as a typo, never as a wrong key', () => {
  // One character changed to another legal one: the shape is right and only the
  // checksum knows.
  const swapped = `${BODY[0] === '2' ? '3' : '2'}${BODY.slice(1)}`;
  assert.equal(normalize(swapped).error, MISTYPED_CHECKSUM);
  assert.equal(normalize(swapped).key, undefined);
  // Wrong length, and a character no MOS key contains.
  assert.equal(normalize(BODY.slice(0, -1)).error, MISTYPED_SHAPE);
  assert.equal(normalize(`${BODY}X`).error, MISTYPED_SHAPE);
  assert.equal(normalize(`U${BODY.slice(1)}`).error, MISTYPED_SHAPE);
  assert.match(normalize('').error, /Enter the recovery key/u);
  for (const error of [MISTYPED_CHECKSUM, MISTYPED_SHAPE]) assert.match(error, /looks mistyped/u);
});

// A single flipped character has to be caught, because the owner who typed it
// is being told either "look again" or "these backups are not yours".
test('the checksum catches every single-character slip in a key', () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let accepted = 0;
  for (let index = 0; index < BODY.length; index += 1) {
    for (const character of alphabet) {
      if (character === BODY[index]) continue;
      const typo = `${BODY.slice(0, index)}${character}${BODY.slice(index + 1)}`;
      if (normalize(typo).key) accepted += 1;
    }
  }
  assert.equal(accepted, 0);
});

test('a fingerprint identifies a key without showing it', () => {
  const print = fingerprint(KEY);
  assert.match(print, /^[0-9a-f]{12}$/u);
  assert.equal(fingerprint(KEY.toLowerCase()), print);
  assert.equal(BODY.toLowerCase().includes(print), false);
  assert.equal(fingerprint('not a key'), null);
  assert.notEqual(fingerprint(generate().key), print);
});

// How the agent tells a pre-release 64-hex repository password from a key an
// owner could have written down.
test('only a canonical recovery key is recognised as one', () => {
  assert.equal(isRecoveryKey(KEY), true);
  assert.equal(isRecoveryKey(BODY), false);
  assert.equal(isRecoveryKey('a'.repeat(64)), false);
  assert.equal(isRecoveryKey(''), false);
});
