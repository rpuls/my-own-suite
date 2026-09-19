#!/usr/bin/env bash
# Runs in the tooling container, privileged. Reads the finished image and states
# what is actually in it, because an image that was built before an edit landed
# looks exactly like one that was built after it. Release-stopping on two counts:
# an installer that can leave a machine running from the stick, and a published
# image somebody can log into.
set -euo pipefail

image="${1:?usage: check-image-payload.sh <image.img>}"
failures=0

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

esp_start_sector="$(sfdisk -J "$image" | grep -o '"start": *[0-9]*' | head -n1 | grep -o '[0-9]*')"
esp_offset=$((esp_start_sector * 512))
image_json="$(mcopy -n -i "${image}@@${esp_offset}" ::/mos-image.json - 2>/dev/null || true)"
profile="$(printf '%s' "$image_json" | grep -o '"profile":"[a-z]*"' | cut -d'"' -f4)"
repo_ref="$(printf '%s' "$image_json" | grep -o '"repoRef":"[^"]*"' | cut -d'"' -f4)"
built_at="$(printf '%s' "$image_json" | grep -o '"builtAt":"[^"]*"' | cut -d'"' -f4)"

root_start_sector="$(sfdisk -J "$image" | tr -d ' "' | grep -A4 'node:.*2' | grep '^start:' | head -n1 | grep -o '[0-9]*')"
[ -n "$root_start_sector" ] || { echo "Could not locate the root partition."; exit 1; }
mkdir -p /mnt/root
mount -o ro,loop,offset=$((root_start_sector * 512)) "$image" /mnt/root
trap 'umount /mnt/root 2>/dev/null || true' EXIT

printf '\n[mos-image] What is in this image:\n'
printf '  built %s from %s, %s profile\n' "${built_at:-unknown}" "${repo_ref:-unknown}" "${profile:-release}"

installer=/mnt/root/usr/local/sbin/mos-self-install
if [ -f "$installer" ]; then
  pass 'the installer is on the image'
  if grep -qi 'run from this' "$installer"; then
    fail 'the installer still offers to run from the stick'
  else
    pass 'the installer only installs; declining restarts the machine'
  fi
  if grep -q 'reboot -f' "$installer" && grep -q 'stop_here' "$installer"; then
    pass 'every way out of the installer ends in a restart'
  else
    fail 'the installer can end without restarting'
  fi
  if grep -q 'mos-install.log' "$installer"; then
    pass 'the installer writes a log to the stick'
  else
    fail 'the installer writes no log'
  fi
else
  fail 'no installer on the image'
fi

keys="$(find /mnt/root/home /mnt/root/root -name authorized_keys -size +0 2>/dev/null || true)"
if [ "$profile" = 'lab' ]; then
  if [ -n "$keys" ]; then
    pass "a development key is on this image, so it must not be published ($(printf '%s' "$keys" | head -n1))"
  else
    fail 'debug bake with no key on it, so a failed install cannot be logged into'
  fi
elif [ -n "$keys" ]; then
  fail "a release image with an SSH key on it: $keys"
else
  pass 'no SSH key on this release image'
fi

# The key is only half the way in: the password is locked, so a passwordless
# sudo rule ships with it. Both are asked about, because either one alone on a
# release image is the same mistake.
sudoers='/mnt/root/etc/sudoers.d/90-mos-debug'
if [ "$profile" = 'lab' ]; then
  if [ -f "$sudoers" ]; then
    pass 'the development key can become root on this image'
  else
    fail 'debug bake whose key cannot sudo, so a failed install cannot be repaired'
  fi
elif [ -f "$sudoers" ]; then
  fail "a release image with a passwordless sudo rule on it: $sudoers"
else
  pass 'no passwordless sudo rule on this release image'
fi

if [ "$failures" -eq 0 ]; then
  printf '\n[mos-image] The image carries what this checkout says it should.\n'
else
  printf '\n[mos-image] %d check(s) failed: this image is not what this checkout says it is.\n' "$failures"
  exit 1
fi
