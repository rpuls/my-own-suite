const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_DIAGNOSTICS_CHARS,
  buildOperationDiagnostics,
} = require('../src/diagnostics/operation-diagnostics.cjs');

function agentError(message, { code, details } = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}

test('keeps the agent stage code and its plain-language message', () => {
  const result = buildOperationDiagnostics(agentError('The app image could not be built.', { code: 'APP_BUILD_FAILED' }));
  assert.equal(result.errorCode, 'APP_BUILD_FAILED');
  assert.equal(result.diagnostics, 'The app image could not be built.');
});

test('falls back to the caller\'s code when the agent supplied none', () => {
  assert.equal(buildOperationDiagnostics(agentError('something went wrong'), { fallbackCode: 'APP_RUNTIME_APPLY_FAILED' }).errorCode, 'APP_RUNTIME_APPLY_FAILED');
  assert.equal(buildOperationDiagnostics(null).errorCode, 'OPERATION_FAILED');
});

test('records nothing rather than an empty string when there is no message', () => {
  assert.equal(buildOperationDiagnostics(agentError('')).diagnostics, null);
});

test('renders agent details as a readable list', () => {
  const result = buildOperationDiagnostics(agentError('The app container could not be started.', {
    code: 'APP_RUN_FAILED',
    details: ['port 3000 already allocated', 'container exited with code 1'],
  }));
  assert.equal(result.diagnostics, [
    'The app container could not be started.',
    '',
    'Details:',
    '- port 3000 already allocated',
    '- container exited with code 1',
  ].join('\n'));
});

test('keeps a command\'s output under the bullet that introduces it', () => {
  const result = buildOperationDiagnostics(agentError('The app container could not be started.', {
    details: ['docker run for service "web" exited with code 125.', 'Last output:\n  docker: Error response from daemon:\n  Bind for 0.0.0.0:18080 failed: port is already allocated.'],
  }));
  assert.equal(result.diagnostics, [
    'The app container could not be started.',
    '',
    'Details:',
    '- docker run for service "web" exited with code 125.',
    '- Last output:',
    '    docker: Error response from daemon:',
    '    Bind for 0.0.0.0:18080 failed: port is already allocated.',
  ].join('\n'));
});

test('caps the detail list and says how many were left out', () => {
  const details = Array.from({ length: 16 }, (_, index) => `detail ${index}`);
  const result = buildOperationDiagnostics(agentError('failed', { details }));
  assert.ok(result.diagnostics.includes('- detail 11'));
  assert.ok(!result.diagnostics.includes('- detail 12'));
  assert.ok(result.diagnostics.includes('…and 4 more'));
});

test('stringifies a non-string detail rather than throwing away the failure', () => {
  const result = buildOperationDiagnostics(agentError('failed', { details: [{ service: 'db', exitCode: 1 }] }));
  assert.ok(result.diagnostics.includes('{"service":"db","exitCode":1}'));
});

test('bounds diagnostics so one pathological failure cannot dominate a bundle', () => {
  const result = buildOperationDiagnostics(agentError('x'.repeat(MAX_DIAGNOSTICS_CHARS + 750)));
  assert.ok(result.diagnostics.length < MAX_DIAGNOSTICS_CHARS + 100);
  assert.match(result.diagnostics, /…\[truncated 750 chars\]$/u);
});

test('holds two full command tails, so a failed rollback keeps both reasons', () => {
  const tail = `Last output:\n${'  a line of build output that says nothing new\n'.repeat(170)}`.trimEnd();
  const result = buildOperationDiagnostics(agentError('The app update could not be activated.', {
    details: ['docker run for service "web" exited with code 1.', tail, 'Restarting the previous version then failed too:', 'docker run for service "web" exited with code 1.', tail],
  }));
  assert.ok(tail.length >= 8_000, 'each tail is at least the agent\'s own cap');
  assert.ok(!result.diagnostics.includes('[truncated'));
});

test('redacts known secret values on the way in, inside command output too', () => {
  const result = buildOperationDiagnostics(
    agentError('could not connect', { details: ['Last output:\n  psql: password authentication failed for s3cret-database-password'] }),
    { secrets: ['s3cret-database-password'] },
  );
  assert.ok(!result.diagnostics.includes('s3cret-database-password'));
  assert.ok(result.diagnostics.includes('[redacted]'));
});
