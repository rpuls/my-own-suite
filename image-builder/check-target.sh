#!/usr/bin/env bash
# Asserts what a first boot is supposed to have done to the machine it landed on:
# grown the system partition to its cap, given the rest of the disk to an
# encrypted vault, and put its swapfile inside that vault rather than beside it.
#
# None of it can be checked on the artifact, because all of it is sized against a
# disk the build cannot know — only on a copy that has been booted on an
# oversized one. The first version of this first boot filled the root filesystem
# to 100% with a flat 2 GB swapfile and the image still booted, answered on port
# 80 for a while, and then returned 502. That is the regression this exists to
# catch, and the vault checks below are the second: an image that quietly stopped
# encrypting would pass every other check in the pipeline.
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
# The same rule as system-agents/vault/layout.cjs: 15% of the disk, floored at
# 12 GiB and capped at 24 GiB. Restated here rather than imported because this
# script runs against a powered-off disk image with no MOS on the host, and a
# check that cannot run is worse than one stated twice.
cap_mb=$((expected_disk_gb * 1024 * 15 / 100))
[ "$cap_mb" -ge 12288 ] || cap_mb=12288
[ "$cap_mb" -le 24576 ] || cap_mb=24576
# Slack both ways: 1 MiB alignment, the ESP, and the filesystem's own metadata
# all sit between the partition size and what dumpe2fs reports.
cap_floor_mb=$((cap_mb - 512))
cap_ceiling_mb=$((cap_mb + 512))
if [ "$fs_mb" -ge "$cap_floor_mb" ] && [ "$fs_mb" -le "$cap_ceiling_mb" ]; then
  pass "system filesystem grew to its ${cap_mb} MB cap (${fs_mb} MB) on a ${expected_disk_gb} GB disk"
elif [ "$fs_mb" -gt "$cap_ceiling_mb" ]; then
  fail "system filesystem is ${fs_mb} MB on a ${expected_disk_gb} GB disk, past the ${cap_mb} MB cap — it took space the vault needed"
else
  fail "system filesystem is ${fs_mb} MB, expected about ${cap_mb} MB — the first boot did not expand it"
fi

# The vault itself: present, of the expected size, and actually encrypted. Its
# contents are deliberately unreadable from here, which is the point — this is
# the check that would fail if MOS ever stopped encrypting and nothing else
# noticed.
vault_line="$(sfdisk -d "$image" | awk '/img3 *:/ { print }')"
if [ -z "$vault_line" ]; then
  fail "no third partition — the first boot did not create the encrypted vault"
else
  vault_start="$(printf '%s' "$vault_line" | awk '{ gsub(",", "", $4); print $4 }')"
  vault_sectors="$(printf '%s' "$vault_line" | awk '{ for (i = 1; i <= NF; i++) if ($i == "size=") { gsub(",", "", $(i + 1)); print $(i + 1) } }')"
  [ -n "$vault_sectors" ] || vault_sectors="$(printf '%s' "$vault_line" | sed -n 's/.*size= *\([0-9]*\).*/\1/p')"
  vault_mb=$((vault_sectors / 2048))
  vault_part="$(losetup -f --show -o $((vault_start * 512)) "$image")"
  vault_type="$(blkid -o value -s TYPE "$vault_part" 2>/dev/null || true)"
  if [ "$vault_type" = 'crypto_LUKS' ]; then
    pass "vault partition is LUKS-encrypted (${vault_mb} MB)"
  else
    fail "the third partition is '${vault_type:-unreadable}', not crypto_LUKS — app data on this image is not encrypted"
  fi
  # Everything the system partition did not take, minus alignment.
  vault_floor_mb=$((expected_disk_gb * 1024 - cap_mb - 1024))
  if [ "$vault_mb" -ge "$vault_floor_mb" ]; then
    pass "vault took the rest of the disk (${vault_mb} MB of ${expected_disk_gb} GB)"
  else
    fail "vault is ${vault_mb} MB, expected at least ${vault_floor_mb} MB — the rest of the disk is unclaimed"
  fi
  losetup -d "$vault_part" 2>/dev/null || true
fi

