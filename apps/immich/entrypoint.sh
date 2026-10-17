#!/bin/bash
set -euo pipefail

# MOS package wrapper. Immich has no SMTP environment variables — outbound
# notification email lives in Immich's system config — so MOS writes the owner's
# shared relay (${smtp.*}, projected in as MOS_SMTP_*) into the JSON config file
# the server reads at startup (IMMICH_CONFIG_FILE). The baked base config, which
# only disables Immich's own version check, is merged with a notifications.smtp
# block generated from the environment on every start. With no relay the block is
# omitted, so any SMTP the owner set inside Immich's admin UI is left untouched.
# Immich reads this file fresh each boot, so regenerating it here — before the
# real start.sh runs — takes effect. Failure never blocks startup: the base
# config is restored so the server still boots (just without a MOS-set relay).
BASE_CONFIG="/etc/immich/immich-config.base.json"
RUNTIME_CONFIG="${IMMICH_CONFIG_FILE:-/etc/immich/immich-config.json}"

mkdir -p "$(dirname "$RUNTIME_CONFIG")" 2>/dev/null || true

if ! MOS_BASE_CONFIG="$BASE_CONFIG" MOS_RUNTIME_CONFIG="$RUNTIME_CONFIG" node <<'JS'
const fs = require('fs');
const base = (() => {
  try { return JSON.parse(fs.readFileSync(process.env.MOS_BASE_CONFIG, 'utf8')); } catch { return {}; }
})();
const e = process.env;
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
const host = (e.MOS_SMTP_HOST || '').trim();
const config = { ...base };
if (host) {
  const fromAddress = (e.MOS_SMTP_FROM || '').trim();
  const fromName = (e.MOS_SMTP_FROM_NAME || '').trim();
  const port = Number.parseInt(e.MOS_SMTP_PORT || '', 10);
  config.notifications = {
    ...(base.notifications || {}),
    smtp: {
      enabled: true,
      from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
      replyTo: '',
      transport: {
        host,
        // secure = implicit TLS (port 465); STARTTLS is negotiated when false.
        ignoreCert: bool(e.MOS_SMTP_ALLOW_INVALID_CERT),
        password: e.MOS_SMTP_PASSWORD || '',
        port: Number.isInteger(port) ? port : 587,
        secure: bool(e.MOS_SMTP_IMPLICIT_TLS),
        username: e.MOS_SMTP_USERNAME || '',
      },
    },
  };
}
fs.writeFileSync(process.env.MOS_RUNTIME_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
JS
then
  echo "MOS: could not generate Immich config with the relay; starting from the base config"
  cp "$BASE_CONFIG" "$RUNTIME_CONFIG" 2>/dev/null || true
fi

# Immich creates its administrator and external libraries only through its API,
# so a background job does it once the server answers: the administrator from
# the login chosen at install, a Photos library over the folder MOS mounted from
# the owner's drive, and a scan of it on every start. Failures are logged and
# retried at the next start; they never hold the server back.
MOS_PHOTOS_PATH=/media/photos node <<'JS' &
const fs = require('fs');
const api = 'http://localhost:2283/api';
const keyFile = '/usr/src/app/upload/.mos-api-key';
const email = process.env.MOS_ADMIN_EMAIL || '';
const password = process.env.MOS_ADMIN_PASSWORD || '';
const photos = process.env.MOS_PHOTOS_PATH;
const log = (message) => console.log(`MOS: ${message}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${api}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
    method,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function serverAnswers() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try { if ((await call('GET', '/server/ping')).res === 'pong') return true; } catch {}
    await sleep(2000);
  }
  return false;
}

// An API key outlives the owner changing their password, which the login from
// install would not.
async function apiKey() {
  try {
    const kept = fs.readFileSync(keyFile, 'utf8').trim();
    await call('GET', '/users/me', undefined, { 'x-api-key': kept });
    return kept;
  } catch {}
  const { isInitialized } = await call('GET', '/server/config');
  if (!isInitialized) {
    await call('POST', '/auth/admin-sign-up', { email, name: email.split('@')[0], password });
    log(`created the administrator ${email}`);
  }
  const session = await call('POST', '/auth/login', { email, password });
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  // The owner chose this password at install; asking them to replace it at
  // their first sign-in would only be in the way.
  if (!isInitialized) await call('PUT', `/admin/users/${session.userId}`, { shouldChangePassword: false }, auth);
  const { secret } = await call('POST', '/api-keys', { name: 'MOS', permissions: ['all'] }, auth);
  fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  return secret;
}

async function scanPhotos(key) {
  const headers = { 'x-api-key': key };
  let library = (await call('GET', '/libraries', undefined, headers)).find((item) => item.importPaths.includes(photos));
  if (!library) {
    const owner = await call('GET', '/users/me', undefined, headers);
    library = await call('POST', '/libraries', { importPaths: [photos], name: 'Photos', ownerId: owner.id }, headers);
    log('added the Photos library');
  }
  await call('POST', `/libraries/${library.id}/scan`, undefined, headers);
  log('asked Immich to scan the Photos library');
}

(async () => {
  if (!await serverAnswers()) return log('Immich did not answer; setup is retried at the next start');
  let key;
  try { key = await apiKey(); } catch (error) {
    return log(`could not sign in with the administrator login from install (${error.message}); the Photos library is left as it is`);
  }
  if (!fs.existsSync(photos)) return;
  try { await scanPhotos(key); } catch (error) { log(`could not set up the Photos library (${error.message}); retried at the next start`); }
})();
JS

# The base image starts via `tini -- /bin/bash -c start.sh`; start.sh (on PATH at
# /usr/src/app/server/bin) sets up mimalloc, ffmpeg lib paths, secrets and the
# threadpool before exec'ing node. Hand off to it unchanged.
exec /usr/src/app/server/bin/start.sh "$@"
