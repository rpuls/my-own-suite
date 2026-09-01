const assert = require('node:assert/strict');
const test = require('node:test');

const { LIMITS, createLogger, requestId } = require('../src/server/logger.cjs');

function captureStream() {
  const lines = [];
  return {
    lines,
    records: () => lines.map((line) => JSON.parse(line)),
    write: (chunk) => { lines.push(String(chunk).replace(/\n$/u, '')); },
  };
}

function loggerFor(options = {}) {
  const stream = captureStream();
  return { logger: createLogger({ now: () => '2026-09-01T00:00:00.000Z', stream, ...options }), stream };
}

test('writes one JSON object per line with a stable envelope', () => {
  const { logger, stream } = loggerFor();
  logger.info('listening', { port: 3100 });
  assert.equal(stream.lines.length, 1);
  assert.deepEqual(stream.records()[0], {
    event: 'listening',
    level: 'info',
    port: 3100,
    ts: '2026-09-01T00:00:00.000Z',
  });
});

test('drops records below the configured level', () => {
  const { logger, stream } = loggerFor({ level: 'warn' });
  logger.debug('ignored');
  logger.info('ignored');
  logger.warn('kept');
  logger.error('kept');
  assert.deepEqual(stream.records().map((record) => record.event), ['kept', 'kept']);
});

test('serializes an error with a bounded stack', () => {
  const { logger, stream } = loggerFor();
  const error = new Error('runtime apply failed');
  error.code = 'APP_RUNTIME_APPLY_FAILED';
  error.stack = ['Error: runtime apply failed', ...Array.from({ length: 40 }, (_, index) => `    at frame${index} (file.cjs:${index}:1)`)].join('\n');
  logger.error('request-failed', { error });
  const [record] = stream.records();
  assert.equal(record.error.code, 'APP_RUNTIME_APPLY_FAILED');
  assert.equal(record.error.message, 'runtime apply failed');
  assert.equal(record.error.stack.split('\n').length, LIMITS.stackFrames);
});

test('truncates a long field and says how much went', () => {
  const { logger, stream } = loggerFor();
  logger.warn('noisy', { detail: 'x'.repeat(LIMITS.field + 500) });
  const [record] = stream.records();
  assert.match(record.detail, /…\[truncated 500 chars\]$/u);
  assert.equal(record.detail.length, LIMITS.field + '…[truncated 500 chars]'.length);
});

test('replaces a record that exceeds the record cap rather than dropping the event', () => {
  const { logger, stream } = loggerFor();
  const fields = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, 'y'.repeat(LIMITS.field)]));
  logger.error('oversized', fields);
  const [record] = stream.records();
  assert.equal(record.event, 'oversized');
  assert.equal(record.level, 'error');
  assert.match(record.note, /exceeded/u);
  assert.ok(record.droppedChars > LIMITS.record);
});

test('omits null and undefined fields instead of recording them', () => {
  const { logger, stream } = loggerFor();
  logger.info('partial', { absent: undefined, empty: null, present: 'here' });
  const [record] = stream.records();
  assert.deepEqual(Object.keys(record).sort(), ['event', 'level', 'present', 'ts']);
});

test('a caller cannot overwrite the envelope fields', () => {
  const { logger, stream } = loggerFor();
  logger.info('spoofed', { event: 'other', level: 'debug', ts: 'not-a-time' });
  const [record] = stream.records();
  assert.equal(record.event, 'spoofed');
  assert.equal(record.level, 'info');
  assert.equal(record.ts, '2026-09-01T00:00:00.000Z');
});

test('a record that cannot be serialized still reports its event', () => {
  const { logger, stream } = loggerFor();
  const circular = {};
  circular.self = circular;
  logger.error('circular', { value: circular });
  const [record] = stream.records();
  assert.equal(record.event, 'circular');
  assert.equal(typeof record.value, 'string');
});

