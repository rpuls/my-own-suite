#!/usr/bin/env bash
# What the containers on this machine send off it, one line per event, until stdin
# closes. network.mjs runs it as root over SSH and reads these lines:
#   T <epoch>                      the lab's clock as the capture starts
#   H <address>...                 this machine's own addresses
#   S <domain>...                  the resolver's search domains, which name local hosts
#   C <epoch> <name> <address>...  a container started, with its addresses
#   N <name> <packet>              a DNS lookup an app container sent to Docker's resolver
#   D <epoch> <name>               a container stopped
#   X <epoch> <name> <address>     a control lookup and connection to example.com left that app container
#   R                              the capture is running
#   E <reason>                     the capture could not start
#   <packet>                       tcpdump's line for a packet anywhere on the machine
# Docker forwards a container's lookups from the host, so they are read inside each app
# container, while its connections are read on the bridges, which exist before it starts.
set -u
CONTROL=example.com
PUBLIC='not (dst net 10.0.0.0/8 or dst net 172.16.0.0/12 or dst net 192.168.0.0/16 or dst net 127.0.0.0/8 or dst net 169.254.0.0/16 or dst net 100.64.0.0/10 or dst net 224.0.0.0/4 or dst host 255.255.255.255)'
FILTER="port 53 or ((tcp[tcpflags] & (tcp-syn|tcp-ack) == tcp-syn or udp) and $PUBLIC)"
declare -A watching names

now() { date +%s.%N; }

for tool in tcpdump nsenter curl dig docker sed; do
  command -v "$tool" >/dev/null || { echo "E $tool is not installed on the lab"; exit 1; }
done
echo "T $(now)"
echo "H $(hostname -I)"
echo "S $(awk '$1 == "search" { $1 = ""; print }' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null | tr '\n' ' ')"

control() {
  local name=$1 pid=$2 address
  address=$(getent ahostsv4 "$CONTROL" | awk 'NR == 1 { print $1 }')
  [ -n "$address" ] || return
  nsenter -t "$pid" -n dig +short +time=2 +tries=1 @127.0.0.11 "$CONTROL" >/dev/null 2>&1
  nsenter -t "$pid" -n curl -s -o /dev/null -m 5 --resolve "$CONTROL:443:$address" "https://$CONTROL/"
  echo "X $(now) $name $address"
}

started() {
  local line name pid addresses
  [ -n "${watching[$1]:-}" ] && return
  line=$(docker inspect --format '{{.Name}} {{.State.Pid}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" 2>/dev/null) || return
  read -r name pid addresses <<<"${line#/}"
  echo "C $(now) $name $addresses"
  watching[$1]=0
  names[$1]=$name
  case $name in mos-app-*) ;; *) return ;; esac
  [ "$pid" -gt 0 ] || return
  nsenter -t "$pid" -n tcpdump -i lo -nn -tt -l -T domain 'udp and dst host 127.0.0.11' 2>/dev/null > >(sed -u "s/^/N $name /") &
  watching[$1]=$!
  { sleep 1; control "$name" "$pid"; } &
}

stopped() {
  [ -n "${names[$1]:-}" ] && echo "D $(now) ${names[$1]}"
  [ "${watching[$1]:-0}" != 0 ] && kill "${watching[$1]}" 2>/dev/null
  unset "watching[$1]" "names[$1]"
}

tcpdump -i any -nn -tt -l "$FILTER" 2>/dev/null &
sleep 1
kill -0 $! 2>/dev/null || { echo "E tcpdump did not start"; exit 1; }
since=$(now)
for id in $(docker ps -q --no-trunc); do started "$id"; done
echo R
# A background job reads /dev/null unless told otherwise, so the watchdog gets stdin by name.
exec 3<&0
{ cat <&3 >/dev/null; kill 0; } &
while read -r action id; do
  if [ "$action" = start ]; then started "$id"; else stopped "$id"; fi
done < <(docker events --since "$since" --filter type=container --filter event=start --filter event=die --format '{{.Action}} {{.Actor.ID}}')
