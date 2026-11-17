const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const payload = path.resolve(__dirname, '..', '..', 'image-builder', 'payload');
const read = (relative) => fs.readFileSync(path.join(payload, relative), 'utf8');
const code = (script) => script.split('\n').filter((line) => !line.trimStart().startsWith('#'));

test('the installer exits only when the machine started from its own internal disk', () => {
  const lines = code(read('mos-self-install'));
  const exits = lines.filter((line) => /(^|[;&|{]\s*)exit\b/u.test(line.trim()));

  assert.deepEqual(exits.map((line) => line.trim()), ['exit 0']);
  const exitAt = lines.findIndex((line) => line.trim() === 'exit 0');
  assert.match(lines[exitAt - 1], /\$transport" != "usb" \] && \[ "\$removable" != "1" \]/u);
});

test('a machine running from a copy that still carries the stick\'s identifiers never runs MOS from it', () => {
  const lines = code(read('mos-self-install'));
  const guardAt = lines.findIndex((line) => /stick_copy_of_root\)"; then$/u.test(line));
  const exitAt = lines.findIndex((line) => line.trim() === 'exit 0');

  assert.ok(guardAt > 0 && guardAt < exitAt);
  assert.equal(lines[guardAt + 1].trim(), 'refuse_unfinished_copy "$stick"');
});

test('an install that stops after the copy began erases the copy before restarting', () => {
  const lines = code(read('mos-self-install'));
  const stopHere = lines.findIndex((line) => line.startsWith('stop_here() {'));
  const startedAt = lines.findIndex((line) => line.trim() === 'copy_started=yes');

  assert.equal(lines[stopHere + 1].trim(), 'erase_unfinished_copy');
  assert.match(lines[startedAt + 1], /^dd if=/u);
});

test('the installer closes whatever holds the target disk open before copying onto it', () => {
  const lines = code(read('mos-self-install'));
  const releaseAt = lines.findIndex((line) => line.startsWith('release_holders "$target"'));
  const copyAt = lines.findIndex((line) => line.startsWith('dd if='));

  assert.ok(releaseAt > 0 && releaseAt < copyAt);
});

test('every restart in the installer holds the machine if the restart itself fails', () => {
  const lines = code(read('mos-self-install'));
  const reboots = lines.filter((line) => /\breboot\b/u.test(line));

  assert.deepEqual(reboots.map((line) => line.trim()), ['reboot -f || true']);
  const rebootAt = lines.findIndex((line) => /\breboot\b/u.test(line));
  assert.equal(lines[rebootAt + 1].trim(), 'while :; do sleep 3600; done');
});

test('a killed installer restarts the machine instead of letting the boot carry on', () => {
  assert.match(read('units/mos-self-install.service'), /^FailureAction=reboot-force$/mu);
});

test('the image ships no shim fallback that could boot another disk instead of the stick', () => {
  const finalize = read('mos-image-finalize');

  assert.ok(finalize.includes('rm -f "$esp/EFI/BOOT/fbx64.efi"'));
  assert.ok(finalize.indexOf('rm -f "$esp/EFI/BOOT/fbx64.efi"') > finalize.lastIndexOf('grub-install'));
});
