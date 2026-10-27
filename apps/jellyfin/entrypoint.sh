#!/bin/bash
set -uo pipefail

# MOS package wrapper. Jellyfin creates its administrator and its libraries only
# through its own API, so a background job does what the owner would otherwise
# click through: it finishes the first-run wizard with the login chosen at
# install, adds a library for each folder MOS mounted, and asks for a scan on
# every start, which is how files copied while the drive was away are found.
# A step that fails is logged and tried again at the next start; it never
# holds the server back.

API=http://localhost:8096
KEY_FILE=/config/mos-api-key
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
  for _ in $(seq 1 300); do
    curl -fsS -m 5 "$API/System/Info/Public" 2>/dev/null | grep -q '"StartupWizardCompleted"' && return 0
    sleep 2
  done
  return 1
}

finish_wizard() {
  api GET /System/Info/Public | grep -q '"StartupWizardCompleted":false' || return 0
  api POST /Startup/Configuration '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}' \
    && api GET /Startup/User >/dev/null \
    && api POST /Startup/User "{\"Name\":$(json_string "$MOS_ADMIN_NAME"),\"Password\":$(json_string "$MOS_ADMIN_PASSWORD")}" \
    && api POST /Startup/RemoteAccess '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}' \
    && api POST /Startup/Complete \
    && log "created the administrator $MOS_ADMIN_NAME"
}

# An API key outlives the owner changing their password, which the login from
# install would not.
sign_in() {
  TOKEN=$(cat "$KEY_FILE" 2>/dev/null || true)
  [ -n "$TOKEN" ] && api GET /System/Info >/dev/null 2>&1 && return 0
  TOKEN=''
  local session
  session=$(api POST /Users/AuthenticateByName "{\"Username\":$(json_string "$MOS_ADMIN_NAME"),\"Pw\":$(json_string "$MOS_ADMIN_PASSWORD")}") || return 1
  TOKEN=$(printf '%s' "$session" | sed -n 's/.*"AccessToken":"\([^"]*\)".*/\1/p')
  [ -n "$TOKEN" ] || return 1
  api POST '/Auth/Keys?app=MOS' || return 1
  TOKEN=$(api GET /Auth/Keys | sed -n 's/.*"AccessToken":"\([0-9a-f]*\)","DeviceId":"[^"]*","AppName":"MOS".*/\1/p')
  [ -n "$TOKEN" ] || return 1
  (umask 077 && printf '%s' "$TOKEN" > "$KEY_FILE")
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
  local file=$JELLYFIN_CONFIG_DIR/network.xml hex gateway proxies
  hex=$(while read -r _ destination via _; do [ "$destination" = 00000000 ] && echo "$via"; done < /proc/net/route)
  [ ${#hex} -eq 8 ] || { log 'found no gateway; Jellyfin will see every visitor as Caddy'; return; }
  gateway=$(printf '%d.%d.%d.%d' "0x${hex:6:2}" "0x${hex:4:2}" "0x${hex:2:2}" "0x${hex:0:2}")
  proxies="<KnownProxies><string>$gateway</string></KnownProxies>"
  if [ -f "$file" ]; then
    sed -zi "s#<KnownProxies */>\|<KnownProxies>.*</KnownProxies>#$proxies#" "$file"
  else
    mkdir -p "$JELLYFIN_CONFIG_DIR"
    printf '<?xml version="1.0" encoding="utf-8"?>\n<NetworkConfiguration>\n  %s\n  <LocalNetworkSubnets><string>10.0.0.0/8</string><string>172.16.0.0/12</string><string>192.168.0.0/16</string><string>fc00::/7</string></LocalNetworkSubnets>\n</NetworkConfiguration>\n' "$proxies" > "$file"
  fi
}

provision() {
  wait_for_server || { log 'Jellyfin did not answer; setup is retried at the next start'; return; }
  finish_wizard || { log 'could not finish the first-run setup; retried at the next start'; return; }
  sign_in || { log 'could not sign in with the administrator login from install; libraries are left as they are'; return; }
  add_libraries || log 'could not add the libraries; retried at the next start'
  api POST /Library/Refresh && log 'asked Jellyfin to scan its libraries'
}

trust_caddy
provision &
# Bash stays PID 1 instead of exec'ing Jellyfin, which reaps nothing, so the
# finished setup job does not linger as a zombie. A stop is passed on to Jellyfin.
/jellyfin/jellyfin "$@" &
server=$!
trap 'kill -TERM "$server" 2>/dev/null' TERM INT
wait "$server"
status=$?
while kill -0 "$server" 2>/dev/null; do wait "$server"; status=$?; done
exit "$status"
