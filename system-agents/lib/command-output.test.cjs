'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CommandFailure,
  KILL_GRACE_MS,
  OUTPUT_TAIL_LINES,
  describeDuration,
  describeFailure,
  maskValues,
  runCommand,
  tailOutput,
} = require('./command-output.cjs');

const node = process.execPath;
const script = (source) => [node, ['-e', source]];

test('a failed command rejects with its exit code and the tail of what it wrote', async () => {
  const [file, args] = script('console.log("step one"); console.error("ERROR: disk is full"); process.exit(3);');
  await assert.rejects(runCommand(file, args), (error) => {
    assert.ok(error instanceof CommandFailure);
    assert.equal(error.message, 'COMMAND_FAILED');
    assert.equal(error.exitCode, 3);
    assert.match(error.output, /step one/u);
    assert.match(error.output, /ERROR: disk is full/u);
    return true;
  });
});

test('a successful command resolves with its stdout separately from the merged output', async () => {
  const [file, args] = script('console.log(JSON.stringify({ ok: true })); console.error("warning: ignored");');
  const result = await runCommand(file, args);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: true });
  assert.match(result.output, /warning: ignored/u);
});

test('the attached output is the newest lines, bounded, and says how much was dropped', async () => {
  const [file, args] = script('for (let i = 1; i <= 500; i += 1) console.error(`line ${i}`); process.exit(1);');
  await assert.rejects(runCommand(file, args), (error) => {
    const lines = error.output.split('\n');
    assert.equal(lines.length, OUTPUT_TAIL_LINES + 1);
    assert.equal(lines[0], `[${500 - OUTPUT_TAIL_LINES} earlier lines omitted]`);
    assert.equal(lines.at(-1), 'line 500');
    assert.ok(!error.output.includes('line 1\n'));
    return true;
  });
});

// A generous budget on purpose: the child cold-starts a Node interpreter and has
// to flush its first line before the deadline, which under the full parallel test
// run can take over a second on a loaded box. The command overruns by 30 s
// regardless, so the timeout path runs either way — a tight budget only bought a
// flake. The exact duration rendering is pinned by the describeDuration tests, so
// this one asserts the sentence shape rather than the number.
test('a command that overruns its budget is stopped and reports what it managed to write', async () => {
  const [file, args] = script('console.log("still working"); setTimeout(() => {}, 30000);');
  await assert.rejects(runCommand(file, args, { timeoutMs: 2_000 }), (error) => {
    assert.equal(error.message, 'COMMAND_TIMEOUT');
    assert.equal(error.timedOut, true);
    assert.match(error.output, /still working/u);
    assert.match(describeFailure(error, 'the health probe')[0], /^the health probe did not finish within .+ and was stopped\.$/u);
    return true;
  });
});

// The property the whole design rests on. App containers start with materialized
// secrets on their argv, so a command that echoes its own arguments — the way a
// CLI rejecting a flag does — is the one way a secret reaches the output at all,
// and the mask is what keeps it there.
test('a secret on the argv never reaches the failure, even when the command echoes it', async () => {
  const secret = 'hunter2-super-secret-value';
  const [file, args] = script(`console.error("invalid argument: " + process.argv[1]); process.exit(2);`);
  await assert.rejects(runCommand(file, [...args, `DB_PASSWORD=${secret}`], { mask: [secret] }), (error) => {
    assert.ok(!error.output.includes(secret));
    assert.match(error.output, /invalid argument: DB_PASSWORD=\[redacted\]/u);
    const described = describeFailure(error, 'docker run for service "db"').join('\n');
    assert.ok(!described.includes(secret));
    assert.ok(!described.includes(file));
    assert.ok(!described.includes('-e'));
    return true;
  });
});

