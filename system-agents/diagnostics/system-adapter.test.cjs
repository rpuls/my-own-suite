'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_CAPTURE_BYTES, SystemDiagnosticsAdapter, capture, parseLabels, parseShowOutput } = require('./system-adapter.cjs');

test('systemctl show output is read as key/value, ignoring anything else', () => {
  const values = parseShowOutput('ActiveState=failed\nSubState=failed\nUnitFileState=enabled\n\ngarbage line\n');

  assert.deepEqual(values, { ActiveState: 'failed', SubState: 'failed', UnitFileState: 'enabled' });
  assert.deepEqual(parseShowOutput(''), {});
  assert.deepEqual(parseShowOutput(undefined), {});
});

test('a property systemd could not answer comes back empty rather than missing', () => {
  // `systemctl show` on a unit that does not exist still exits zero and prints
  // empty values, which is why unit collection never needs a failure path for
  // "no such unit".
  assert.deepEqual(parseShowOutput('ActiveState=\nUnitFileState='), { ActiveState: '', UnitFileState: '' });
});

test('docker labels are read from the single comma-separated string docker prints', () => {
  const labels = parseLabels('mos.package=immich,mos.package-version=1.119.0,mos.package-digest=abc123');

  assert.equal(labels['mos.package'], 'immich');
  assert.equal(labels['mos.package-version'], '1.119.0');
  assert.deepEqual(parseLabels(''), {});
  assert.deepEqual(parseLabels(undefined), {});
});

test('a label value containing an equals sign keeps all of it', () => {
  assert.equal(parseLabels('org.opencontainers.image.url=https://example.com/?a=b')['org.opencontainers.image.url'], 'https://example.com/?a=b');
});

test('a command that fails resolves with its output instead of rejecting', async () => {
  // The collector relies on this: `docker logs` on a container that never
  // started exits non-zero, and the message it prints is the diagnostic.
  const output = await capture(process.execPath, ['-e', 'console.error("boom"); process.exit(3);']);

  assert.match(output, /boom/u);
});

test('stderr and stdout both reach the capture', async () => {
  const output = await capture(process.execPath, ['-e', 'console.log("out"); console.error("err");']);

  assert.match(output, /out/u);
  assert.match(output, /err/u);
});

test('a command that floods is capped, keeping the newest output', async () => {
  // A container logging large lines can legitimately return tens of megabytes.
  // Collecting several of those at once on a machine already short of memory is
  // how a diagnostic makes things worse.
  const output = await capture(process.execPath, [
    '-e',
    'for (let i = 0; i < 40000; i += 1) console.log("x".repeat(64) + " line " + i);',
  ]);

  assert.ok(output.length <= MAX_CAPTURE_BYTES, `captured ${output.length} bytes`);
  assert.match(output, /line 39999/u);
  assert.ok(!output.includes(' line 0\n'), 'the oldest output should have been dropped, not the newest');
});

test('a missing binary rejects rather than resolving with silence', async () => {
  await assert.rejects(() => capture('/nonexistent/mos-diagnostics-binary', []));
});

test('a host fact whose binary is missing costs that fact and no other', async () => {
  const adapter = new SystemDiagnosticsAdapter();
  const facts = await adapter.hostFacts();

  // Not asserting which are present: this runs on Windows in development and on
  // Linux in CI. What must hold is that a missing binary never throws the whole
  // section away, and that df — the most valuable line in here — is not coupled
  // to docker being installed.
  assert.equal(typeof facts, 'object');
  assert.ok(!Object.values(facts).some((value) => value === undefined));
});
