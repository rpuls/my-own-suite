const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_DIAGNOSTICS_CHARS,
  buildAppOperationDiagnostics,
} = require('../src/apps/app-operation-diagnostics.cjs');

function agentError(message, { code, details } = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}

test('keeps the agent stage code and its plain-language message', () => {
  const result = buildAppOperationDiagnostics(agentError('The app image could not be built.', { code: 'APP_BUILD_FAILED' }));
  assert.equal(result.errorCode, 'APP_BUILD_FAILED');
  assert.equal(result.diagnostics, 'The app image could not be built.');
});

test('falls back to the generic code when the agent supplied none', () => {
  assert.equal(buildAppOperationDiagnostics(agentError('something went wrong')).errorCode, 'APP_RUNTIME_APPLY_FAILED');
  assert.equal(buildAppOperationDiagnostics(null).errorCode, 'APP_RUNTIME_APPLY_FAILED');
});

test('records nothing rather than an empty string when there is no message', () => {
  assert.equal(buildAppOperationDiagnostics(agentError('')).diagnostics, null);
});

test('renders agent details as a readable list', () => {
  const result = buildAppOperationDiagnostics(agentError('The app container could not be started.', {
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

test('caps the detail list and says how many were left out', () => {
  const details = Array.from({ length: 14 }, (_, index) => `detail ${index}`);
  const result = buildAppOperationDiagnostics(agentError('failed', { details }));
  assert.ok(result.diagnostics.includes('- detail 9'));
  assert.ok(!result.diagnostics.includes('- detail 10'));
  assert.ok(result.diagnostics.includes('…and 4 more'));
});

test('stringifies a non-string detail rather than throwing away the failure', () => {
  const result = buildAppOperationDiagnostics(agentError('failed', { details: [{ service: 'db', exitCode: 1 }] }));
  assert.ok(result.diagnostics.includes('{"service":"db","exitCode":1}'));
});

test('bounds diagnostics so one pathological failure cannot dominate a bundle', () => {
  const result = buildAppOperationDiagnostics(agentError('x'.repeat(MAX_DIAGNOSTICS_CHARS + 750)));
  assert.ok(result.diagnostics.length < MAX_DIAGNOSTICS_CHARS + 100);
  assert.match(result.diagnostics, /…\[truncated 750 chars\]$/u);
});

test('redacts known secret values on the way in', () => {
  const result = buildAppOperationDiagnostics(
    agentError('could not connect using password s3cret-database-password'),
    { secrets: ['s3cret-database-password'] },
  );
  assert.ok(!result.diagnostics.includes('s3cret-database-password'));
  assert.ok(result.diagnostics.includes('[redacted]'));
});
