const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HttpsAgentError } = require('./agent-core.cjs');
const { SystemHttpsAdapter } = require('./system-adapter.cjs');
const { runCommand } = require('../lib/command-output.cjs');

// Stands in for caddy, systemctl and journalctl at once, dispatching on the
// program name the adapter asked for. `validate` fails the way Caddy does and
// prints the token it was handed in its environment, the worst a tool could do
// with it; nothing here prints its own argv, so a command line in a failure
// could only have come from the adapter.
const FAKE_TOOLS = String.raw`
const [program, command] = process.argv.slice(2);
if (program === 'caddy' && command === 'list-modules') {
  process.stdout.write('dns.providers.cloudflare\nhttp.handlers.reverse_proxy\n');
} else if (program === 'caddy' && command === 'validate') {
  process.stderr.write('Error: adapting config using caddyfile: /etc/caddy/Caddyfile:14: unrecognized directive: tls_dns\n');
  process.stderr.write('environment: CLOUDFLARE_API_TOKEN=' + process.env.CLOUDFLARE_API_TOKEN + '\n');
  process.exitCode = 1;
} else if (program === 'systemctl') {
  process.stderr.write('Job for caddy.service failed because the control process exited with error code.\n');
  process.exitCode = 1;
} else if (program === 'journalctl') {
  process.stdout.write('{"level":"error","msg":"loading initial config","error":"listen tcp :443: bind: address already in use"}\n');
  process.stdout.write('caddy.service: Failed with result exit-code.\n');
}
`;

const token = 'cf_token_value_0123456789abcdef';

async function testAdapter() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-https-adapter-'));
  const fakeTools = path.join(root, 'fake-tools.cjs');
  await fsp.writeFile(fakeTools, FAKE_TOOLS);
  const adapter = new SystemHttpsAdapter({
    caddyBinary: '/opt/caddy',
    caddyfilePath: path.join(root, 'etc', 'Caddyfile'),
    execute: (file, args, options = {}) => runCommand(process.execPath, [fakeTools, path.basename(file), ...args], { ...options, env: { ...process.env, ...(options.env || {}) } }),
    secretEnvPath: path.join(root, 'secrets', 'caddy-cloudflare.env'),
    transactionRoot: path.join(root, 'transactions'),
  });
  return { adapter, root };
}

test('the module check reads what caddy lists', async () => {
  const { adapter } = await testAdapter();
  assert.equal(await adapter.hasCloudflareModule(), true);
});

test('a validation failure carries what caddy wrote, without the token or the command line', async () => {
  const { adapter } = await testAdapter();
  await assert.rejects(() => adapter.validateCandidate(token), (error) => {
    assert.ok(error instanceof HttpsAgentError);
    assert.equal(error.code, 'HTTPS_CADDY_VALIDATION_FAILED');
    assert.equal(error.details[0], 'caddy validate for the new configuration exited with code 1.');
    const text = error.details.join('\n');
    assert.match(text, /unrecognized directive: tls_dns/u);
    assert.match(text, /CLOUDFLARE_API_TOKEN=\[redacted\]/u);
    assert.ok(!text.includes(token));
    assert.ok(!text.includes('--config'), 'the argv must not be part of the report');
    return true;
  });
});

test('a restart failure quotes the newest lines of the Caddy log, since systemctl only says the unit failed', async () => {
  const { adapter } = await testAdapter();
  await assert.rejects(() => adapter.reload(token), (error) => {
    assert.equal(error.code, 'HTTPS_CADDY_RELOAD_FAILED');
    assert.deepEqual(error.details, [
      'systemctl restart caddy.service exited with code 1.',
      'Last output:\n  Job for caddy.service failed because the control process exited with error code.',
      'Caddy\'s last log lines:\n  {"level":"error","msg":"loading initial config","error":"listen tcp :443: bind: address already in use"}\n  caddy.service: Failed with result exit-code.',
    ]);
    return true;
  });
});

test('a checkpoint restores the files a candidate replaced, including one that did not exist', async () => {
  const { adapter, root } = await testAdapter();
  const rollbackId = '0f2f3c2e-8a5e-4b6c-9d1e-2f3a4b5c6d7e';
  await fsp.mkdir(path.join(root, 'etc'), { recursive: true });
  await fsp.mkdir(path.join(root, 'transactions'), { recursive: true });
  await fsp.writeFile(path.join(root, 'etc', 'Caddyfile'), 'previous\n');
  await adapter.createCheckpoint(rollbackId);
  await adapter.installCandidate({ caddyfile: 'candidate\n', cloudflareApiToken: token });
  assert.equal(await fsp.readFile(path.join(root, 'etc', 'Caddyfile'), 'utf8'), 'candidate\n');
  assert.equal(await fsp.readFile(path.join(root, 'secrets', 'caddy-cloudflare.env'), 'utf8'), `CLOUDFLARE_API_TOKEN=${token}\n`);

  await adapter.restoreCheckpoint(rollbackId);
  await adapter.removeCheckpoint(rollbackId);
  assert.equal(await fsp.readFile(path.join(root, 'etc', 'Caddyfile'), 'utf8'), 'previous\n');
  await assert.rejects(() => fsp.access(path.join(root, 'secrets', 'caddy-cloudflare.env')));
  await assert.rejects(() => fsp.access(path.join(root, 'transactions', rollbackId)));
});

test('a rollback id that is not a uuid is refused before any path is built', async () => {
  const { adapter } = await testAdapter();
  await assert.rejects(() => adapter.restoreCheckpoint('../etc'), (error) => error.code === 'INVALID_ROLLBACK_ID' && error.statusCode === 400);
});
