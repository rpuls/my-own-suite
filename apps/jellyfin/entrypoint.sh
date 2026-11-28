#!/bin/bash
set -uo pipefail

# MOS package wrapper. Jellyfin creates its administrator and its libraries only
# through its own API. MOS forgets the administrator password once the health
# check first passes, so the steps that need it (the first-run wizard and an API
# key) run first on a server only loopback can reach. A background job then uses
# the key to add a library for each folder MOS mounted and to ask for a scan on
# every start, which is how files copied while the drive was away are found.

API=http://127.0.0.1:8096
KEY_FILE=/config/mos-api-key
NETWORK_FILE=$JELLYFIN_CONFIG_DIR/network.xml
CLIENT='MediaBrowser Client="MOS", Device="MOS", DeviceId="mos-package", Version="1"'
TOKEN=''

log() { echo "MOS: $*"; }

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

api() {
  local method=$1 path=$2
  local auth=$CLIENT
  local data=()
  [ -n "$TOKEN" ] && auth="$CLIENT, Token=\"$TOKEN\""
  [ $# -ge 3 ] && data=(--data-binary "$3")
  curl -fsS -m 60 -X "$method" -H 'Content-Type: application/json' -H "Authorization: $auth" "${data[@]}" "$API$path"
}

# /health answers while the server is still starting, before the API does.
wait_for_server() {
  local server=$1
  for _ in $(seq 1 300); do
    kill -0 "$server" 2>/dev/null || return 1
    curl -fsS -m 5 "$API/System/Info/Public" 2>/dev/null | grep -q '"StartupWizardCompleted"' && return 0
    sleep 2
  done
  return 1
}

wizard_completed() {
  api GET /System/Info/Public | grep -q '"StartupWizardCompleted":true'
}

finish_wizard() {
  wizard_completed && return 0
  api POST /Startup/Configuration '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}' \
    && api GET /Startup/User >/dev/null \
    && api POST /Startup/User "{\"Name\":$(json_string "$MOS_ADMIN_NAME"),\"Password\":$(json_string "$MOS_ADMIN_PASSWORD")}" \
    && api POST /Startup/RemoteAccess '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}' \
    && api POST /Startup/Complete \
    && log "created the administrator $MOS_ADMIN_NAME"
}

# An API key outlives the owner changing their password, which the login from
# install would not.
mint_api_key() {
  local session
  session=$(api POST /Users/AuthenticateByName "{\"Username\":$(json_string "$MOS_ADMIN_NAME"),\"Pw\":$(json_string "$MOS_ADMIN_PASSWORD")}") || return 1
  TOKEN=$(printf '%s' "$session" | sed -n 's/.*"AccessToken":"\([^"]*\)".*/\1/p')
  [ -n "$TOKEN" ] || return 1
  api POST '/Auth/Keys?app=MOS' || return 1
  TOKEN=$(api GET /Auth/Keys | sed -n 's/.*"AccessToken":"\([0-9a-f]*\)","DeviceId":"[^"]*","AppName":"MOS".*/\1/p')
  [ -n "$TOKEN" ] || return 1
  (umask 077 && printf '%s' "$TOKEN" > "$KEY_FILE")
}

sign_in() {
  TOKEN=$(cat "$KEY_FILE" 2>/dev/null || true)
  [ -n "$TOKEN" ] && api GET /System/Info >/dev/null 2>&1
}

# MOS_LIBRARIES is "Name|collection type|path" entries separated by ";". A
# folder MOS did not mount, because the owner installed without a drive, has no
# library made for it.
add_libraries() {
  local existing entry name type path
  existing=$(api GET /Library/VirtualFolders) || return 1
  IFS=';' read -ra entries <<< "${MOS_LIBRARIES:-}"
  for entry in "${entries[@]}"; do
    IFS='|' read -r name type path <<< "$entry"
    [ -d "$path" ] || continue
    printf '%s' "$existing" | grep -qF "\"$path\"" && continue
    api POST "/Library/VirtualFolders?name=$(printf '%s' "$name" | sed 's/ /%20/g')&collectionType=$type&refreshLibrary=false" \
      "{\"LibraryOptions\":{\"EnableRealtimeMonitor\":true,\"SaveLocalMetadata\":false,\"SaveSubtitlesWithMedia\":false,\"SaveLyricsWithMedia\":false,\"SaveTrickplayWithMedia\":false,\"PathInfos\":[{\"Path\":\"$path\"}]}}" \
      && log "added the $name library"
  done
}

# Every visitor reaches Jellyfin through Caddy at this network's gateway, so
# Jellyfin must trust Caddy's X-Forwarded-For to tell home from away. It reads
# network.xml only at start; private ranges count as home, as Jellyfin would
# judge them without a proxy, and stay the owner's to change after first start.
trust_caddy() {
  local hex gateway proxies
  hex=$(while read -r _ destination via _; do [ "$destination" = 00000000 ] && echo "$via"; done < /proc/net/route)
  [ ${#hex} -eq 8 ] || { log 'found no gateway; Jellyfin will see every visitor as Caddy'; return; }
  gateway=$(printf '%d.%d.%d.%d' "0x${hex:6:2}" "0x${hex:4:2}" "0x${hex:2:2}" "0x${hex:0:2}")
  proxies="<KnownProxies><string>$gateway</string></KnownProxies>"
  if [ -f "$NETWORK_FILE" ]; then
    sed -zi "s#<KnownProxies */>\|<KnownProxies>.*</KnownProxies>#$proxies#" "$NETWORK_FILE"
  else
    mkdir -p "$JELLYFIN_CONFIG_DIR"
    printf '<?xml version="1.0" encoding="utf-8"?>\n<NetworkConfiguration>\n  %s\n  <LocalNetworkSubnets><string>10.0.0.0/8</string><string>172.16.0.0/12</string><string>192.168.0.0/16</string><string>fc00::/7</string></LocalNetworkSubnets>\n</NetworkConfiguration>\n' "$proxies" > "$NETWORK_FILE"
  fi
}

bind_to_loopback() {
  local only='<LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses>'
  [ -f "$NETWORK_FILE" ] || printf '<?xml version="1.0" encoding="utf-8"?>\n<NetworkConfiguration>\n</NetworkConfiguration>\n' > "$NETWORK_FILE"
  if grep -q '<LocalNetworkAddresses' "$NETWORK_FILE"; then
    sed -zi "s#<LocalNetworkAddresses */>\|<LocalNetworkAddresses>.*</LocalNetworkAddresses>#$only#" "$NETWORK_FILE"
  else
    sed -i "s#</NetworkConfiguration>#  $only\n</NetworkConfiguration>#" "$NETWORK_FILE"
  fi
}

# Also clears the binding a stopped private start left behind; nobody binds the
# container to loopback alone on purpose, since Caddy could not reach it.
bind_to_network() {
  [ -f "$NETWORK_FILE" ] && sed -zi 's#<LocalNetworkAddresses>\s*<string>127\.0\.0\.1</string>\s*</LocalNetworkAddresses>#<LocalNetworkAddresses />#' "$NETWORK_FILE"
  return 0
}

# Without an administrator the real start would offer the first-run wizard to
# anyone, so that failure stops the container and MOS keeps the password.
set_up_privately() {
  local server outcome=0
  bind_to_loopback
  /jellyfin/jellyfin "$@" &
  server=$!
  trap 'kill -TERM "$server" 2>/dev/null; exit 143' TERM INT
  if ! wait_for_server "$server"; then
    log 'Jellyfin did not answer during first-run setup'
    outcome=1
  elif ! finish_wizard || ! wizard_completed; then
    log 'could not finish the first-run setup; retried at the next start'
    outcome=1
  elif ! mint_api_key; then
    log 'could not sign in with the administrator login from install; libraries are left as they are'
  fi
  kill -TERM "$server" 2>/dev/null
  wait "$server"
  trap - TERM INT
  bind_to_network
  return "$outcome"
}

provision() {
  wait_for_server "$1" || { log 'Jellyfin did not answer; libraries are retried at the next start'; return; }
  sign_in || { log "Jellyfin refused the API key in $KEY_FILE; libraries are left as they are"; return; }
  add_libraries || log 'could not add the libraries; retried at the next start'
  api POST /Library/Refresh && log 'asked Jellyfin to scan its libraries'
}

trust_caddy
bind_to_network
if [ ! -s "$KEY_FILE" ]; then
  if [ -n "${MOS_ADMIN_PASSWORD:-}" ]; then
    set_up_privately "$@" || exit 1
  else
    log "no API key in $KEY_FILE and no administrator password to make one; libraries are left as they are"
  fi
fi

# Bash stays PID 1 instead of exec'ing Jellyfin, which reaps nothing, so the
# finished setup job does not linger as a zombie. A stop is passed on to Jellyfin.
/jellyfin/jellyfin "$@" &
server=$!
trap 'kill -TERM "$server" 2>/dev/null' TERM INT
[ -s "$KEY_FILE" ] && provision "$server" &
wait "$server"
status=$?
while kill -0 "$server" 2>/dev/null; do wait "$server"; status=$?; done
exit "$status"