// A deadline stops the whole command, not just the process it started: the
// child here hands its work to a grandchild that inherits the output pipes
// and ignores SIGTERM, which is what `npm run` and `docker build` look like when
// they hang. On Windows a process is simply terminated, so the case is trivial.
test('a command that overruns its deadline is stopped along with the children holding its pipes', { timeout: KILL_GRACE_MS * 4 }, async () => {
  const grandchild = 'process.on("SIGTERM", () => {}); console.log("grandchild up"); setInterval(() => {}, 1000);';
  const [file, args] = script(`
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });
    process.on("SIGTERM", () => {});
    child.on("exit", () => process.exit(0));
  `);
  const started = Date.now();
  // Same generous budget as above: two Node cold-starts (this child and its
  // grandchild) must both come up and the grandchild print before the deadline.
  await assert.rejects(runCommand(file, args, { timeoutMs: 2_000 }), (error) => {
    assert.equal(error.message, 'COMMAND_TIMEOUT');
    assert.match(error.output, /grandchild up/u);
    return true;
  });
  assert.ok(Date.now() - started < KILL_GRACE_MS * 3, 'the command was not stopped');
});

test('a deadline is described in the unit a person would use', () => {
  assert.equal(describeDuration(300), '300 ms');
  assert.equal(describeDuration(1_000), '1 second');
  assert.equal(describeDuration(20_000), '20 seconds');
  assert.equal(describeDuration(90_000), '1 minute 30 seconds');
  assert.equal(describeDuration(300_000), '5 minutes');
  assert.equal(describeDuration(3_600_000), '1 hour');
  assert.equal(describeDuration(5_400_000), '1 hour 30 minutes');
  const error = new CommandFailure('COMMAND_TIMEOUT', { output: '', timeoutMs: 3_600_000 });
  assert.equal(describeFailure(error, 'npm run build:client')[0], 'npm run build:client did not finish within 1 hour and was stopped.');
});

test('describeFailure explains a missing program without naming the command line', () => {
  const error = Object.assign(new Error('spawn /usr/bin/docker ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(describeFailure(error, 'docker build'), ['docker build could not start: the program is not installed on this server.']);
  assert.deepEqual(describeFailure(new Error('PACKAGE_SNAPSHOT_MISMATCH'), 'docker build'), ['PACKAGE_SNAPSHOT_MISMATCH']);
  const failure = new CommandFailure('COMMAND_FAILED', { exitCode: 1, output: 'line one\nline two' });
  assert.deepEqual(describeFailure(failure, 'docker build for service "web"'), [
    'docker build for service "web" exited with code 1.',
    'Last output:\n  line one\n  line two',
  ]);
  assert.deepEqual(describeFailure(new CommandFailure('COMMAND_FAILED', { exitCode: 137 }), 'docker run'), [
    'docker run exited with code 137.',
    'It wrote no output.',
  ]);
});

test('tailOutput drops terminal control sequences and progress-bar rewrites', () => {
  const text = '\u001b[32mok\u001b[0m\nprogress 10%\rprogress 50%\rprogress 100%\r\n\n\nfinal line   \n';
  assert.equal(tailOutput(text), 'ok\nprogress 100%\nfinal line');
  assert.equal(tailOutput('a\nb\nc', { lines: 2 }), '[1 earlier line omitted]\nb\nc');
  assert.equal(tailOutput('x'.repeat(50), { chars: 10 }), `…${'x'.repeat(10)}`);
});

test('maskValues masks by exact value, longest first, and leaves short values alone', () => {
  assert.equal(maskValues('token=abcdef123 inner=abcdef', ['abcdef', 'abcdef123']), 'token=[redacted] inner=[redacted]');
  assert.equal(maskValues('port=3000', ['3000']), 'port=3000');
  assert.equal(maskValues('nothing', []), 'nothing');
});

test('echo streams the output through as it arrives, and a zero timeout means none', async () => {
  // In a child, so the streams the test runner itself writes to stay untouched.
  const inner = [
    `require(${JSON.stringify(require.resolve('./command-output.cjs'))})`,
    `.runCommand(process.execPath, ['-e', 'console.log("to the journal"); console.error("and this");'], { echo: true, timeoutMs: 0 })`,
    `.then((result) => process.stdout.write('captured:' + result.stdout.trim()));`,
  ].join('');
  const result = await runCommand(...script(inner));
  assert.equal(result.stdout.replace(/\r\n/gu, '\n'), 'to the journal\ncaptured:to the journal');
  assert.match(result.output, /and this/u);
});