if [ -e /mnt/target/etc/mos/vault.json ]; then
  # `"slot": "enrolled"` rather than the presence of a tpm block: a chip that
  # refused at first boot is recorded too, as `needs-repair`, and that machine
  # would ask for the key after every restart.
  if grep -q '"slot": "enrolled"' /mnt/target/etc/mos/vault.json; then
    pass "the vault key is sealed to this machine's TPM, so it opens itself after a power cut"
  else
    fail "the vault was created without a working TPM keyslot — this machine would ask for the recovery key after every restart"
  fi
else
  fail "no /etc/mos/vault.json — the first boot never recorded what it did to the disk"
fi

available_mb="$(df -Pm /mnt/target | awk 'NR == 2 { print $4 }')"
used_percent="$(df -P /mnt/target | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if [ "$available_mb" -ge 2048 ]; then
  pass "${available_mb} MB free after first boot (${used_percent}% used)"
else
  fail "only ${available_mb} MB free after first boot (${used_percent}% used) — something filled the disk"
fi

# Swap holds pages of decrypted app data, so on a machine with a vault it belongs
# inside it. One on the system partition would be a plaintext copy of the thing
# the vault protects, lying next to it.
if [ -e /mnt/target/swap.img ]; then
  fail "there is a swapfile on the unencrypted system partition — it can hold decrypted app data"
else
  pass "no swapfile on the system partition"
fi
if grep -q 'swap' /mnt/target/etc/fstab; then
  fail "/etc/fstab still mounts swap — a swapfile inside the vault must never be in fstab, or a locked disk becomes a boot failure"
else
  pass "no swap in fstab, so a locked vault cannot turn into a failed boot"
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

# The handover is the only route to this machine's console password, and Suite
# Manager runs as the unprivileged runtime user. A root-owned copy is unreadable
# to it and reads exactly like an owner who already saved their password, so
# nothing else on the machine reports it. The ISO path never had the fault, which
# is why its suite cannot catch it: the bootstrap there runs after first boot and
# chowns the whole state root.
#
# On a machine with a vault this file is inside it, and the vault is encrypted
# with a key only that machine has ever held — so it cannot be read from here at
# all. That is the check working, not the check failing, and the assertion it
# used to make belongs in the browser suite that can sign in and look at the
# panel. The offline check still runs on an image that has no vault.
handover=/mnt/target/var/lib/mos/suite-manager/console-login.json
if [ ! -e "$handover" ] && [ -e /mnt/target/etc/mos/vault.json ]; then
  pass "console login handover is inside the encrypted vault, so it is not readable from a powered-off disk"
elif [ ! -e "$handover" ]; then
  fail "no console login handover — mos-console-login-init did not run, so this machine has no reachable password"
else
  # Compared numerically, and against the *target's* passwd. `stat -c %U` resolves
  # an owner through whatever passwd database the machine running stat has, which
  # here is the CI runner rather than the image mounted under /mnt/target — uid
  # 1000 is `mos` inside the image and `packer` on a GitHub runner, so the name
  # comparison this replaces failed a correctly-owned file.
  handover_uid="$(stat -c '%u' "$handover")"
  # `User=` is the only place the unit states who Suite Manager runs as; it
  # carries no MOS_RUNTIME_USER environment line.
  runtime_user="$(awk -F= '/^User=/ { print $2; exit }' /mnt/target/etc/systemd/system/mos-suite-manager.service 2>/dev/null)"
  [ -n "$runtime_user" ] || runtime_user=mos
  runtime_uid="$(awk -F: -v user="$runtime_user" '$1 == user { print $3; exit }' /mnt/target/etc/passwd)"

  if [ -z "$runtime_uid" ]; then
    fail "the image has no '${runtime_user}' account, but mos-suite-manager.service runs as one"
  elif [ "$handover_uid" = "$runtime_uid" ]; then
    pass "console login handover is readable by Suite Manager (${runtime_user}, uid ${runtime_uid})"
  else
    fail "console login handover is owned by uid ${handover_uid}, not ${runtime_user} (uid ${runtime_uid}) — Suite Manager cannot hand the password over"
  fi
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "[mos-image] $failures check(s) failed." >&2
  exit 1
fi
echo "[mos-image] The booted image looks like a correctly installed machine."
