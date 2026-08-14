#!/usr/bin/env bash
# Linux/QEMU driver for the prebuilt disk image. The Windows driver
# (build-image.ps1) does the same stages against Hyper-V; both call the same
# seed renderer and the same extract/shrink scripts, so a locally built image and
# a CI built image come off the same pipeline.
#
#   ./image-builder/bake.sh all
#   ./image-builder/bake.sh seed | iso | bake | convert | verify
set -euo pipefail

stage="${1:-all}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
here="$repo_root/image-builder"
work="$here/.work"
seed_dir="$work/seed"
iso="$work/bake-installer.iso"
bake_disk="$work/bake.qcow2"
out_dir="$work/out"

repo_ref="${MOS_IMAGE_REPO_REF:-staging}"
disk_gb="${MOS_IMAGE_DISK_GB:-16}"
memory_mb="${MOS_IMAGE_MEMORY_MB:-6144}"
cpus="${MOS_IMAGE_CPUS:-4}"
bake_timeout="${MOS_IMAGE_BAKE_TIMEOUT:-5400}"
slack_mb="${MOS_IMAGE_SLACK_MB:-1024}"
verify_disk_gb="${MOS_IMAGE_VERIFY_DISK_GB:-40}"
verify_http_port="${MOS_IMAGE_VERIFY_HTTP_PORT:-18080}"
verify_monitor_port="${MOS_IMAGE_VERIFY_MONITOR_PORT:-18081}"
image_name="my-own-suite-${repo_ref}.img"

say() { printf '[mos-image] %s\n' "$*"; }
fail() { printf '[mos-image] %s\n' "$*" >&2; exit 1; }

# Prints the code and vars paths on stdout — callers capture it, so anything
# human-facing has to go to stderr.
#
# With `secure`, prefers the Secure Boot build paired with the variable store that
# has Microsoft's keys already enrolled. Most machines ship with Secure Boot on, so
# a verify without it would never exercise the signed-shim path that finalize
# copies over the fallback loader. Falls back to plain OVMF, which still boots and
# just proves less. Only verify asks for it: the bake installs stock Ubuntu, and
# firmware trouble there would cost the expensive stage for nothing.
find_ovmf() {
  local want="${1:-plain}" pair code vars candidates=()
  if [ "$want" = 'secure' ]; then
    candidates+=(
      '/usr/share/OVMF/OVMF_CODE_4M.secboot.fd|/usr/share/OVMF/OVMF_VARS_4M.ms.fd'
      '/usr/share/OVMF/OVMF_CODE.secboot.fd|/usr/share/OVMF/OVMF_VARS.ms.fd'
    )
  fi
  candidates+=(
    '/usr/share/OVMF/OVMF_CODE_4M.fd|/usr/share/OVMF/OVMF_VARS_4M.fd'
    '/usr/share/OVMF/OVMF_CODE.fd|/usr/share/OVMF/OVMF_VARS.fd'
    '/usr/share/edk2/ovmf/OVMF_CODE.fd|/usr/share/edk2/ovmf/OVMF_VARS.fd'
    '/usr/share/qemu/OVMF_CODE.fd|/usr/share/qemu/OVMF_VARS.fd'
  )
  for pair in "${candidates[@]}"; do
    code="${pair%%|*}"
    vars="${pair##*|}"
    [ -f "$code" ] && [ -f "$vars" ] || continue
    if [ "$want" = 'secure' ]; then
      case "$code" in
        *secboot*) say "Firmware: $(basename "$code"), Secure Boot keys enrolled." >&2 ;;
        *) say "Firmware: $(basename "$code") — no Secure Boot build installed, so this run does not test it." >&2 ;;
      esac
    fi
    printf '%s\n%s\n' "$code" "$vars"
    return 0
  done
  fail 'No OVMF firmware found. Install the ovmf package; a UEFI image needs UEFI firmware to boot.'
}

kvm_args() {
  # Without KVM this still runs, just emulated — which turns a 7 minute bake into
  # an overnight one, so say so rather than quietly taking hours.
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    printf '%s' '-enable-kvm -cpu host'
  else
    say 'WARNING: /dev/kvm is not usable, falling back to emulation. This will be very slow.'
    printf '%s' '-cpu max'
  fi
}

do_seed() {
  say "Rendering the bake seed for $repo_ref."
  mkdir -p "$work"
  MOS_IMAGE_REPO_REF="$repo_ref" node "$here/render-bake-seed.cjs"
}

do_iso() {
  [ -f "$seed_dir/user-data" ] || fail 'No seed found. Run the seed stage first.'
  say 'Remastering the installer ISO around the bake seed.'
  # --auto-boot: the published ISO waits at its GRUB menu forever on purpose, so
  # a person erasing their disk has to say so. Nobody is watching a bake.
  ( cd "$repo_root" && npm run installer:usb -- \
      --seed-dir "$seed_dir" --output-iso "$iso" --auto-boot=true )
}

