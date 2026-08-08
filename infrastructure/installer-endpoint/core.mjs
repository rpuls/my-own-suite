const REPO_URL = 'https://github.com/rpuls/my-own-suite.git';
const COMMITS_API = 'https://api.github.com/repos/rpuls/my-own-suite/commits/';
const RELEASES_LATEST_API = 'https://api.github.com/repos/rpuls/my-own-suite/releases/latest';

export function renderInstaller(ref) {
  ref = String(ref || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('Installer source must resolve to a full 40-character commit SHA.');
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
node "$WORK/scripts/installers/render-bootstrap.cjs" --target shell --front-door public-vps --repo-url "$REPO" --repo-ref "$REF" --public-ipv4 "$IP" | bash
`;
}

export async function resolveInstallRef(branch, fetchImpl = fetch) {
  branch = String(branch || '').trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('INSTALL_BRANCH is invalid.');
  const response = await fetchImpl(`${COMMITS_API}${branch}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'my-own-suite-installer',
    },
  });
  if (!response.ok) throw new Error(`GitHub could not resolve INSTALL_BRANCH (${response.status}).`);
  const ref = String((await response.json()).sha || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('GitHub returned an invalid commit SHA.');
  return { label: branch, ref };
}

// `/releases/latest` is the same call the update agent makes, so a new machine
// starts on the commit its own updater considers current.
export async function resolveLatestStableRef(fetchImpl = fetch) {
  const response = await fetchImpl(RELEASES_LATEST_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'my-own-suite-installer',
    },
  });
  if (!response.ok) throw new Error(`GitHub could not resolve the latest release (${response.status}).`);
  const tag = String((await response.json()).tag_name || '').trim();
  // Same shape the updater insists on before it will check a release tag out.
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('The latest release is not tagged vX.Y.Z, so it cannot be installed.');
  return { label: tag, ref: (await resolveInstallRef(tag, fetchImpl)).ref };
}

// selectSource(env) returns `{ stable: true }` or `{ branch }`.
export function createInstallerWorker(selectSource, { fetchImpl = null } = {}) {
  return { async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' || (path !== '/' && path !== '/install.sh')) return new Response('Not found\n', { status: 404 });
    try {
      const source = selectSource(env) || {};
      const http = fetchImpl || fetch;
      const { label, ref } = source.stable ? await resolveLatestStableRef(http) : await resolveInstallRef(source.branch, http);
      return new Response(renderInstaller(ref), { headers: {
        'Cache-Control': 'no-store', 'Content-Type': 'text/x-shellscript; charset=utf-8',
        'X-Content-Type-Options': 'nosniff', 'X-MOS-Install-Ref': ref,
        'X-MOS-Install-Source': label,
      }});
    } catch (error) { return new Response(`Installer unavailable: ${error.message}\n`, { status: 503 }); }
  }};
}
