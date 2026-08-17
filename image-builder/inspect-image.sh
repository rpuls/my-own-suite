#!/usr/bin/env bash
# Runs in the tooling container, privileged. Loop-mounts the root filesystem of a
# converted image read-only and prints the logs that explain a failed bake.
set -euo pipefail

image="${1:?usage: inspect-image.sh <image.img>}"

root_start_sector="$(sfdisk -J "$image" | tr -d ' "' | grep -A4 'node:.*2' | grep '^start:' | head -n1 | grep -o '[0-9]*')"
if [ -z "$root_start_sector" ]; then
  root_start_sector="$(sfdisk -d "$image" | awk '/2 :/ { gsub(",", "", $4); print $4 }' | head -n1)"
fi
[ -n "$root_start_sector" ] || { echo "Could not locate the root partition."; exit 1; }

mkdir -p /mnt/root
mount -o ro,loop,offset=$((root_start_sector * 512)) "$image" /mnt/root

show() {
  echo
  echo "===== $1 ====="
  if [ -f "/mnt/root$1" ]; then
    tail -n "${2:-60}" "/mnt/root$1"
  else
    echo "(absent)"
  fi
}

show /var/log/cloud-init-output.log 120
show /var/log/cloud-init.log 40

echo
echo "===== state left behind ====="
for marker in /etc/cloud/cloud-init.disabled /etc/machine-id /var/lib/mos/suite-manager/console-login.json; do
  if [ -e "/mnt/root$marker" ]; then echo "present: $marker"; else echo "absent:  $marker"; fi
done
echo "ssh host keys: $(ls /mnt/root/etc/ssh/ssh_host_* 2>/dev/null | wc -l)"
echo "mos units enabled:"
ls -1 /mnt/root/etc/systemd/system/sysinit.target.wants/ 2>/dev/null | grep '^mos-' || echo "  (none)"
ls -1 /mnt/root/etc/systemd/system/multi-user.target.wants/ 2>/dev/null | grep '^mos-' || true
echo "installed control plane:"
ls -1 /mnt/root/opt/mos 2>/dev/null | head -20 || echo "  (/opt/mos absent)"

umount /mnt/root