do_bake() {
  [ -f "$iso" ] || fail 'No bake ISO found. Run the iso stage first.'
  mapfile -t ovmf < <(find_ovmf)
  rm -f "$bake_disk" "$work/OVMF_VARS.fd" "$work/bake-serial.log"
  cp "${ovmf[1]}" "$work/OVMF_VARS.fd"
  qemu-img create -f qcow2 "$bake_disk" "${disk_gb}G" >/dev/null

  say "Baking in QEMU: ${disk_gb} GB disk, ${cpus} vCPU, ${memory_mb} MB."
  say 'It installs Ubuntu, runs the MOS bootstrap, finalizes, then powers itself off.'
  local started
  started="$(date +%s)"

  # -boot once=d: the CD boots this once, and every reboot after the install lands
  # on the disk. Without it the freshly installed machine reinstalls itself.
  # shellcheck disable=SC2046
  timeout "$bake_timeout" qemu-system-x86_64 \
    $(kvm_args) \
    -machine q35,smm=on \
    -smp "$cpus" -m "$memory_mb" \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=${ovmf[0]}" \
    -drive "if=pflash,format=raw,unit=1,file=$work/OVMF_VARS.fd" \
    -drive "file=$bake_disk,if=virtio,format=qcow2,cache=writeback" \
    -cdrom "$iso" \
    -boot once=d \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
    -display none -serial "file:$work/bake-serial.log" \
    || fail "The bake did not finish within ${bake_timeout}s. Serial log: $work/bake-serial.log"

  say "The bake VM powered off after $(( ($(date +%s) - started) / 60 )) minutes."
}

do_convert() {
  [ -f "$bake_disk" ] || fail 'No baked disk found. Run the bake stage first.'
  mkdir -p "$out_dir"
  say 'Converting, shrinking and compressing.'
  # Invoked through bash rather than directly: these are authored on Windows, so
  # git does not carry an executable bit for them.
  bash "$here/extract-image.sh" "$bake_disk" "$out_dir/$image_name"
  bash "$here/shrink-image.sh" "$out_dir/$image_name" "$slack_mb"
}

do_verify() {
  local image="$out_dir/$image_name"
  [ -f "$image" ] || fail 'No image found. Run the convert stage first.'
  mapfile -t ovmf < <(find_ovmf secure)
  local secure_args=()
  case "${ovmf[0]}" in
    # Secure Boot only actually enforces when the variable store is protected,
    # which needs SMM and the pflash secure property. Without these OVMF boots
    # in setup mode and verifies nothing.
    *secboot*) secure_args=(-machine q35,smm=on -global driver=cfi.pflash01,property=secure,value=on) ;;
    *) secure_args=(-machine q35) ;;
  esac

  # A copy, grown past the image size, because nobody installs onto a disk exactly
  # the size of the download — and because that is what exercises mos-grow-root.
  local verify_image="$work/verify.img"
  rm -f "$verify_image" "$work/OVMF_VARS_VERIFY.fd"
  cp --sparse=always "$image" "$verify_image"
  qemu-img resize -f raw "$verify_image" "${verify_disk_gb}G" >/dev/null
  cp "${ovmf[1]}" "$work/OVMF_VARS_VERIFY.fd"

  # The local Caddyfile serves exactly one site block, so a request to the bare
  # address 404s however healthy the machine is. Read from the rendered seed
  # rather than hardcoded, so a domain change cannot turn this into a false pass.
  local home_host
  home_host="$(node -e "process.stdout.write(new URL(require('$seed_dir/bake-summary.json').home).host)")"

  say "Booting the published image on a ${verify_disk_gb} GB disk."
  # shellcheck disable=SC2046
  qemu-system-x86_64 \
    $(kvm_args) \
    "${secure_args[@]}" \
    -smp 2 -m 4096 \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=${ovmf[0]}" \
    -drive "if=pflash,format=raw,unit=1,file=$work/OVMF_VARS_VERIFY.fd" \
    -drive "file=$verify_image,if=virtio,format=raw" \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:${verify_http_port}-:80" \
    -device virtio-net-pci,netdev=net0 \
    -monitor "tcp:127.0.0.1:${verify_monitor_port},server=on,wait=off" \
    -display none -serial "file:$work/verify-serial.log" &
  local qemu_pid=$!
  # shellcheck disable=SC2064
  trap "kill $qemu_pid 2>/dev/null || true" EXIT

  local deadline=$(( $(date +%s) + 600 )) code=''
  while [ "$(date +%s)" -lt "$deadline" ]; do
    kill -0 "$qemu_pid" 2>/dev/null || fail "The image stopped running. Serial log: $work/verify-serial.log"
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
      -H "Host: $home_host" "http://127.0.0.1:${verify_http_port}/suite-manager/" 2>/dev/null || true)"
    if [ "$code" = '200' ]; then
      say "Suite Manager answered 200 on the published image (Host: $home_host)."
      shutdown_verify_vm "$qemu_pid"
      trap - EXIT
      say 'Checking what its first boot did to the disk.'
      sudo bash "$here/check-target.sh" "$verify_image" "$verify_disk_gb"
      rm -f "$verify_image"
      return 0
    fi
    sleep 10
  done

  fail "Suite Manager never answered (last status '${code:-none}'). Serial log: $work/verify-serial.log"
}

# ACPI shutdown over the QEMU monitor rather than a kill, so the filesystem the
# checks are about to judge is consistent. bash speaks TCP natively, so this needs
# no monitor client installed.
shutdown_verify_vm() {
  local qemu_pid="$1" deadline
  if exec 3<>"/dev/tcp/127.0.0.1/${verify_monitor_port}" 2>/dev/null; then
    printf 'system_powerdown\n' >&3
    exec 3<&-
    deadline=$(( $(date +%s) + 120 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      kill -0 "$qemu_pid" 2>/dev/null || return 0
      sleep 5
    done
    say 'It did not shut down within 120s; stopping it the hard way.'
  fi
  kill "$qemu_pid" 2>/dev/null || true
  wait "$qemu_pid" 2>/dev/null || true
}

case "$stage" in
  seed) do_seed ;;
  iso) do_iso ;;
  bake) do_bake ;;
  convert) do_convert ;;
  verify) do_verify ;;
  all) do_seed; do_iso; do_bake; do_convert; do_verify ;;
  *) fail "Unknown stage '$stage'. Use: seed, iso, bake, convert, verify, all." ;;
esac
