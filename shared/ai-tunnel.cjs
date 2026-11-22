'use strict';

// OpenAI's tunnel client, which lets ChatGPT reach the AI gateway without opening
// anything at home: it polls OpenAI outbound and forwards each MCP request to
// Suite Manager. The runtime flavour: non-root, no admin UI, no cloudflared.
const AI_TUNNEL_IMAGE = 'ghcr.io/openai/tunnel-client-runtime@sha256:9f229698abcf062e0fe7951469af989f2769a167b7eaf2e29a3d5a5a55c169d5';
const AI_TUNNEL_UNIT = 'mos-ai-tunnel.service';
const AI_TUNNEL_CONTAINER = 'mos-ai-tunnel';
const AI_TUNNEL_ROOT = '/var/lib/mos/ai-tunnel';
const AI_TUNNEL_HEALTH_PORT = 3400;
const AI_TUNNEL_USER = 65532;
// The tunnel client's own rule: an optional four-character namespace, then 32 lowercase letters or digits.
const TUNNEL_ID_PATTERN = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/u;
const MOUNT = '/etc/mos-ai-tunnel';

// Harpoon, the client's way of letting OpenAI call hosts inside the network, stays
// off: no OAuth discovery, no targets, and only the main channel is drained.
function renderAiTunnelConfig({ suiteManagerPort, tunnelId }) {
  return `config_version: 1
forward_request_id: none
control_plane:
  tunnel_id: ${tunnelId}
  api_key: file:${MOUNT}/runtime-key
  poll_channels: [main]
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:${suiteManagerPort}/ai/mcp
  extra_headers:
    X-MOS-Gateway-Key: file:${MOUNT}/gateway-key
  oauth_discovery: disabled
log:
  level: info
  format: json
health:
  listen_addr: 127.0.0.1:${AI_TUNNEL_HEALTH_PORT}
`;
}

// Host networking is what lets it reach Suite Manager on loopback, so the gateway
// works whatever address, or lack of HTTPS, the suite has. Enabled only while the
// owner has ChatGPT connected, so a restore onto another machine leaves it off.
function renderAiTunnelUnit({ root = AI_TUNNEL_ROOT } = {}) {
  return `[Unit]
Description=MOS tunnel for ChatGPT
After=docker.service network-online.target mos-suite-manager.service
Requires=docker.service
Requires=mos-vault.service
After=mos-vault.service
Wants=network-online.target
ConditionPathExists=${root}/config.yaml

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm -f ${AI_TUNNEL_CONTAINER}
ExecStart=/usr/bin/docker run --rm --name ${AI_TUNNEL_CONTAINER} --network host --read-only --cap-drop ALL --security-opt no-new-privileges --user ${AI_TUNNEL_USER}:${AI_TUNNEL_USER} --log-opt max-size=10m --log-opt max-file=3 --volume ${root}:${MOUNT}:ro ${AI_TUNNEL_IMAGE} --config ${MOUNT}/config.yaml
ExecStop=/usr/bin/docker stop -t 10 ${AI_TUNNEL_CONTAINER}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

module.exports = {
  AI_TUNNEL_CONTAINER,
  AI_TUNNEL_HEALTH_PORT,
  AI_TUNNEL_IMAGE,
  AI_TUNNEL_ROOT,
  AI_TUNNEL_UNIT,
  AI_TUNNEL_USER,
  TUNNEL_ID_PATTERN,
  renderAiTunnelConfig,
  renderAiTunnelUnit,
};
