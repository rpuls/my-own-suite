const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HOMEPAGE_RESTART_TIMEOUT_MS, HomepageApplyError, SystemHomepageAdapter } = require('./system-adapter.cjs');
const { runCommand } = require('../lib/command-output.cjs');

async function fixture(failAt = '') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-homepage-agent-'));
  const configRoot = path.join(root, 'config');
  const routesPath = path.join(root, 'routes.caddy');
  await fsp.mkdir(configRoot);
  await fsp.writeFile(path.join(configRoot, 'services.template.yaml'), 'old template\n');
  await fsp.writeFile(path.join(configRoot, 'services.yaml'), 'old projection\n');
  await fsp.writeFile(routesPath, 'old routes\n');
  const calls = [];
  const invocations = [];
  const execute = async (file, args, options) => {
    const action = args[0] === 'validate' ? 'validate' : `${args[0]}-${args[1]}`;
    calls.push(action);
    invocations.push({ args, file, options });
    if (action === failAt) throw new Error('failed');
  };
  return {
    calls, configRoot, invocations, root, routesPath,
    adapter: new SystemHomepageAdapter({ configRoot, execute, historyRoot: path.join(root, 'history'), routesPath, transactionRoot: path.join(root, 'transactions') }),
  };
}

test('transaction restarts Homepage and reloads Caddy only when their outputs change', async () => {
  const value = await fixture();
  const result = await value.adapter.applyTransaction({
    caddyRoutes: 'new routes\n', files: { 'services.template.yaml': 'new template\n', 'services.yaml': 'new projection\n' }, restartHomepage: true,
  });
  assert.deepEqual(value.calls, ['validate', 'restart-mos-homepage.service', 'reload-caddy.service']);
  assert.deepEqual(value.invocations[0].args.slice(0, 3), ['validate', '--adapter', 'caddyfile']);
  assert.equal(value.invocations[1].options.timeoutMs, HOMEPAGE_RESTART_TIMEOUT_MS);
  assert.ok(HOMEPAGE_RESTART_TIMEOUT_MS > 30_000, 'restart budget must exceed the observed rollback deadline');
  assert.deepEqual(result.steps, ['staged', 'validated', 'written', 'homepage-restarted', 'caddy-reloaded']);

  value.calls.length = 0;
  await value.adapter.applyTransaction({
    caddyRoutes: 'new routes\n', files: { 'services.template.yaml': 'new template\n', 'services.yaml': 'new projection\n' }, restartHomepage: true,
  });
  assert.deepEqual(value.calls, []);
});

for (const [failure, errorCode] of [
  ['validate', 'HOMEPAGE_CADDY_VALIDATION_FAILED'],
  ['restart-mos-homepage.service', 'HOMEPAGE_RESTART_FAILED'],
  ['reload-caddy.service', 'HOMEPAGE_CADDY_RELOAD_FAILED'],
]) {
  test(`transaction restores Homepage and Caddy after ${failure} failure`, async () => {
    let failed = false;
    const value = await fixture(failure);
    const originalExecute = value.adapter.execute;
    value.adapter.execute = async (...args) => {
      if (!failed) {
        try { return await originalExecute(...args); } catch (error) { failed = true; throw error; }
      }
    };
    await assert.rejects(() => value.adapter.applyTransaction({
      caddyRoutes: 'new routes\n', files: { 'services.template.yaml': 'new template\n', 'services.yaml': 'new projection\n' }, restartHomepage: true,
    }), (error) => error.code === errorCode && error.statusCode === 502);
    assert.equal(await fsp.readFile(path.join(value.configRoot, 'services.template.yaml'), 'utf8'), 'old template\n');
    assert.equal(await fsp.readFile(path.join(value.configRoot, 'services.yaml'), 'utf8'), 'old projection\n');
    assert.equal(await fsp.readFile(value.routesPath, 'utf8'), 'old routes\n');
  });
}

// Real processes standing in for caddy, systemctl and journalctl, so the
// reasons come from the shared runner exactly as they would on a server.
const FAKE_TOOLS = String.raw`
const [program, command, unit] = process.argv.slice(2);
if (program === 'caddy') {
  process.stderr.write('Error: adapting config using caddyfile: routes.caddy:3: unrecognized directive: reverse_proxi\n');
  process.exitCode = 1;
} else if (program === 'systemctl' && command === 'restart') {
  process.stderr.write('Job for mos-homepage.service failed because the control process exited with error code.\n');
  process.exitCode = 1;
} else if (program === 'journalctl') {
  process.stdout.write('services.yaml: bad indentation of a mapping entry (12:5)\n');
}
`;

async function realToolsFixture() {
  const value = await fixture();
  const fakeTools = path.join(value.root, 'fake-tools.cjs');
  await fsp.writeFile(fakeTools, FAKE_TOOLS);
  value.adapter.execute = (file, args, options = {}) => runCommand(process.execPath, [fakeTools, path.basename(file), ...args], options);
  return value;
}

test('a validation failure carries what caddy wrote, and not the command line', async () => {
  const value = await realToolsFixture();
  await assert.rejects(() => value.adapter.applyTransaction({ caddyRoutes: 'new routes\n', files: {}, restartHomepage: false }), (error) => {
    assert.ok(error instanceof HomepageApplyError);
    assert.equal(error.code, 'HOMEPAGE_CADDY_VALIDATION_FAILED');
    assert.deepEqual(error.details, [
      'caddy validate for the home-service routes exited with code 1.',
      'Last output:\n  Error: adapting config using caddyfile: routes.caddy:3: unrecognized directive: reverse_proxi',
    ]);
    assert.ok(!error.details.join('\n').includes('--config'));
    return true;
  });
});

test('a restart failure quotes the Homepage unit log, where the bad YAML is named', async () => {
  const value = await realToolsFixture();
  await assert.rejects(() => value.adapter.applyTransaction({ caddyRoutes: null, files: { 'services.yaml': 'new projection\n' }, restartHomepage: true }), (error) => {
    assert.equal(error.code, 'HOMEPAGE_RESTART_FAILED');
    assert.deepEqual(error.details, [
      'systemctl restart mos-homepage.service exited with code 1.',
      'Last output:\n  Job for mos-homepage.service failed because the control process exited with error code.',
      'Last lines of mos-homepage.service:\n  services.yaml: bad indentation of a mapping entry (12:5)',
    ]);
    return true;
  });
  assert.equal(await fsp.readFile(path.join(value.configRoot, 'services.yaml'), 'utf8'), 'old projection\n');
});
