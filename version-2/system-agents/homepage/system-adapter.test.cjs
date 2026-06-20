const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SystemHomepageAdapter } = require('./system-adapter.cjs');

async function fixture(failAt = '') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-homepage-agent-'));
  const configRoot = path.join(root, 'config');
  const routesPath = path.join(root, 'routes.caddy');
  await fsp.mkdir(configRoot);
  await fsp.writeFile(path.join(configRoot, 'services.template.yaml'), 'old template\n');
  await fsp.writeFile(path.join(configRoot, 'services.yaml'), 'old projection\n');
  await fsp.writeFile(routesPath, 'old routes\n');
  const calls = [];
  const execute = async (file, args) => {
    const action = args[0] === 'validate' ? 'validate' : `${args[0]}-${args[1]}`;
    calls.push(action);
    if (action === failAt) throw new Error('failed');
  };
  return {
    calls, configRoot, root, routesPath,
    adapter: new SystemHomepageAdapter({ configRoot, execute, historyRoot: path.join(root, 'history'), routesPath, transactionRoot: path.join(root, 'transactions') }),
  };
}

test('transaction restarts Homepage and reloads Caddy only when their outputs change', async () => {
  const value = await fixture();
  const result = await value.adapter.applyTransaction({
    caddyRoutes: 'new routes\n', files: { 'services.template.yaml': 'new template\n', 'services.yaml': 'new projection\n' }, restartHomepage: true,
  });
  assert.deepEqual(value.calls, ['validate', 'restart-mos-v2-homepage.service', 'reload-caddy.service']);
  assert.deepEqual(result.steps, ['staged', 'validated', 'written', 'homepage-restarted', 'caddy-reloaded']);

  value.calls.length = 0;
  await value.adapter.applyTransaction({
    caddyRoutes: 'new routes\n', files: { 'services.template.yaml': 'new template\n', 'services.yaml': 'new projection\n' }, restartHomepage: true,
  });
  assert.deepEqual(value.calls, ['validate']);
});

for (const failure of ['validate', 'restart-mos-v2-homepage.service', 'reload-caddy.service']) {
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
    }), /HOMEPAGE_APPLY_FAILED/u);
    assert.equal(await fsp.readFile(path.join(value.configRoot, 'services.template.yaml'), 'utf8'), 'old template\n');
    assert.equal(await fsp.readFile(path.join(value.configRoot, 'services.yaml'), 'utf8'), 'old projection\n');
    assert.equal(await fsp.readFile(value.routesPath, 'utf8'), 'old routes\n');
  });
}
