const assert = require('node:assert/strict');
const test = require('node:test');

const { CodedError } = require('../../../shared/coded-error.cjs');
const { HomepageConfigError } = require('../../../shared/homepage-contract.cjs');
const { SuiteAddressError } = require('../../../shared/suite-address.cjs');
const { ExternalSourceError } = require('../src/apps/external-source-registry.cjs');
const { OfficialCatalogError } = require('../src/apps/official-catalog-service.cjs');
const { createLogger } = require('../src/server/logger.cjs');
const { respondError } = require('../src/server/responses.cjs');
const { HttpsAgentError } = require('../src/settings/https-agent-client.cjs');
const { SetupError } = require('../src/setup/setup-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

function answer(error) {
  const logged = [];
  const response = {
    end(body) { this.body = JSON.parse(body); },
    writeHead(status, headers) { Object.assign(this, { headers, status }); },
  };
  const logger = { error: (event, fields) => logged.push({ event, ...fields }) };
  respondError(response, error, { logger, method: 'POST', requestPath: '/suite-manager/api/example' });
  return { ...response, logged };
}

const INTERNAL = 'Internal server error.';

const kinds = [
  { name: 'an unexpected throw', error: new Error('database is locked'), status: 500, code: 'INTERNAL_ERROR', message: INTERNAL, internal: true },
  { name: 'a coded error without a status', error: new OfficialCatalogError('CATALOG_UNREADABLE', 'The cached catalog could not be read.'), status: 500, code: 'CATALOG_UNREADABLE', message: INTERNAL, internal: true },
  { name: 'a coded error with details but no status', error: new CodedError('INVALID_APP_PACKAGE_CONTENTS', 'Invalid app package contents.', { details: ['Package has a stray file.'] }), status: 500, code: 'INVALID_APP_PACKAGE_CONTENTS', message: INTERNAL, internal: true },
  { name: 'a wrong password', error: new SetupError('INVALID_LOGIN', 'Email or password is incorrect.'), status: 401, code: 'INVALID_LOGIN', message: 'Email or password is incorrect.' },
  { name: 'a sign-in before setup', error: new SetupError('OWNER_NOT_CREATED', 'Create the owner first.'), status: 401, code: 'OWNER_NOT_CREATED', message: 'Create the owner first.' },
  { name: 'a second owner', error: new SetupError('OWNER_ALREADY_EXISTS', 'The MOS owner account already exists.'), status: 409, code: 'OWNER_ALREADY_EXISTS', message: 'The MOS owner account already exists.' },
  { name: 'any other setup refusal', error: new SetupError('WEAK_OWNER_PASSWORD', 'Use a longer password.'), status: 400, code: 'WEAK_OWNER_PASSWORD', message: 'Use a longer password.' },
  { name: 'an unknown source', error: new ExternalSourceError('SOURCE_NOT_FOUND', 'That package source is not registered.'), status: 404, code: 'SOURCE_NOT_FOUND', message: 'That package source is not registered.' },
  { name: 'a hostile candidate', error: new ExternalSourceError('CANDIDATE_REJECTED', 'The candidate was refused.'), status: 422, code: 'CANDIDATE_REJECTED', message: 'The candidate was refused.' },
  { name: 'a source error the table does not list', error: new ExternalSourceError('SOURCE_RATE_LIMITED', 'The git host is rate-limiting.'), status: 400, code: 'SOURCE_RATE_LIMITED', message: 'The git host is rate-limiting.' },
  { name: 'a source that could not be fetched', error: new ExternalSourceError('SOURCE_FETCH_FAILED', 'External source request failed with HTTP 404.'), status: 502, code: 'SOURCE_FETCH_FAILED', message: INTERNAL, internal: true },
  { name: 'a refused Homepage file', error: new HomepageConfigError('INVALID_HOMEPAGE_YAML', 'Homepage YAML is invalid.', 400, ['line 3: bad indent']), status: 400, code: 'INVALID_HOMEPAGE_YAML', message: 'Homepage YAML is invalid.', details: ['line 3: bad indent'] },
  { name: 'an HTTPS agent failure with its reason', error: new HttpsAgentError('HTTPS_CADDY_VALIDATION_FAILED', 'Caddy refused the configuration.', { details: ['caddy: bad site block'] }), status: 502, code: 'HTTPS_CADDY_VALIDATION_FAILED', message: 'Caddy refused the configuration.', details: ['caddy: bad site block'] },
  { name: 'a suite address error left at its default status', error: new SuiteAddressError('ADDRESS_UNREADABLE', 'The recorded address could not be read.'), status: 500, code: 'ADDRESS_UNREADABLE', message: 'The recorded address could not be read.' },
  { name: 'a busy password hasher', error: new CodedError('PASSWORD_HASHING_BUSY', 'The server is busy verifying sign-ins. Try again in a moment.', { retryAfterSeconds: 2, statusCode: 503 }), status: 503, code: 'PASSWORD_HASHING_BUSY', message: 'The server is busy verifying sign-ins. Try again in a moment.', retryAfter: '2' },
  { name: 'a status with no code', error: Object.assign(new Error('An update is already running.'), { statusCode: 409 }), status: 409, code: 'INTERNAL_ERROR', message: 'An update is already running.' },
];

for (const kind of kinds) {
  test(`${kind.name} answers ${kind.status}${kind.internal ? ' as an internal error, logged under a reference' : ' with its own message and no log line'}`, () => {
    const { body, headers, logged, status } = answer(kind.error);

    assert.equal(status, kind.status);
    assert.equal(body.code, kind.code);
    assert.equal(body.error, kind.message);
    assert.deepEqual(body.details, kind.details);
    assert.equal(headers['Retry-After'], kind.retryAfter);
    if (!kind.internal) {
      assert.equal(body.reference, undefined);
      assert.deepEqual(logged, []);
      return;
    }
    assert.match(body.reference, /^[0-9a-f]{8}$/u);
    assert.equal(logged.length, 1);
    assert.deepEqual({ ...logged[0], error: undefined }, {
      error: undefined,
      event: 'request-failed',
      method: 'POST',
      path: '/suite-manager/api/example',
      reference: body.reference,
      statusCode: kind.status,
    });
    assert.equal(logged[0].error, kind.error);
  });
}

function capturedLogger() {
  const lines = [];
  return { lines, logger: createLogger({ stream: { write: (chunk) => lines.push(JSON.parse(String(chunk))) } }) };
}

// The owner is told "Internal server error." on purpose, so the reason has to be
// written down here, under a reference a screenshot can be matched with.
test('an internal error is logged with a reference the response also carries', async () => {
  const { lines, logger } = capturedLogger();
  const signIn = { signIn: async () => { throw new Error('throttle store unavailable'); } };

  await withRoutes({ logger, signIn }, async (call) => {
    const response = await call('POST', '/auth/login?claim=secret', { body: { email: 'owner@example.com', password: 'whatever' }, signedIn: false });

    assert.equal(response.status, 500);
    const body = response.json();
    assert.equal(body.error, 'Internal server error.');
    assert.match(body.reference, /^[0-9a-f]{8}$/u);

    const logged = lines.filter((line) => line.event === 'request-failed');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].reference, body.reference);
    assert.equal(logged[0].level, 'error');
    assert.equal(logged[0].method, 'POST');
    assert.equal(logged[0].path, '/suite-manager/api/auth/login');
    assert.equal(logged[0].statusCode, 500);
    assert.equal(logged[0].error.message, 'throttle store unavailable');
    assert.ok(logged[0].error.stack.includes('throttle store unavailable'));
  });
});

