#!/usr/bin/env bash
# Asserts what a first boot is supposed to have done to the machine it landed on:
# claimed the whole disk, and given itself a swapfile that fits in what was left.
#
# Neither can be checked on the artifact, because both are sized against a disk
# the build cannot know — only on a copy that has been booted on an oversized one.
# The first version of mos-grow-root filled the root filesystem to 100% with a
# flat 2 GB swapfile and the image still booted, answered on port 80 for a while,
# and then returned 502. That is the regression this exists to catch.
#
# Runs as root: privileged in the tooling container, under sudo in CI.
set -euo pipefail

image="${1:?usage: check-target.sh <booted-image.img> [expected-disk-gb]}"
expected_disk_gb="${2:-40}"

# An offset loop rather than `losetup -P`, matching shrink-image.sh: a container's
# /dev is not udev-managed, so partition nodes are not guaranteed to appear.
root_start="$(sfdisk -d "$image" | awk '/img2 *:/ { gsub(",", "", $4); print $4 }')"
[ -n "$root_start" ] || { echo "[mos-image] No root partition in $image" >&2; exit 1; }

root_part="$(losetup -f --show -o $((root_start * 512)) "$image")"
cleanup() {
  umount /mnt/target 2>/dev/null || true
  losetup -d "$root_part" 2>/dev/null || true
}
trap cleanup EXIT

# A VM that fails to shut down cleanly is turned off instead, which leaves a dirty
# journal that a read-only mount would refuse to replay.
e2fsck -fy "$root_part" >/dev/null 2>&1 || true

mkdir -p /mnt/target
mount -o ro "$root_part" /mnt/target

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

echo "[mos-image] Checking what the first boot did:"

block_count="$(dumpe2fs -h "$root_part" 2>/dev/null | awk -F': *' '/^Block count:/ { print $2 }')"
block_size="$(dumpe2fs -h "$root_part" 2>/dev/null | awk -F': *' '/^Block size:/ { print $2 }')"
fs_mb=$((block_count * block_size / 1024 / 1024))
# Anything above the image's own size proves growth happened; the disk is a little
# smaller than its nominal size once the ESP and GPT are taken out.
grow_floor_mb=$((expected_disk_gb * 1024 - 2048))
if [ "$fs_mb" -ge "$grow_floor_mb" ]; then
  pass "root filesystem grew to ${fs_mb} MB on a ${expected_disk_gb} GB disk"
else
  fail "root filesystem is ${fs_mb} MB, expected at least ${grow_floor_mb} MB — mos-grow-root did not expand it"
fi

available_mb="$(df -Pm /mnt/target | awk 'NR == 2 { print $4 }')"
used_percent="$(df -P /mnt/target | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if [ "$available_mb" -ge 2048 ]; then
  pass "${available_mb} MB free after first boot (${used_percent}% used)"
else
  fail "only ${available_mb} MB free after first boot (${used_percent}% used) — something filled the disk"
fi

if [ -e /mnt/target/swap.img ]; then
  swap_mb=$(($(stat -c %s /mnt/target/swap.img) / 1024 / 1024))
  pass "swapfile created (${swap_mb} MB)"
  if grep -q '^/swap\.img' /mnt/target/etc/fstab; then
    pass "swapfile is in fstab, so it survives a reboot"
  else
    fail "swapfile exists but is missing from fstab — it will not come back after a reboot"
  fi
else
  fail "no /swap.img — mos-grow-root did not create one"
fi

if [ -e /mnt/target/etc/cloud/cloud-init.disabled ]; then
  pass "cloud-init still disabled"
else
  fail "cloud-init re-enabled itself, so this machine can be re-provisioned unexpectedly"
fi

host_keys="$(find /mnt/target/etc/ssh -name 'ssh_host_*' 2>/dev/null | wc -l)"
if [ "$host_keys" -gt 0 ]; then
  pass "generated its own SSH host keys (${host_keys} files)"
else
  fail "no SSH host keys — mos-ssh-hostkeys did not run"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "[mos-image] $failures check(s) failed." >&2
  exit 1
fi
echo "[mos-image] The booted image looks like a correctly installed machine."
