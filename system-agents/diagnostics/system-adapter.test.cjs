'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_CAPTURE_BYTES, SystemDiagnosticsAdapter, capture, parseContainerList, parseLabels, parseShowOutput, serializeJournal } = require('./system-adapter.cjs');

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

// The same failure shape as a lost read, one collector over: `docker ps` with
// the daemon down exits non-zero with an error, which used to parse as an
// empty list and be printed as "No MOS containers are present" beside a
// collection note saying every source answered.
test('docker output that lists nothing because docker failed is a failed read, not an empty machine', () => {
  assert.throws(
    () => parseContainerList('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n'),
    /did not list containers: Cannot connect/u,
  );
  assert.deepEqual(parseContainerList(''), []);
  assert.deepEqual(parseContainerList('\n'), []);
  const listed = parseContainerList('WARNING: something docker wanted to say\n{"Names":"mos-app-a","Image":"img","State":"running","Status":"Up 2 hours","Labels":"a=b"}\n');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'mos-app-a');
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

// Guards the difference between "the process has exited" and "its output has
// been read", which is not a distinction the other tests here can make: a fast
// command usually wins the race by luck, so a test that spawns one and hopes
// passes whether or not the bug is present. In the field it lost 94% of the
// time — `systemctl show` returns in 3ms — and the bundle then reported healthy
// services as `unknown` with nothing in its collection notes to say a read had
// failed at all.
//
// So the wait is made observable rather than raced for: the command exits
// immediately and leaves a writer holding the same stdout. Resolving on `exit`
// returns the empty string it has by then; resolving on `close` waits for the
// stream, which is the contract. POSIX only, because Windows does not hand
// inherited stdout to a grandchild this way — MOS and CI both run Linux.
test('output still on its way when the process exits is not lost', { skip: process.platform === 'win32' && 'POSIX stdout inheritance' }, async () => {
  const output = await capture(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => console.log("ActiveState=active"), 300)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    process.exit(0);
  `]);

  assert.match(output, /ActiveState=active/u, `the capture came back as ${JSON.stringify(output)}`);
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

// A read that times out is a failed read, not an answer: it rejects, so the
// collector records it under what could not be collected instead of rendering
// the empty result as a service in an unknown state. A log tail is the one
// place a partial answer is still worth having, and keeps what arrived.
test('a timed-out read rejects with what it got, and a log tail keeps it', async () => {
  const { CaptureTimeoutError, keepPartialLog } = require('./system-adapter.cjs');
  const error = new CaptureTimeoutError('first lines');
  assert.equal(keepPartialLog(error), `first lines${String.fromCharCode(10)}[... collection timed out after 20s ...]`);
  assert.throws(() => keepPartialLog(new Error('spawn failed')), /spawn failed/u);
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

test('journal reads are serialised so none overlap', async () => {
  // The property behind the fix: journald hands back an empty result — exit
  // zero, nothing on stderr — for some unit when several `journalctl -u` reads
  // run at once, silently dropping that unit's logs. Modelled here without
  // spawning: tasks pushed through serializeJournal at the same moment must run
  // strictly one at a time, in the order they were queued.
  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = (id) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(id);
    active -= 1;
    return id;
  };
  const results = await Promise.all([0, 1, 2, 3, 4, 5].map((id) => serializeJournal(task(id))));

  assert.equal(maxActive, 1, 'two journal reads ran at the same time');
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5], 'reads did not run in the order they were requested');
});

test('a failing journal read does not stall the ones queued behind it', async () => {
  const settled = [];
  const first = serializeJournal(async () => { settled.push('first'); return 'first'; });
  const boom = serializeJournal(async () => { throw new Error('journalctl fell over'); });
  const third = serializeJournal(async () => { settled.push('third'); return 'third'; });

  await assert.rejects(() => boom);
  assert.equal(await first, 'first');
  assert.equal(await third, 'third');
  assert.deepEqual(settled, ['first', 'third'], 'a read after a failed one must still run');
});
