const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { verifyIso } = require('../scripts/smoke/build-hyperv-usb-iso.cjs');

test('Hyper-V USB lab accepts only a substantial ISO-9660 image', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-iso-'));
  context.after(() => fs.rmSync(tempDir, { force: true, recursive: true }));

  const validIso = path.join(tempDir, 'valid.iso');
  const handle = fs.openSync(validIso, 'w');
  fs.ftruncateSync(handle, (100 * 1024 * 1024) + 1);
  fs.writeSync(handle, Buffer.from('CD001'), 0, 5, (16 * 2048) + 1);
  fs.closeSync(handle);

  assert.equal(verifyIso(validIso), (100 * 1024 * 1024) + 1);

  const invalidIso = path.join(tempDir, 'invalid.iso');
  fs.copyFileSync(validIso, invalidIso);
  const invalidHandle = fs.openSync(invalidIso, 'r+');
  fs.writeSync(invalidHandle, Buffer.from('NOPE!'), 0, 5, (16 * 2048) + 1);
  fs.closeSync(invalidHandle);

  assert.throws(() => verifyIso(invalidIso), /ISO-9660 volume descriptor/u);
});
