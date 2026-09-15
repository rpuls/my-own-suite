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

// How long a resolved ref is reused before GitHub is asked again. Every request
// used to spend two unauthenticated GitHub API calls, and that budget is counted
// per source address - which for a Worker is an address shared with everyone else
// on the colo. So the endpoint answered `Installer unavailable` on requests
// GitHub had no reason to refuse, intermittently and without warning.
const RESOLUTION_TTL_MS = 5 * 60 * 1000;

// selectSource(env) returns `{ stable: true }` or `{ branch }`.
//
// A resolution is cached for RESOLUTION_TTL_MS, and if GitHub then fails, the
// last good one is served rather than nothing: a release a few minutes stale
// still installs, while a 503 is a machine that installs nothing at all. Failing
// closed is kept for the case that deserves it - never having resolved a ref, so
// there is no source to pin and the alternative would be inventing one.
export function createInstallerWorker(selectSource, { cache = new Map(), fetchImpl = null, now = () => Date.now() } = {}) {
  return { async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const method = request.method;
    if ((method !== 'GET' && method !== 'HEAD') || (path !== '/' && path !== '/install.sh')) return new Response('Not found\n', { status: 404 });
    const source = selectSource(env) || {};
    const key = source.stable ? 'stable' : `branch:${source.branch}`;
    const fresh = cache.get(key);
    let resolved = fresh && now() - fresh.at < RESOLUTION_TTL_MS ? fresh.value : null;
    let stale = null;
    if (!resolved) {
      const http = fetchImpl || fetch;
      try {
        resolved = source.stable ? await resolveLatestStableRef(http) : await resolveInstallRef(source.branch, http);
        cache.set(key, { at: now(), value: resolved });
      } catch (error) {
        if (!fresh) return new Response(`Installer unavailable: ${error.message}\n`, { status: 503 });
        resolved = fresh.value;
        stale = error.message;
      }
    }
    const script = renderInstaller(resolved.ref);
    const headers = {
      'Cache-Control': 'no-store', 'Content-Type': 'text/x-shellscript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff', 'X-MOS-Install-Ref': resolved.ref,
      'X-MOS-Install-Source': resolved.label,
    };
    // Names why a ref was reused past its TTL, so the next person diagnosing this
    // reads GitHub's own answer instead of guessing at a healthy-looking response.
    if (stale) headers['X-MOS-Install-Stale'] = stale;
    return new Response(method === 'HEAD' ? null : script, { headers });
  }};
}
