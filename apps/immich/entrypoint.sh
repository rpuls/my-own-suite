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

# The base image starts via `tini -- /bin/bash -c start.sh`; start.sh (on PATH at
# /usr/src/app/server/bin) sets up mimalloc, ffmpeg lib paths, secrets and the
# threadpool before exec'ing node. Hand off to it unchanged.
exec /usr/src/app/server/bin/start.sh "$@"
