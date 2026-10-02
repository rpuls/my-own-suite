const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { expectedBuildSeconds, median, readBuildTimings, recordBuildTiming } = require('./app-build-timings.cjs');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-build-timings-')), 'nested', 'app-build-timings.json');
}

test('a build time is recorded per package with its display name, and read back as a median', () => {
  const file = tempFile();
  recordBuildTiming(file, { at: '2026-09-10T10:00:00.000Z', cpus: 2, displayName: 'ONLYOFFICE', packageId: 'onlyoffice', seconds: 361.4 });
  recordBuildTiming(file, { at: '2026-09-11T10:00:00.000Z', cpus: 2, displayName: 'ONLYOFFICE', packageId: 'onlyoffice', seconds: 340 });
  recordBuildTiming(file, { at: '2026-09-12T10:00:00.000Z', cpus: 2, packageId: 'radicale', seconds: 12 });

  const timings = readBuildTimings(file);
  assert.equal(timings.onlyoffice.displayName, 'ONLYOFFICE');
  assert.deepEqual(timings.onlyoffice.samples.map((sample) => sample.seconds), [361, 340]);
  assert.equal(timings.radicale.displayName, 'radicale');
  assert.equal(expectedBuildSeconds(timings, 'onlyoffice'), 351);
  assert.equal(expectedBuildSeconds(timings, 'radicale'), 12);
  // Never built here is null, not zero: zero would be a promise.
  assert.equal(expectedBuildSeconds(timings, 'immich'), null);
  assert.equal(expectedBuildSeconds({}, 'immich'), null);
});

test('only the last few samples are kept, so the number follows the machine and the package', () => {
  const file = tempFile();
  for (let index = 0; index < 8; index += 1) recordBuildTiming(file, { packageId: 'immich', seconds: 100 + index });
  const samples = readBuildTimings(file).immich.samples.map((sample) => sample.seconds);
  assert.deepEqual(samples, [103, 104, 105, 106, 107]);
});

test('a missing or damaged file reads as no history, and a bad sample is refused', () => {
  const file = tempFile();
  assert.deepEqual(readBuildTimings(file), {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readBuildTimings(file), {});
  assert.equal(recordBuildTiming(file, { packageId: 'immich', seconds: Number.NaN }), null);
  assert.equal(recordBuildTiming(file, { packageId: '', seconds: 10 }), null);
  // A damaged file is replaced by the first good record rather than kept.
  recordBuildTiming(file, { packageId: 'immich', seconds: 10 });
  assert.equal(expectedBuildSeconds(readBuildTimings(file), 'immich'), 10);
  assert.equal(fs.existsSync(`${file}.next`), false);
});

test('median ignores what is not a number and is the middle of what is', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([1, null, 'x', 3]), 2);
});