// A handled error reaches the owner with its own message, so logging it would be
// noise on every mistyped password.
test('an expected client error is answered without a reference and without a log line', async () => {
  const { lines, logger } = capturedLogger();
  const signIn = { signIn: async () => { throw new SetupError('INVALID_LOGIN', 'Email or password is incorrect.'); } };

  await withRoutes({ logger, signIn }, async (call) => {
    const response = await call('POST', '/auth/login', { body: { email: 'owner@example.com', password: 'whatever' }, signedIn: false });

    assert.equal(response.status, 401);
    assert.equal(response.json().reference, undefined);
    assert.deepEqual(lines.filter((line) => line.event === 'request-failed'), []);
  });
});

test('a malformed or oversized body is a client error, answered without a log line', async () => {
  const { lines, logger } = capturedLogger();

  await withRoutes({ logger }, async (call) => {
    const malformed = await call('POST', '/setup/owner', { body: '{"email":', signedIn: false });
    const oversized = await call('POST', '/setup/owner', { body: { email: 'x'.repeat(1_100_000) }, signedIn: false });

    assert.equal(malformed.status, 400);
    assert.equal(malformed.json().code, 'REQUEST_BODY_INVALID');
    assert.equal(oversized.status, 413);
    assert.equal(oversized.json().code, 'REQUEST_BODY_TOO_LARGE');
    assert.deepEqual(lines.filter((line) => line.event === 'request-failed'), []);
  });
});
