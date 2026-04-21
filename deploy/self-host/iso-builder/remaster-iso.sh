#!/usr/bin/env bash

set -euo pipefail

INPUT_ISO_BASENAME="${INPUT_ISO_BASENAME:-}"
OUTPUT_ISO_BASENAME="${OUTPUT_ISO_BASENAME:-}"
INPUT_ISO="/input/${INPUT_ISO_BASENAME}"
OUTPUT_ISO="/output/${OUTPUT_ISO_BASENAME}"

if [[ -z "${INPUT_ISO_BASENAME}" || -z "${OUTPUT_ISO_BASENAME}" ]]; then
  echo "INPUT_ISO_BASENAME and OUTPUT_ISO_BASENAME are required."
  exit 1
fi

if [[ ! -f "${INPUT_ISO}" ]]; then
  echo "Input ISO not found: ${INPUT_ISO}"
  exit 1
fi

if [[ ! -f /seed/user-data || ! -f /seed/meta-data ]]; then
  echo "Seed files were not mounted at /seed."
  exit 1
fi

WORK_ROOT="/workspace"
PATCH_ROOT="${WORK_ROOT}/patched"
AUTOINSTALL_ROOT="${PATCH_ROOT}/autoinstall"

rm -rf "${PATCH_ROOT}"
mkdir -p "${AUTOINSTALL_ROOT}"

cp /seed/user-data "${AUTOINSTALL_ROOT}/user-data"
cp /seed/meta-data "${AUTOINSTALL_ROOT}/meta-data"
if [[ -f /seed/selfhost-installer.env ]]; then
  cp /seed/selfhost-installer.env "${AUTOINSTALL_ROOT}/selfhost-installer.env"
fi

patch_grub_file() {
  local iso_path="$1"
  local file_name="$2"
  local disk_path="${PATCH_ROOT}/${file_name}"

  if ! xorriso -osirrox on -indev "${INPUT_ISO}" -extract "${iso_path}" "${disk_path}" >/dev/null 2>&1; then
    return 1
  fi

  chmod u+w "${disk_path}"

  python3 - "$disk_path" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

text = text.replace("set timeout=30", "set timeout=-1")
text = text.replace("set timeout=10", "set timeout=-1")
text = text.replace("set timeout=8", "set timeout=-1")
text = text.replace("set timeout_style=hidden", "set timeout_style=menu")

if "set default=" in text:
    text = re.sub(r"^set default=.*$", "set default=1", text, flags=re.MULTILINE)
else:
    text = "set default=1\n" + text

if "Install My Own Suite (ERASES DISK)" not in text:
    menu_pattern = re.compile(
        r'menuentry "(?P<title>Try or Install Ubuntu Server)" \{\n(?P<body>.*?)\n\}',
        re.DOTALL,
    )
    match = menu_pattern.search(text)
    if match:
        body = match.group("body")
        install_body = body
        install_body = install_body.replace(
            'linux\t/casper/vmlinuz  ---',
            'linux\t/casper/vmlinuz autoinstall ds=nocloud\\;s=/cdrom/autoinstall/  ---',
        )
        install_body = install_body.replace(
            'linux\t/casper/vmlinuz iso-scan/filename=${iso_path} ---',
            'linux\t/casper/vmlinuz iso-scan/filename=${iso_path} autoinstall ds=nocloud\\;s=/cdrom/autoinstall/ ---',
        )

        if install_body != body:
            extra_entry = (
                '\nmenuentry "Install My Own Suite (ERASES DISK)" {\n'
                f'{install_body}\n'
                '}\n'
            )
            insert_at = match.end()
            text = text[:insert_at] + extra_entry + text[insert_at:]

path.write_text(text, encoding="utf-8")
PY

  return 0
}

declare -a xorriso_args
xorriso_args=(
  -map "${AUTOINSTALL_ROOT}/user-data" /autoinstall/user-data
  -map "${AUTOINSTALL_ROOT}/meta-data" /autoinstall/meta-data
)

if [[ -f "${AUTOINSTALL_ROOT}/selfhost-installer.env" ]]; then
  xorriso_args+=(-map "${AUTOINSTALL_ROOT}/selfhost-installer.env" /autoinstall/selfhost-installer.env)
fi

for iso_path in /boot/grub/grub.cfg /boot/grub/loopback.cfg /EFI/boot/grub.cfg; do
  file_name="$(echo "${iso_path}" | sed 's#^/##' | tr '/' '_')"
  if patch_grub_file "${iso_path}" "${file_name}"; then
    disk_path="${PATCH_ROOT}/${file_name}"
    xorriso_args+=(-map "${disk_path}" "${iso_path}")
  fi
done

mkdir -p "$(dirname "${OUTPUT_ISO}")"
rm -f "${OUTPUT_ISO}"

xorriso \
  -indev "${INPUT_ISO}" \
  -outdev "${OUTPUT_ISO}" \
  "${xorriso_args[@]}" \
  -boot_image any replay \
  -commit \
  -end

echo "Created remastered installer ISO: ${OUTPUT_ISO}"
