#!/bin/sh
set -eu

if [ "${MOS_ONLINE_METADATA:-true}" = false ] && [ "${ND_AGENTS+x}" != x ]; then
  export ND_AGENTS=''
fi

if [ -f /data/navidrome.db ] && [ "$(sqlite3 /data/navidrome.db 'SELECT count(*) FROM user;' 2>/dev/null)" -gt 0 ]; then
  exec /app/navidrome "$@"
fi

# Keep first-run account creation private until the owner's administrator exists.
ND_ADDRESS=127.0.0.1 /app/navidrome "$@" &
server=$!
trap 'kill -TERM "$server" 2>/dev/null || true' EXIT
trap 'exit 143' TERM INT
ready=false
for attempt in $(seq 1 120); do
  kill -0 "$server" 2>/dev/null || exit 1
  if curl -fsS --max-time 2 http://127.0.0.1:4533/ping >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || { echo 'MOS: Navidrome did not become ready for administrator setup' >&2; exit 1; }

awk '
function quote(value, result, i, char, code) {
  result = "\""
  for (i = 1; i <= length(value); i++) {
    char = substr(value, i, 1)
    if (char == "\"" || char == "\\") result = result "\\" char
    else {
      for (code = 1; code < 32; code++) if (char == sprintf("%c", code)) break
      result = result (code < 32 ? sprintf("\\u%04x", code) : char)
    }
  }
  return result "\""
}
BEGIN { print "{\"username\":" quote(ENVIRON["MOS_ADMIN_NAME"]) ",\"password\":" quote(ENVIRON["MOS_ADMIN_PASSWORD"]) "}" }
' | curl -fsS --max-time 30 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4533/auth/createAdmin >/dev/null

kill -TERM "$server"
wait "$server" || true
trap - EXIT TERM INT
exec /app/navidrome "$@"
