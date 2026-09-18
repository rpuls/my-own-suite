const assert = require('node:assert/strict');
const test = require('node:test');

const { GIB, VAULT_FLOOR_BYTES, planLayout, planSystemCapBytes } = require('./layout.cjs');

const SECTOR = 512;
const sectorsFor = (bytes) => Math.floor(bytes / SECTOR);

// The image as it lands: an ESP and a shrunk system partition, nothing else.
function freshImage({ diskGib, systemGib = 8 }) {
  const espStart = 2048;
  const espEnd = espStart + sectorsFor(512 * 1024 * 1024) - 1;
  const systemStart = espEnd + 1;
  return {
    diskBytes: diskGib * GIB,
    sectorSize: SECTOR,
    systemPartition: { endSector: systemStart + sectorsFor(systemGib * GIB) - 1, number: 2, startSector: systemStart },
    partitions: [
      { endSector: espEnd, number: 1, startSector: espStart },
      { endSector: systemStart + sectorsFor(systemGib * GIB) - 1, number: 2, startSector: systemStart },
    ],
  };
}

test('the system cap is a share of the disk between a floor and a ceiling', () => {
  assert.equal(planSystemCapBytes(32 * GIB), 12 * GIB);
  assert.equal(planSystemCapBytes(120 * GIB), 18 * GIB);
  assert.equal(planSystemCapBytes(256 * GIB), 24 * GIB);
  assert.equal(planSystemCapBytes(4096 * GIB), 24 * GIB);
});

test('a typical disk grows the system to its cap and gives the rest to the vault', () => {
  const plan = planLayout(freshImage({ diskGib: 256 }));
  assert.equal(plan.action, 'create-vault');

  const systemBytes = (plan.systemEndSector - freshImage({ diskGib: 256 }).systemPartition.startSector + 1) * SECTOR;
  assert.ok(Math.abs(systemBytes - 24 * GIB) < 2 * 1024 * 1024, `system partition is ~24 GiB, got ${systemBytes}`);
  assert.ok(plan.vault.bytes > 220 * GIB, 'the vault takes what is left');
  assert.equal(plan.vault.startSector % 2048, 0, 'the vault starts on a 1 MiB boundary');
  assert.ok(plan.vault.startSector > plan.systemEndSector, 'the vault starts after the system partition');
});

test('the vault ends before the secondary GPT', () => {
  const layout = freshImage({ diskGib: 64 });
  const plan = planLayout(layout);
  assert.ok(plan.vault.endSector <= Math.floor(layout.diskBytes / SECTOR) - 34);
});

test('a disk too small for a vault falls back to growing the system to fill it', () => {
  const plan = planLayout(freshImage({ diskGib: 16 }));
  assert.equal(plan.action, 'grow-system');
  assert.equal(plan.reason, 'disk-too-small-for-vault');
  assert.equal(plan.systemEndSector, sectorsFor(16 * GIB) - 34);
});

test('the smallest disk that still gets a vault gets one at least the floor size', () => {
  for (let diskGib = 16; diskGib <= 40; diskGib += 1) {
    const plan = planLayout(freshImage({ diskGib }));
    if (plan.action !== 'create-vault') continue;
    assert.ok(plan.vault.bytes >= VAULT_FLOOR_BYTES, `${diskGib} GiB disk produced a ${plan.vault.bytes} byte vault`);
  }
});

test('a partition MOS did not create is never touched', () => {
  const layout = freshImage({ diskGib: 256 });
  const systemEnd = layout.systemPartition.endSector;
  layout.partitions.push({ endSector: systemEnd + 1000000, number: 3, startSector: systemEnd + 2048 });
  assert.deepEqual(planLayout(layout), { action: 'none', reason: 'unrecognised-partitions-after-system' });
});

test('a machine that already has a vault is left alone', () => {
  const layout = { ...freshImage({ diskGib: 256 }), vaultPresent: true };
  assert.equal(planLayout(layout).action, 'none');
});

// The machine that installed under the previous grow-to-fill layout. It gets no
// vault and is not rearranged to have one: the route to an encrypted machine is
// a reinstall and a restore, not a partition table edited under a running suite.
test('a system partition already filling its disk is left exactly as it is', () => {
  const layout = freshImage({ diskGib: 256 });
  const lastUsable = Math.floor(layout.diskBytes / SECTOR) - 34;
  layout.systemPartition.endSector = lastUsable;
  layout.partitions[1].endSector = lastUsable;

  const plan = planLayout(layout);
  assert.equal(plan.action, 'none');
  assert.equal(plan.reason, 'disk-already-full');
});

// Between the two is the disk with a few gigabytes spare: too little for a
// vault, enough that the system partition should still claim it, which is what
// the layout this replaces did unconditionally.
test('a nearly full disk still grows the system into what is left', () => {
  const layout = freshImage({ diskGib: 256, systemGib: 250 });
  const plan = planLayout(layout);
  assert.equal(plan.action, 'grow-system');
  assert.equal(plan.reason, 'disk-too-small-for-vault');
});

test('a system partition larger than the cap keeps its sectors', () => {
  const layout = freshImage({ diskGib: 256, systemGib: 40 });
  const plan = planLayout(layout);
  assert.equal(plan.action, 'create-vault');
  assert.ok(plan.systemEndSector >= layout.systemPartition.endSector, 'the system partition does not move backwards');
});

test('a 4K-native disk is aligned and reserved in its own sectors', () => {
  const layout = freshImage({ diskGib: 256 });
  const plan = planLayout({ ...layout, sectorSize: 4096, diskBytes: 256 * GIB });
  assert.equal(plan.action, 'create-vault');
  assert.equal(plan.vault.startSector % 256, 0, '1 MiB is 256 sectors on a 4K disk');
  assert.ok(plan.vault.endSector <= Math.floor((256 * GIB) / 4096) - 34);
});

// The image is shrunk and its GPT rewritten at build time, then written to a
// disk of some other size. When the table reports a last usable sector, that is
// the authority — but never past the end of the disk actually underneath it.
test('a partition table that reports its own last usable sector is believed', () => {
  const layout = freshImage({ diskGib: 256 });
  const reserved = Math.floor(layout.diskBytes / SECTOR) - 5000;
  const plan = planLayout({ ...layout, lastUsableSector: reserved });
  assert.equal(plan.vault.endSector, reserved);
});

test('a last usable sector past the end of the disk is ignored', () => {
  const layout = freshImage({ diskGib: 256 });
  const plan = planLayout({ ...layout, lastUsableSector: Math.floor(layout.diskBytes / SECTOR) + 100000 });
  assert.ok(plan.vault.endSector <= Math.floor(layout.diskBytes / SECTOR) - 34);
});
