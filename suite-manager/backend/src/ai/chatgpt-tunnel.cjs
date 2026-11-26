'use strict';

const fs = require('node:fs');

const { CodedError } = require('../../../../shared/coded-error.cjs');
const { AI_TUNNEL_HEALTH_PORT, TUNNEL_ID_PATTERN } = require('../../../../shared/ai-tunnel.cjs');
const { readSecretValue, secretFilePath, writeSecretFile } = require('../apps/app-package-internals.cjs');

const SECRET_OWNER = '_ai';
const SECRET_KEY = 'chatgpt-tunnel';
const RUNTIME_KEY_PATTERN = /^[\x21-\x7e]{16,4096}$/u;
const HEALTH_TIMEOUT_MS = 2_000;

class ChatGptTunnelError extends CodedError {
  constructor(code, message, statusCode = 400) {
    super(code, message, { statusCode });
  }
}

// ChatGPT reaches the gateway through OpenAI's tunnel client, which the app agent
// runs. The keys live here, in the backup; the running copy is the agent's, so a
// server restored from that backup keeps the tunnel off until the owner turns it on.
class ChatGptTunnel {
  constructor({ aiConnections, appAgent, fetchImpl = fetch, secretDir, suiteManagerPort }) {
    this.aiConnections = aiConnections;
    this.appAgent = appAgent;
    this.fetchImpl = fetchImpl;
    this.secretDir = secretDir;
    this.suiteManagerPort = suiteManagerPort;
  }

  stored() {
    try {
      return JSON.parse(readSecretValue(this.secretDir, secretFilePath(this.secretDir, SECRET_OWNER, SECRET_KEY)));
    } catch {
      return null;
    }
  }

  store(value) {
    writeSecretFile(this.secretDir, SECRET_OWNER, SECRET_KEY, JSON.stringify(value));
  }

  forgetStored() {
    fs.rmSync(secretFilePath(this.secretDir, SECRET_OWNER, SECRET_KEY), { force: true });
  }

  owns(clientId) {
    return this.stored()?.clientId === clientId;
  }

  async connect({ name, runtimeKey: rawKey, tunnelId: rawId } = {}) {
    const tunnelId = String(rawId ?? '').trim();
    const runtimeKey = String(rawKey ?? '').trim();
    if (!TUNNEL_ID_PATTERN.test(tunnelId)) throw new ChatGptTunnelError('AI_TUNNEL_ID_INVALID', 'Paste the tunnel ID exactly as OpenAI showed it.');
    if (!RUNTIME_KEY_PATTERN.test(runtimeKey)) throw new ChatGptTunnelError('AI_TUNNEL_KEY_INVALID', 'Paste the API key exactly as OpenAI showed it.');
    const existing = this.stored();
    if (existing && this.aiConnections.aiStore.clientById(existing.clientId)) {
      throw new ChatGptTunnelError('AI_TUNNEL_EXISTS', 'ChatGPT is already connected. Remove it first to connect another tunnel.', 409);
    }
    const { client, token } = this.aiConnections.createClient({ name: name || 'ChatGPT', preset: 'chatgpt', route: 'tunnel' }, { allowTunnel: true });
    this.store({ clientId: client.id, gatewayKey: token, runtimeKey, tunnelId });
    try {
      await this.start();
    } catch (error) {
      this.aiConnections.deleteClient(client.id);
      this.forgetStored();
      throw error;
    }
    return client;
  }

  async start() {
    const stored = this.stored();
    if (!stored) throw new ChatGptTunnelError('AI_TUNNEL_NOT_CONNECTED', 'ChatGPT is not connected.', 404);
    await this.appAgent.request('POST', '/v1/ai-tunnel/start', {
      gatewayKey: stored.gatewayKey,
      runtimeKey: stored.runtimeKey,
      suiteManagerPort: this.suiteManagerPort,
      tunnelId: stored.tunnelId,
    });
  }

  // Called after the AI is removed in Settings: the tunnel goes with it.
  async clientRemoved(clientId) {
    if (!this.owns(clientId)) return;
    this.forgetStored();
    await this.appAgent.request('POST', '/v1/ai-tunnel/stop', {});
  }

  async health() {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${AI_TUNNEL_HEALTH_PORT}/health/control-plane`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const body = await response.json().catch(() => ({}));
      if (body.status === 'ok') return 'connected';
      if (body.status === 'unknown') return 'starting';
      return 'refused';
    } catch {
      return 'off';
    }
  }

  async status() {
    const stored = this.stored();
    if (!stored || !this.aiConnections.aiStore.clientById(stored.clientId)) return null;
    return { clientId: stored.clientId, state: await this.health(), tunnelId: stored.tunnelId };
  }
}

module.exports = { ChatGptTunnel, ChatGptTunnelError };
