const REPO_URL = 'https://github.com/rpuls/my-own-suite.git';

export function renderInstaller(env) {
  const ref = String(env.INSTALL_REF || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('INSTALL_REF must be a full 40-character commit SHA.');
  return `#!/usr/bin/env bash
set -euo pipefail
REF='${ref}'
REPO='${REPO_URL}'
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo bash.' >&2; exit 1; }
. /etc/os-release
[ "\${ID:-}" = ubuntu ] && [ "\${VERSION_ID:-}" = 24.04 ] || { echo 'MOS requires Ubuntu 24.04.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git
IP="$(curl -fsS --proto '=https' --tlsv1.2 --max-time 15 https://api.ipify.org)"
printf '%s' "$IP" | grep -Eq '^([0-9]{1,3}\\.){3}[0-9]{1,3}$' || { echo 'Could not discover public IPv4.' >&2; exit 1; }
if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL --proto '=https' --tlsv1.2 https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git -C "$WORK" init --quiet
git -C "$WORK" remote add origin "$REPO"
git -C "$WORK" fetch --quiet --depth 1 origin "$REF"
git -C "$WORK" checkout --quiet --detach FETCH_HEAD
[ "$(git -C "$WORK" rev-parse HEAD)" = "$REF" ] || { echo 'Source verification failed.' >&2; exit 1; }
node "$WORK/scripts/installers/render-bootstrap.cjs" --target shell --front-door ssh-bootstrap --repo-url "$REPO" --repo-ref "$REF" --public-ipv4 "$IP" | bash
`;
}

export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET' || (path !== '/' && path !== '/install.sh')) return new Response('Not found\n', { status: 404 });
  try {
    return new Response(renderInstaller(env), { headers: {
      'Cache-Control': 'no-store', 'Content-Type': 'text/x-shellscript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff', 'X-MOS-Install-Ref': env.INSTALL_REF,
    }});
  } catch (error) { return new Response(`Installer unavailable: ${error.message}\n`, { status: 503 }); }
}};
