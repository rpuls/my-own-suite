const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MIN_REDACTABLE_SECRET_CHARS,
  REDACTION_MARKER,
  createRedactor,
  redactValues,
} = require('../src/redaction.cjs');

test('masks every occurrence of a known value', () => {
  assert.equal(
    redactValues('DB=s3cret-database-password and again s3cret-database-password', ['s3cret-database-password']),
    `DB=${REDACTION_MARKER} and again ${REDACTION_MARKER}`,
  );
});

// A secret that contains another must be masked whole. Masking the inner one
// first would leave the outer secret's remaining characters in the text.
test('prefers the longest match so no recognisable fragment survives', () => {
  assert.equal(
    redactValues('token=abcdef-longer and abcdef', ['abcdef', 'abcdef-longer']),
    `token=${REDACTION_MARKER} and ${REDACTION_MARKER}`,
  );
});

test('leaves values too short to mask safely alone', () => {
  const short = 'a'.repeat(MIN_REDACTABLE_SECRET_CHARS - 1);
  assert.equal(redactValues(`a value of ${short} here`, [short]), `a value of ${short} here`);
});

test('masks a value exactly at the minimum length', () => {
  const atLimit = 'a'.repeat(MIN_REDACTABLE_SECRET_CHARS);
  assert.equal(redactValues(`value ${atLimit}`, [atLimit]), `value ${REDACTION_MARKER}`);
});

test('ignores empty text, a missing list, and non-string entries', () => {
  assert.equal(redactValues('', ['secret-value']), '');
  assert.equal(redactValues('unchanged'), 'unchanged');
  assert.equal(redactValues('unchanged', 'not-an-array'), 'unchanged');
  assert.equal(redactValues('unchanged', [null, undefined, 42]), 'unchanged');
});

test('a duplicate secret is masked once, not doubly replaced', () => {
  assert.equal(redactValues('x=abcdefgh', ['abcdefgh', 'abcdefgh']), `x=${REDACTION_MARKER}`);
});

test('a redactor without a provider is the identity', () => {
  assert.equal(createRedactor(null)('untouched abcdefgh'), 'untouched abcdefgh');
});

// Losing the record would be worse than the unredacted line this cannot
// actually produce: it returns the text unchanged only when it could not learn
// what to mask in the first place.
test('a redactor survives a provider that throws', () => {
  assert.equal(createRedactor(() => { throw new Error('state unavailable'); })('unchanged'), 'unchanged');
});

test('a redactor reads its values on every call, not once at construction', () => {
  let secrets = [];
  const redact = createRedactor(() => secrets);
  assert.equal(redact('value abcdefgh'), 'value abcdefgh');
  secrets = ['abcdefgh'];
  assert.equal(redact('value abcdefgh'), `value ${REDACTION_MARKER}`);
});
