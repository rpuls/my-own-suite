#!/usr/bin/env bash
# Runs in the tooling container, privileged. Shrinks a converted raw image to its
# actual contents so the published download is not mostly empty space, then
# compresses it. The target machine grows the filesystem back on first boot.
set -euo pipefail

image="${1:?usage: shrink-image.sh <image.img> [slack_mb]}"
slack_mb="${2:-512}"

sectors_of() { echo $(( $1 / 512 )); }

root_start="$(sfdisk -d "$image" | awk '/img2 *:/ { gsub(",", "", $4); print $4 }')"
[ -n "$root_start" ] || { echo "Could not find the root partition."; exit 1; }

before_bytes="$(stat -c %s "$image")"
echo "[mos-image] Before: $((before_bytes / 1024 / 1024 / 1024)) GB"

loop="$(losetup -f --show -o $((root_start * 512)) "$image")"
trap 'losetup -d "$loop" 2>/dev/null || true' EXIT

e2fsck -fy "$loop" >/dev/null 2>&1 || true
resize2fs -M "$loop" >/dev/null

block_size="$(dumpe2fs -h "$loop" 2>/dev/null | awk -F: '/^Block size/ { gsub(/ /, "", $2); print $2 }')"
minimum_blocks="$(dumpe2fs -h "$loop" 2>/dev/null | awk -F: '/^Block count/ { gsub(/ /, "", $2); print $2 }')"
slack_blocks=$(( slack_mb * 1024 * 1024 / block_size ))
target_blocks=$(( minimum_blocks + slack_blocks ))

echo "[mos-image] Filesystem shrunk to $((minimum_blocks * block_size / 1024 / 1024)) MB, growing back ${slack_mb} MB for headroom."
resize2fs "$loop" "${target_blocks}" >/dev/null
e2fsck -fy "$loop" >/dev/null 2>&1 || true

losetup -d "$loop"
trap - EXIT

filesystem_sectors="$(sectors_of $(( target_blocks * block_size )))"
root_end=$(( root_start + filesystem_sectors - 1 ))

# Recreate the entry rather than resize in place, preserving both GUIDs: the type
# GUID keeps it a Linux root, and the unique GUID keeps any PARTUUID reference valid.
type_guid="$(sgdisk -i 2 "$image" | awk -F'[:(]' '/Partition GUID code/ { gsub(/ /, "", $2); print $2 }')"
unique_guid="$(sgdisk -i 2 "$image" | awk -F': ' '/Partition unique GUID/ { gsub(/ /, "", $2); print $2 }')"
sgdisk -d 2 -n "2:${root_start}:${root_end}" -t "2:${type_guid}" -u "2:${unique_guid}" "$image" >/dev/null

# 33 sectors for the backup GPT header and entry array.
truncate -s $(( (root_end + 1 + 33) * 512 )) "$image"
sgdisk -e "$image" >/dev/null 2>&1 || true
sgdisk -v "$image" || true

after_bytes="$(stat -c %s "$image")"
echo "[mos-image] After:  $((after_bytes / 1024 / 1024 / 1024)) GB raw"

cd "$(dirname "$image")"
raw="$(basename "$image")"

echo "[mos-image] Compressing for download."
rm -f "${raw}.xz"
xz -T0 -6 -k "$raw"

sha256sum "$raw" "${raw}.xz" | tee SHA256SUMS
echo
echo "[mos-image] Download size: $(du -h "${raw}.xz" | cut -f1)"