test('a redacted secret never reaches the written line', () => {
  const { logger, stream } = loggerFor({ secretProvider: () => ['hunter2-hunter2'] });
  logger.error('leaky', { detail: 'connection string carries hunter2-hunter2 inline' });
  assert.ok(!stream.lines[0].includes('hunter2-hunter2'));
  assert.match(stream.records()[0].detail, /\[redacted\]/u);
});

test('a request reference is short and hex so it can be read off a screen', () => {
  const reference = requestId();
  assert.match(reference, /^[0-9a-f]{8}$/u);
  assert.notEqual(reference, requestId());
});

test('writes JSON when stdout is not a terminal, which is what an installed server does', () => {
  const stream = captureStream();
  createLogger({ now: () => '2026-09-01T10:04:31.000Z', stream }).info('listening', { port: 3100 });
  assert.equal(JSON.parse(stream.lines[0]).event, 'listening');
});

test('writes a readable line when stdout is a terminal, which is what a developer sees', () => {
  const stream = captureStream();
  stream.isTTY = true;
  createLogger({ now: () => '2026-09-01T10:04:31.000Z', stream }).info('listening', { host: '127.0.0.1', port: 3100 });
  assert.equal(stream.lines[0], '10:04:31 INFO  listening host=127.0.0.1 port=3100');
});

test('a readable error line leads with the message and indents its frames', () => {
  const stream = captureStream();
  const error = new Error('runtime apply failed');
  error.code = 'APP_BUILD_FAILED';
  error.stack = 'Error: runtime apply failed\n    at one (a.cjs:1:1)\n    at two (b.cjs:2:2)';
  createLogger({ now: () => '2026-09-01T10:04:31.000Z', pretty: true, stream }).error('request-failed', { error, path: '/x' });
  assert.deepEqual(stream.lines[0].split('\n'), [
    '10:04:31 ERROR request-failed path=/x',
    '  APP_BUILD_FAILED: runtime apply failed',
    '  at one (a.cjs:1:1)',
    '  at two (b.cjs:2:2)',
  ]);
});

test('redaction still applies to the readable line', () => {
  const stream = captureStream();
  createLogger({ pretty: true, secretProvider: () => ['hunter2-hunter2'], stream })
    .warn('leaky', { detail: 'password hunter2-hunter2 inline' });
  assert.ok(!stream.lines[0].includes('hunter2-hunter2'));
  assert.ok(stream.lines[0].includes('[redacted]'));
});

// Redacting the serialized line instead of the values would pass for a plain
// secret and silently fail for any secret containing a quote, a backslash or a
// newline — JSON escapes those, so the exact-value comparison no longer matches.
// That is precisely the shape a real password takes, which is why the ordering
// is asserted per encoding rather than once.
for (const [name, secret] of [
  ['a quote', 'pa"ssword-secret-value'],
  ['a backslash', 'pa\ssword-secret-value'],
  ['a newline', 'line1\nline2-secret-value'],
  ['a tab', 'pa\tssword-secret-value'],
  ['non-ascii', 'pässwörd-secret-välue'],
]) {
  test(`a secret containing ${name} is still redacted`, () => {
    const stream = captureStream();
    const logger = createLogger({ secretProvider: () => [secret], stream });
    const error = new Error(`failed for ${secret}`);
    error.code = 'APP_BUILD_FAILED';
    logger.error('leaky', { detail: `connecting with ${secret}`, error });

    assert.ok(!stream.lines[0].includes('secret-v'), `${name} survived into the written line`);
    const record = stream.records()[0];
    assert.ok(record.detail.includes('[redacted]'));
    assert.ok(record.error.message.includes('[redacted]'));
  });
}

// A secret straddling the truncation boundary must not survive as a readable
// fragment, which is why redaction runs before the field is cut.
test('a secret is redacted before truncation, not after', () => {
  const secret = 'straddling-secret-value';
  const stream = captureStream();
  createLogger({ secretProvider: () => [secret], stream })
    .warn('long', { detail: `${'x'.repeat(LIMITS.field - 10)}${secret} trailing` });
  assert.ok(!stream.lines[0].includes('straddling'));
});
