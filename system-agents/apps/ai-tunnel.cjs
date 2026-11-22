const fsp = require('node:fs/promises');
const path = require('node:path');

const { CodedError } = require('../../shared/coded-error.cjs');
const {
  AI_TUNNEL_ROOT,
  AI_TUNNEL_UNIT,
  AI_TUNNEL_USER,
  TUNNEL_ID_PATTERN,
  renderAiTunnelConfig,
} = require('../../shared/ai-tunnel.cjs');

const SECRET_PATTERN = /^[\x21-\x7e]{16,4096}$/u;
const SYSTEMCTL = '/usr/bin/systemctl';
const START_TIMEOUT_MS = 60_000;

function refusal(message) {
  return new CodedError('AI_TUNNEL_REQUEST_INVALID', message, { statusCode: 400 });
}

function startRequest(body) {
  const keys = Object.keys(body || {}).sort().join(',');
  if (keys !== 'gatewayKey,runtimeKey,suiteManagerPort,tunnelId') throw refusal('The tunnel request has the wrong fields.');
  const { gatewayKey, runtimeKey, suiteManagerPort, tunnelId } = body;
  if (typeof tunnelId !== 'string' || !TUNNEL_ID_PATTERN.test(tunnelId)) throw refusal('That is not a tunnel ID.');
  if (typeof runtimeKey !== 'string' || !SECRET_PATTERN.test(runtimeKey)) throw refusal('That is not a runtime key.');
  if (typeof gatewayKey !== 'string' || !SECRET_PATTERN.test(gatewayKey)) throw refusal('That is not a gateway key.');
  if (!Number.isInteger(suiteManagerPort) || suiteManagerPort < 1024 || suiteManagerPort > 65535) throw refusal('That is not a port.');
  return { gatewayKey, runtimeKey, suiteManagerPort, tunnelId };
}

// The unit itself is written by the installer and every update; this only
// gives it its files and turns it on or off. Two of the files are keys, so only
// the tunnel's own user may read them.
class AiTunnel {
  constructor({ chown = fsp.chown, execute, root = AI_TUNNEL_ROOT }) {
    this.chown = chown;
    this.execute = execute;
    this.root = root;
  }

  async writeFile(name, content) {
    const target = path.join(this.root, name);
    const staged = `${target}.next`;
    await fsp.writeFile(staged, content, { mode: 0o400 });
    await this.chown(staged, AI_TUNNEL_USER, AI_TUNNEL_USER);
    await fsp.rename(staged, target);
  }

  async start(body) {
    const request = startRequest(body);
    await fsp.mkdir(this.root, { recursive: true });
    await this.writeFile('runtime-key', request.runtimeKey);
    await this.writeFile('gateway-key', request.gatewayKey);
    await this.writeFile('config.yaml', renderAiTunnelConfig(request));
    await this.chown(this.root, AI_TUNNEL_USER, AI_TUNNEL_USER);
    await fsp.chmod(this.root, 0o500);
    await this.execute(SYSTEMCTL, ['enable', AI_TUNNEL_UNIT], { timeoutMs: 30_000 });
    await this.execute(SYSTEMCTL, ['restart', AI_TUNNEL_UNIT], { timeoutMs: START_TIMEOUT_MS });
    return { running: true };
  }

  async stop() {
    await this.execute(SYSTEMCTL, ['disable', '--now', AI_TUNNEL_UNIT], { timeoutMs: 60_000 }).catch(() => {});
    await fsp.rm(this.root, { force: true, recursive: true });
    return { running: false };
  }
}

function aiTunnelRoutes(tunnel) {
  return {
    'POST /v1/ai-tunnel/start': (body) => tunnel.start(body),
    'POST /v1/ai-tunnel/stop': () => tunnel.stop(),
  };
}

module.exports = { AiTunnel, aiTunnelRoutes };
