#!/usr/bin/env bash
# Runs in the tooling container. Converts the baked Hyper-V disk to a raw image
# and reports what the in-guest finalize step recorded on the ESP.
set -euo pipefail

source_disk="${1:?usage: extract-image.sh <bake.vhdx> <output.img>}"
output_image="${2:?usage: extract-image.sh <bake.vhdx> <output.img>}"

# Hyper-V hands this a vhdx and QEMU a qcow2. Taken from the extension rather
# than from `qemu-img info`, whose JSON reports the *protocol* format first — the
# nested children[] entry says "file", and converting with that copies the
# container header through and produces an image with no partition table.
case "$source_disk" in
  *.vhdx) source_format=vhdx ;;
  *.qcow2) source_format=qcow2 ;;
  *.vhd) source_format=vpc ;;
  *.img | *.raw) source_format=raw ;;
  *) echo "Unknown source disk format for $source_disk" >&2; exit 1 ;;
esac

echo "[mos-image] Converting $source_disk ($source_format) to a raw image."
qemu-img convert -p -f "$source_format" -O raw "$source_disk" "$output_image"

esp_start_sector="$(sfdisk -J "$output_image" | grep -o '"start": *[0-9]*' | head -n1 | grep -o '[0-9]*')"
esp_offset=$((esp_start_sector * 512))

echo
echo "[mos-image] Build status recorded by the guest:"
if mcopy -n -i "${output_image}@@${esp_offset}" ::/mos-image.json - 2>/dev/null; then
  :
else
  echo "  (none — the guest never reached the end of finalize)"
fi

if mcopy -n -i "${output_image}@@${esp_offset}" ::/mos-image-build.log /tmp/build.log 2>/dev/null; then
  cp /tmp/build.log "$(dirname "$output_image")/mos-image-build.log"
  echo
  echo "[mos-image] Last lines of the finalize log:"
  tail -n 25 /tmp/build.log | sed 's/^/  /'
fi

echo
echo "[mos-image] Raw size before shrinking: $(du -h "$output_image" | cut -f1)"
