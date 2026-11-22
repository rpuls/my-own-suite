const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AiTunnel } = require('./ai-tunnel.cjs');

const REQUEST = {
  gatewayKey: 'mos_ai_gateway-key-for-tests',
  runtimeKey: 'sk-proj-runtime-key-for-tests',
  suiteManagerPort: 3100,
  tunnelId: 'tunnel_6afcd9b631d88191952917b488188465',
};

function harness() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-ai-tunnel-')), 'ai-tunnel');
  const commands = [];
  const tunnel = new AiTunnel({ execute: async (file, args) => { commands.push(args.join(' ')); }, root });
  return { commands, root, tunnel };
}

test('start gives the tunnel its keys and a config that keeps Harpoon off, then turns the unit on', async () => {
  const h = harness();
  await h.tunnel.start(REQUEST);

  const config = fs.readFileSync(path.join(h.root, 'config.yaml'), 'utf8');
  assert.match(config, /tunnel_id: tunnel_6afcd9b631d88191952917b488188465/u);
  assert.match(config, /url: http:\/\/127\.0\.0\.1:3100\/ai\/mcp/u);
  assert.match(config, /oauth_discovery: disabled/u);
  assert.match(config, /poll_channels: \[main\]/u);
  assert.doesNotMatch(config, /sk-proj|mos_ai_/u);
  assert.equal(fs.readFileSync(path.join(h.root, 'runtime-key'), 'utf8'), REQUEST.runtimeKey);
  assert.equal(fs.readFileSync(path.join(h.root, 'gateway-key'), 'utf8'), REQUEST.gatewayKey);
  assert.deepEqual(h.commands, ['enable mos-ai-tunnel.service', 'restart mos-ai-tunnel.service']);
});

test('start refuses anything but the four expected fields in their shapes', async () => {
  const h = harness();
  for (const body of [
    { ...REQUEST, extra: 1 },
    { ...REQUEST, tunnelId: 'tunnel_x\nlog: {}' },
    { ...REQUEST, runtimeKey: 'has a space in it' },
    { ...REQUEST, suiteManagerPort: 80 },
  ]) {
    await assert.rejects(h.tunnel.start(body), { code: 'AI_TUNNEL_REQUEST_INVALID' });
  }
  assert.deepEqual(h.commands, []);
  assert.equal(fs.existsSync(h.root), false);
});

test('stop turns the unit off and removes the keys', async () => {
  const h = harness();
  await h.tunnel.start(REQUEST);
  await h.tunnel.stop();
  assert.equal(h.commands.at(-1), 'disable --now mos-ai-tunnel.service');
  assert.equal(fs.existsSync(h.root), false);
});
