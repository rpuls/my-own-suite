const assert = require('node:assert/strict');
const test = require('node:test');

const { GIB } = require('./layout.cjs');
const { STATES, TPM_MODES, TPM_SLOTS, VaultAgentCore } = require('./agent-core.cjs');

const SECTOR = 512;
const KEY = 'MOS-0000-1111-2222-3333-4444-5555-6666-7777';
// The key of the server this one is taking the place of.
const OTHER_KEY = 'MOS-9999-8888-7777-6666-5555-4444-3333-2222';
// The owner's Suite Manager password, which is also the chip's PIN on a machine
// with startup protection on. There is never a fourth secret.
const PASSWORD = 'correct horse battery staple';

// A machine as the image leaves it: ESP, a shrunk system partition, free space.
function disk({ diskGib = 256 } = {}) {
  const systemStart = 1050624;
  return {
    device: '/dev/sda',
    diskBytes: diskGib * GIB,
    partitions: [
      { endSector: systemStart - 1, number: 1, startSector: 2048 },
      { endSector: systemStart + Math.floor((8 * GIB) / SECTOR) - 1, number: 2, startSector: systemStart },
    ],
    sectorSize: SECTOR,
    systemPartition: {
      device: '/dev/sda2',
      endSector: systemStart + Math.floor((8 * GIB) / SECTOR) - 1,
      number: 2,
      startSector: systemStart,
    },
  };
}

function adapter(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    return typeof result === 'function' ? result(...args) : result;
  };
  const state = {
    acknowledged: overrides.acknowledged ?? false,
    descriptor: overrides.descriptor ?? null,
    mapperExists: false,
    mounted: overrides.mounted ?? false,
    pendingKey: overrides.pendingKey ?? null,
  };

  return {
    calls,
    state,
    bind: record('bind'),
    createVaultPartition: record('createVaultPartition', '/dev/sda3'),
    discardEscrow: record('discardEscrow', () => { state.pendingKey = null; }),
    escrowKey: record('escrowKey', (key) => { state.pendingKey = key; }),
    hasEscrow: record('hasEscrow', () => state.pendingKey !== null),
    keyAcknowledged: record('keyAcknowledged', () => state.acknowledged),
    markInstallerMedia: record('markInstallerMedia'),
    readEscrow: record('readEscrow', () => state.pendingKey),
    enableSwapfile: record('enableSwapfile'),
    ensureDirectory: record('ensureDirectory'),
    enrollTpm: record('enrollTpm', overrides.enrollTpm ?? { enrolled: true, pcrs: [7] }),
    fitTableToDisk: record('fitTableToDisk'),
    generateRecoveryKey: record('generateRecoveryKey', { key: KEY }),
    growFilesystem: record('growFilesystem'),
    inspectDisk: record('inspectDisk', overrides.disk ?? disk()),
    isMounted: record('isMounted', () => state.mounted),
    isRemovableRoot: record('isRemovableRoot', overrides.removableRoot ?? false),
    isVaultArmed: record('isVaultArmed', overrides.armed ?? true),
    luksFormat: record('luksFormat'),
    luksOpen: record('luksOpen', ({ key }) => {
      const ok = key === (overrides.storedKey ?? KEY);
      if (ok) { state.mapperExists = true; state.mounted = false; }
      return { ok };
    }),
    luksOpenWithTpm: record('luksOpenWithTpm', ({ pin = null }) => {
      // Asked without a PIN the chip either answers or does not; asked with one
      // it answers to the right password and to nothing else.
      if (pin === null) {
        const ok = overrides.tpmUnlocks ?? true;
        if (ok) state.mapperExists = true;
        return { ok };
      }
      if (overrides.chipLockedOut) return { lockoutSeconds: 600, ok: false, reason: 'tpm-locked-out' };
      const ok = pin === (overrides.chipPin ?? PASSWORD);
      if (ok) state.mapperExists = true;
      return ok ? { ok } : { ok, reason: 'wrong-password' };
    }),
    makeFilesystem: record('makeFilesystem'),
    mapperExists: record('mapperExists', () => state.mapperExists),
    mount: record('mount', () => { state.mounted = true; }),
    moveIntoVault: record('moveIntoVault'),
    now: () => '2026-09-17T10:00:00Z',
    publishRecoveryKey: record('publishRecoveryKey'),
    readDescriptor: record('readDescriptor', () => state.descriptor),
    readOwnKey: record('readOwnKey', overrides.ownKey === undefined ? KEY : overrides.ownKey),
    rekey: record('rekey', overrides.rekey ?? { ok: true }),
    resizePartition: record('resizePartition'),
    wipeTpmEnrollment: record('wipeTpmEnrollment', overrides.wipeTpmEnrollment ?? { wiped: true }),
    writeDescriptor: record('writeDescriptor', (_path, descriptor) => { state.descriptor = descriptor; }),
  };
}

const named = (calls, name) => calls.filter((call) => call[0] === name);

test('first boot claims the disk, encrypts the vault and moves owner data into it', async () => {
  const fake = adapter();
  const result = await new VaultAgentCore(fake).open();

  assert.deepEqual(result, { created: true, opened: true, vault: true });
  // The image's table ends where the build's disk did; read before it is fitted,
  // a 40 GB disk plans as "already full". The release verify boots exactly that.
  const order = fake.calls.map((call) => call[0]);
  assert.ok(order.indexOf('fitTableToDisk') < order.indexOf('inspectDisk'), 'the table is fitted to this disk before the layout reads it');
  assert.equal(named(fake.calls, 'resizePartition').length, 1, 'the system partition grows to its cap');
  assert.equal(named(fake.calls, 'luksFormat').length, 1);
  assert.equal(named(fake.calls, 'luksFormat')[0][1].key, KEY, 'the vault is formatted with the recovery key');

  const moved = named(fake.calls, 'moveIntoVault').map((call) => call[1].source);
  assert.deepEqual(moved, ['/var/lib/docker', '/var/lib/mos', '/etc/mos/secrets']);

  const bound = named(fake.calls, 'bind').map((call) => call[1]);
  assert.deepEqual(bound, [
    { source: '/var/lib/mos-vault/docker', target: '/var/lib/docker' },
    { source: '/var/lib/mos-vault/mos', target: '/var/lib/mos' },
    { source: '/var/lib/mos-vault/secrets', target: '/etc/mos/secrets' },
  ]);
  assert.equal(fake.state.descriptor.tpm.pcrs[0], 7);
});

// The bake runs this same code inside a VM and snapshots the disk afterwards,
// so a vault created there would be dd'd onto every machine that downloads the
// image, all of them sharing one key.
test('a machine that has not been armed creates nothing and records nothing', async () => {
  const fake = adapter({ armed: false });
  const result = await new VaultAgentCore(fake).open();

  assert.deepEqual(result, { opened: true, reason: 'not-armed', vault: false });
  assert.equal(named(fake.calls, 'luksFormat').length, 0);
  assert.equal(named(fake.calls, 'fitTableToDisk').length, 0, 'the bake disk\'s table is not touched');
  assert.equal(named(fake.calls, 'inspectDisk').length, 0);
  assert.equal(named(fake.calls, 'writeDescriptor').length, 0, 'no descriptor travels in the image');
  assert.equal(fake.state.descriptor, null);
});

// --- The handover ------------------------------------------------------------
//
// The key is first shown after sign-in, and sign-in needs an open vault. So
// until the owner has confirmed they hold the key, a copy stays on the plaintext
// partition and opens the vault whatever the chip does: the first lab install
// had a chip that refused on the second boot, and the owner was looking at a
// page asking for a key nobody had ever shown them.

test('first boot escrows the recovery key beside the descriptor until the owner has it', async () => {
  const fake = adapter();
  await new VaultAgentCore(fake).open();

  assert.equal(fake.state.pendingKey, KEY);
  assert.equal((await new VaultAgentCore(fake).status()).handover, 'pending');
});

test('before the handover, a chip that refuses does not lock the owner out', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { mode: TPM_MODES.AUTOMATIC, pcrs: [7], slot: TPM_SLOTS.ENROLLED }, version: 1 },
    pendingKey: KEY,
    tpmUnlocks: false,
  });
  const result = await new VaultAgentCore(fake).open();

  // The escrow is the key, and the key authorises teaching the chip again, so
  // the refusal heals inside the window instead of surfacing on the first
  // restart after the owner has confirmed their key and the escrow is gone.
  assert.deepEqual(result, { opened: true, resealed: true, unlockedBy: 'escrow', vault: true });
  assert.equal(named(fake.calls, 'enrollTpm')[0][1].key, KEY, 'the escrowed key authorises the re-seal');
  assert.equal(fake.state.descriptor.tpm.slot, TPM_SLOTS.ENROLLED);
});

test('before the handover, a chip that refused at creation is taught the key on the next boot', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { enrolledAt: null, mode: TPM_MODES.AUTOMATIC, pcrs: null, slot: TPM_SLOTS.NEEDS_REPAIR }, version: 1 },
    pendingKey: KEY,
  });
  const result = await new VaultAgentCore(fake).open();

  assert.equal(result.resealed, true);
  assert.equal(named(fake.calls, 'luksOpenWithTpm').length, 0, 'a slot needing repair is never tried');
  assert.deepEqual(fake.state.descriptor.tpm, { enrolledAt: '2026-09-17T10:00:00Z', mode: TPM_MODES.AUTOMATIC, pcrs: [7], slot: TPM_SLOTS.ENROLLED });
});

test('before the handover, a machine with no chip opens too', async () => {
  const fake = adapter({ descriptor: { device: '/dev/sda3', tpm: null, version: 1 }, pendingKey: KEY });
  const result = await new VaultAgentCore(fake).open();
  assert.equal(result.unlockedBy, 'escrow');
  assert.equal(result.resealed, false, 'no chip, nothing to teach');
  assert.equal(named(fake.calls, 'enrollTpm').length, 0);
});

// The acknowledgement is the backup agent's record, which Suite Manager writes.
// The copy goes the moment it is seen, and only then: an owner who clicked
// "Not yet" still has a machine that opens.
test('the escrowed key is discarded once the owner has acknowledged theirs, and not before', async () => {
  const fake = adapter({ descriptor: { device: '/dev/sda3', tpm: null, version: 1 }, mounted: true, pendingKey: KEY });
  const core = new VaultAgentCore(fake);

  assert.deepEqual(await core.settleHandover(), { discarded: false });
  assert.equal(fake.state.pendingKey, KEY);

  fake.state.acknowledged = true;
  assert.deepEqual(await core.settleHandover(), { discarded: true });
  assert.equal(fake.state.pendingKey, null);
  assert.equal((await core.status()).handover, 'done');
  assert.deepEqual(await core.settleHandover(), { discarded: false }, 'nothing left to discard');
});

test('after the handover, a chip that refuses asks for the key the owner now has', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { mode: TPM_MODES.AUTOMATIC, pcrs: [7], slot: TPM_SLOTS.ENROLLED }, version: 1 },
    tpmUnlocks: false,
  });
  const result = await new VaultAgentCore(fake).open();

  assert.equal(result.opened, false);
  assert.equal(result.reason, 'tpm-refused');
  assert.equal(named(fake.calls, 'luksOpen').length, 0, 'no escrowed key, nothing tried');
});

// A chip that refused at first boot is a chip to try again after the first key
// entry, not a machine to believe chipless for good. A machine with no chip at
// all records none, so nothing ever tries one.
test('a chip that refuses at creation is recorded as needing repair, not as absent', async () => {
  const enrollTpm = { detail: ['systemd-cryptenroll exited with code 1.', 'Last output:\n  TPM2 support is not installed.'], enrolled: false, reason: 'tpm-refused' };
  const refused = adapter({ enrollTpm });
  const result = await new VaultAgentCore(refused).open();
  assert.deepEqual(refused.state.descriptor.tpm, { enrolledAt: null, mode: TPM_MODES.AUTOMATIC, pcrs: null, slot: TPM_SLOTS.NEEDS_REPAIR });
  assert.deepEqual(result.chip, enrollTpm, 'the gate is told why, so the first-boot journal says it');

  const chipless = adapter({ enrollTpm: { enrolled: false, reason: 'no-tpm' } });
  const chiplessResult = await new VaultAgentCore(chipless).open();
  assert.equal(chipless.state.descriptor.tpm, null);
  assert.equal(chiplessResult.chip.reason, 'no-tpm');
});

test('the swapfile is created inside the vault and nowhere else', async () => {
  const fake = adapter();
  await new VaultAgentCore(fake).open();
  const swap = named(fake.calls, 'enableSwapfile');
  assert.equal(swap.length, 1);
  assert.equal(swap[0][1].path, '/var/lib/mos-vault/swap.img');
});

test('the recovery key is published once, at creation, for Suite Manager to show', async () => {
  const fake = adapter();
  await new VaultAgentCore(fake).open();
  assert.deepEqual(named(fake.calls, 'publishRecoveryKey')[0][1], { key: KEY });
});

// mos-self-install copies the stick onto the internal disk with `dd`, so
// anything written here is what the installed machine reads first.
test('a machine booted from the installer stick is never partitioned and records nothing', async () => {
  const fake = adapter({ removableRoot: true });
  const result = await new VaultAgentCore(fake).open();

  assert.deepEqual(result, { opened: true, reason: 'running-from-installer-media', vault: false });
  assert.equal(named(fake.calls, 'fitTableToDisk').length, 0, 'the stick\'s table is not touched');
  assert.equal(named(fake.calls, 'inspectDisk').length, 0, 'the disk is not even inspected');
  assert.equal(named(fake.calls, 'resizePartition').length, 0);
  assert.equal(named(fake.calls, 'writeDescriptor').length, 0, 'no descriptor is dd-ed onto the target');
  assert.equal(fake.state.descriptor, null);
});

test('a disk too small for a vault grows the system and says why, and the suite still starts', async () => {
  const fake = adapter({ disk: disk({ diskGib: 16 }) });
  const result = await new VaultAgentCore(fake).open();

  assert.equal(result.opened, true);
  assert.equal(result.vault, false);
  assert.equal(result.reason, 'disk-too-small-for-vault');
  assert.equal(named(fake.calls, 'resizePartition').length, 1, 'the old grow-to-fill still happens');
  assert.equal(named(fake.calls, 'luksFormat').length, 0);
  assert.equal(named(fake.calls, 'enableSwapfile')[0][1].path, '/swap.img', 'a machine with no vault still gets swap');

  const status = await new VaultAgentCore(fake).status();
  assert.equal(status.state, STATES.UNSUPPORTED);
  assert.match(status.sentence, /too small/u);
});

test('a machine with a TPM opens itself with no key and no owner', async () => {
  const fake = adapter({ descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 } });
  const result = await new VaultAgentCore(fake).open();

  assert.deepEqual(result, { opened: true, unlockedBy: 'tpm', vault: true });
  assert.equal(named(fake.calls, 'luksOpen').length, 0, 'no passphrase is involved');
  assert.equal(named(fake.calls, 'mount').length, 1);
});

test('a TPM that refuses leaves the machine locked, with the reason it refused', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 },
    tpmUnlocks: false,
  });
  const result = await new VaultAgentCore(fake).open();

  assert.equal(result.opened, false);
  assert.equal(result.reason, 'tpm-refused');
  assert.match(result.sentence, /firmware change/u);
  assert.equal(named(fake.calls, 'mount').length, 0, 'nothing is mounted while locked');
});

test('the owner key opens a vault the TPM refused', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 },
    tpmUnlocks: false,
  });
  const result = await new VaultAgentCore(fake).open({ key: KEY });

  assert.deepEqual(result, { opened: true, unlockedBy: 'key', vault: true });
  assert.equal(named(fake.calls, 'mount').length, 1);
});

test('a machine with no TPM waits for its owner and says so in those words', async () => {
  const fake = adapter({ descriptor: { device: '/dev/sda3', tpm: null, version: 1 } });
  const result = await new VaultAgentCore(fake).open();

  assert.equal(result.opened, false);
  assert.equal(result.reason, 'no-tpm');
  assert.match(result.sentence, /after every restart/u);
  assert.equal(named(fake.calls, 'luksOpenWithTpm').length, 0, 'a machine with no TPM does not try one');
});

test('a key that is valid but from another machine is named as exactly that', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: null, version: 1 },
    storedKey: 'MOS-9999-9999-9999-9999-9999-9999-9999-9999',
  });
  const result = await new VaultAgentCore(fake).open({ key: KEY });

  assert.equal(result.opened, false);
  assert.equal(result.reason, 'wrong-key');
  assert.match(result.sentence, /not the one this machine/u);
});

test('an already mounted vault is left alone', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 },
    mounted: true,
  });
  const result = await new VaultAgentCore(fake).open();

  assert.deepEqual(result, { opened: true, vault: true });
  assert.equal(named(fake.calls, 'mount').length, 0);
  assert.equal(named(fake.calls, 'luksOpenWithTpm').length, 0);
});

test('status reports what is protected, and whether the machine can open itself', async () => {
  const fake = adapter({
    descriptor: { createdAt: '2026-09-17T09:00:00Z', device: '/dev/sda3', tpm: { enrolledAt: '2026-09-17T09:00:00Z', pcrs: [7] }, version: 1 },
    mounted: true,
  });
  const status = await new VaultAgentCore(fake).status();

  assert.equal(status.state, STATES.UNLOCKED);
  assert.equal(status.unlocksItself, true);
  assert.deepEqual(status.protects, ['/var/lib/docker', '/var/lib/mos', '/etc/mos/secrets']);
});

test('status on a machine that has never been laid out is absent, not locked', async () => {
  const status = await new VaultAgentCore(adapter()).status();
  assert.equal(status.state, STATES.ABSENT);
});

// The page decides from the reason, not the sentence: waiting for a password is
// the normal state of a password-mode machine and is not repeated as a notice,
// and a slot waiting for repair takes no password, so the form must not offer
// one however the mode is set.
test('a locked status names why, so the page can choose its form', async () => {
  const waiting = await new VaultAgentCore(adapter(sealed())).status();
  assert.equal(waiting.state, STATES.LOCKED);
  assert.equal(waiting.reason, 'needs-password');

  const repairing = await new VaultAgentCore(adapter(sealed({
    descriptor: { device: '/dev/sda3', tpm: { enrolledAt: null, mode: TPM_MODES.PASSWORD, pcrs: [7], slot: TPM_SLOTS.NEEDS_REPAIR }, version: 1 },
  }))).status();
  assert.equal(repairing.reason, 'chip-needs-repair');

  const open = await new VaultAgentCore(adapter(sealed({ mounted: true }))).status();
  assert.equal(open.reason, null);
  assert.equal(open.sentence, null);
});


// --- Adopting a key, disk included ------------------------------------------
//
// A machine that takes another's place adopts that machine's recovery key. Once
// that key also opens a disk, adopting it for the backups alone would leave an
// owner holding a card that opens their archive and not their server, and they
// would find that out at the one moment they need it. The archive is never
// given a second key instead: a bucket that has been restored from five times
// would then be openable by five keys for good.

test('a takeover points the vault at the adopted key and leaves the data alone', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 },
    mounted: true,
  });
  const result = await new VaultAgentCore(fake).rekey({ nextKey: OTHER_KEY });

  assert.deepEqual(result, { ok: true, vault: true });
  const rekeys = named(fake.calls, 'rekey');
  assert.equal(rekeys.length, 1);
  assert.deepEqual(rekeys[0][1], { device: '/dev/sda3', fromKey: KEY, toKey: OTHER_KEY });
});

test('a machine with no vault reports nothing to do rather than a failure', async () => {
  const fake = adapter();
  assert.deepEqual(await new VaultAgentCore(fake).rekey({ nextKey: OTHER_KEY }), { ok: true, vault: false });
  assert.equal(named(fake.calls, 'rekey').length, 0);
});

test('a disk MOS refused to encrypt reports nothing to do too', async () => {
  const fake = adapter({ descriptor: { reason: 'disk-already-full', state: STATES.UNSUPPORTED, version: 1 } });
  assert.deepEqual(await new VaultAgentCore(fake).rekey({ nextKey: OTHER_KEY }), { ok: true, vault: false });
});

test('a locked vault is not rekeyed', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 },
    mounted: false,
  });
  assert.deepEqual(await new VaultAgentCore(fake).rekey({ nextKey: OTHER_KEY }), { ok: false, reason: 'locked' });
  assert.equal(named(fake.calls, 'rekey').length, 0);
});

// A restore resumed after an interrupted one must not report a failure for work
// that already happened.
test('a vault already using the adopted key is left alone and reported as fine', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 },
    mounted: true,
  });
  const result = await new VaultAgentCore(fake).rekey({ nextKey: KEY });

  assert.deepEqual(result, { ok: true, unchanged: true, vault: true });
  assert.equal(named(fake.calls, 'rekey').length, 0);
});

test('a vault whose own key cannot be read is not rekeyed', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 },
    mounted: true,
    ownKey: null,
  });
  assert.deepEqual(await new VaultAgentCore(fake).rekey({ nextKey: OTHER_KEY }), { ok: false, reason: 'own-key-unreadable' });
});

test('a rekey the disk refused is reported with its reason, never as success', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: { pcrs: [7] }, version: 1 },
    mounted: true,
    rekey: { ok: false, reason: 'current-key-rejected' },
  });
  assert.deepEqual(await new VaultAgentCore(fake).rekey({ nextKey: OTHER_KEY }), { ok: false, reason: 'current-key-rejected' });
});

test('no key is no rekey', async () => {
  const fake = adapter();
  assert.deepEqual(await new VaultAgentCore(fake).rekey({ nextKey: '' }), { ok: false, reason: 'no-key' });
  assert.equal(named(fake.calls, 'readDescriptor').length, 0);
});


// --- Startup protection -----------------------------------------------------
//
// The system partition is plaintext and nothing measures it, so a chip that
// opens the vault on its own opens it for whoever holds the machine: they mount
// that partition on a laptop, edit it, and boot it back with every measurement
// unchanged. The only thing on this layout that a stolen machine does not have
// is the owner's password, so the chip can be made to require it. It is off by
// default because it costs an absent owner their apps.

const sealed = (overrides = {}) => ({
  descriptor: {
    device: '/dev/sda3',
   
    tpm: { enrolledAt: '2026-09-17T09:00:00Z', mode: TPM_MODES.PASSWORD, pcrs: [7], slot: TPM_SLOTS.ENROLLED },
    version: 1,
  },
  ...overrides,
});

test('a machine that asks for a password does not try its chip at boot', async () => {
  const fake = adapter(sealed());
  const result = await new VaultAgentCore(fake).open();

  assert.equal(result.opened, false);
  assert.equal(result.reason, 'needs-password');
  assert.match(result.sentence, /password you sign in to Suite Manager with/u);
  // Nothing to gain and a minute of TPM timeouts to lose: mos-vault.service
  // holds no password, so the chip would only refuse slowly.
  assert.equal(named(fake.calls, 'luksOpenWithTpm').length, 0);
});

test('the owner password opens a machine that asks for one', async () => {
  const fake = adapter(sealed());
  const result = await new VaultAgentCore(fake).open({ pin: PASSWORD });

  assert.deepEqual(result, { opened: true, unlockedBy: 'password', vault: true });
  assert.equal(named(fake.calls, 'luksOpen').length, 0, 'the recovery key is not involved');
  assert.equal(named(fake.calls, 'mount').length, 1);
});

test('a wrong password says so, and says the recovery key still works', async () => {
  const fake = adapter(sealed());
  const result = await new VaultAgentCore(fake).open({ pin: 'not the password' });

  assert.equal(result.opened, false);
  assert.equal(result.reason, 'wrong-password');
  assert.match(result.sentence, /recovery key does not go through the chip/u);
  assert.equal(named(fake.calls, 'mount').length, 0);
});

// The chip's own lockout is what makes an owner's password a strong disk key,
// and it is also what an owner hits by mistyping theirs. The two must not be
// told as the same thing, and the way out has to be named.
test('a chip that has locked itself is named as that, with how long it sulks for', async () => {
  const fake = adapter(sealed({ chipLockedOut: true }));
  const result = await new VaultAgentCore(fake).open({ pin: PASSWORD });

  assert.equal(result.reason, 'tpm-locked-out');
  assert.match(result.sentence, /stopped answering for a while/u);
  assert.match(result.sentence, /about 10 minutes/u);
  assert.match(result.sentence, /works right now/u);
});

test('the recovery key opens a machine that asks for a password', async () => {
  const fake = adapter(sealed());
  const result = await new VaultAgentCore(fake).open({ key: KEY });

  assert.deepEqual(result, { opened: true, unlockedBy: 'key', vault: true });
});

// The chip needs the owner's password to be taught anything, and the page that
// took the recovery key never had it. Marking the slot is what makes the next
// sign-in finish the job, and what stops the next restart from offering a
// password the chip may no longer know.
test('after a recovery-key unlock, a password-mode chip is marked for repair', async () => {
  const fake = adapter(sealed());
  const core = new VaultAgentCore(fake);
  await core.open({ key: KEY });
  const result = await core.reseal({ key: KEY });

  assert.deepEqual(result, { repairPending: true, resealed: false });
  assert.equal(fake.state.descriptor.tpm.slot, TPM_SLOTS.NEEDS_REPAIR);
  assert.equal(fake.state.descriptor.tpm.mode, TPM_MODES.PASSWORD);
  assert.equal(named(fake.calls, 'enrollTpm').length, 0, 'nothing is enrolled without the password');
});

// Re-sealing is authorised by the key that was just typed, not by the boot
// state: someone who has that key already has everything. It is what makes one
// key entry the whole cost of a firmware update rather than the start of a
// habit.
test('after a recovery-key unlock, an automatic machine re-seals itself on the spot', async () => {
  const fake = adapter({
    descriptor: {
      device: '/dev/sda3',
     
      tpm: { enrolledAt: '2026-09-17T09:00:00Z', mode: TPM_MODES.AUTOMATIC, pcrs: [7], slot: TPM_SLOTS.ENROLLED },
      version: 1,
    },
    tpmUnlocks: false,
  });
  const core = new VaultAgentCore(fake);
  await core.open({ key: KEY });
  const result = await core.reseal({ key: KEY });

  assert.equal(result.resealed, true);
  const enrolled = named(fake.calls, 'enrollTpm');
  assert.equal(enrolled.length, 1);
  assert.deepEqual(enrolled[0][1], { device: '/dev/sda3', key: KEY, pin: null });
  assert.equal(fake.state.descriptor.tpm.slot, TPM_SLOTS.ENROLLED);
});

test('a machine with no chip has nothing to re-seal', async () => {
  const fake = adapter({ descriptor: { device: '/dev/sda3', tpm: null, version: 1 }, mounted: true });
  assert.deepEqual(await new VaultAgentCore(fake).reseal({ key: KEY }), { reason: 'no-chip', resealed: false });
});

test('turning startup protection on teaches the chip the password and records the mode', async () => {
  const fake = adapter({
    descriptor: {
      device: '/dev/sda3',
     
      tpm: { enrolledAt: '2026-09-17T09:00:00Z', mode: TPM_MODES.AUTOMATIC, pcrs: [7], slot: TPM_SLOTS.ENROLLED },
      version: 1,
    },
    mounted: true,
  });
  const result = await new VaultAgentCore(fake).enrollChip({ mode: TPM_MODES.PASSWORD, pin: PASSWORD });

  assert.deepEqual(result, { mode: TPM_MODES.PASSWORD, ok: true, slot: TPM_SLOTS.ENROLLED, vault: true });
  // Authorised by this machine's own recovery key, read from the vault it is
  // already inside: the owner is never asked for a secret they do not have.
  assert.deepEqual(named(fake.calls, 'enrollTpm')[0][1], { device: '/dev/sda3', key: KEY, pin: PASSWORD });
  assert.equal(fake.state.descriptor.tpm.mode, TPM_MODES.PASSWORD);
  assert.equal(named(fake.calls, 'rekey').length, 0, 'the recovery-key keyslot is never touched');
});

test('turning it off puts the chip back to opening the disk by itself', async () => {
  const fake = adapter(sealed({ mounted: true }));
  const result = await new VaultAgentCore(fake).enrollChip({ mode: TPM_MODES.AUTOMATIC });

  assert.equal(result.ok, true);
  assert.equal(named(fake.calls, 'enrollTpm')[0][1].pin, null);
  assert.equal(fake.state.descriptor.tpm.mode, TPM_MODES.AUTOMATIC);
});

// The one state this must not leave behind is a chip that still knows the
// password its owner has just replaced. With no chip slot the machine asks for
// the recovery key, which is always the safe way to fail.
test('an enrollment the chip refused wipes the slot and says the chip needs repair', async () => {
  const fake = adapter(sealed({ enrollTpm: { enrolled: false, reason: 'tpm-refused' }, mounted: true }));
  const result = await new VaultAgentCore(fake).enrollChip({ mode: TPM_MODES.PASSWORD, pin: 'a new password' });

  assert.deepEqual(result, {
    mode: TPM_MODES.PASSWORD,
    ok: false,
    reason: 'tpm-refused',
    slot: TPM_SLOTS.NEEDS_REPAIR,
    vault: true,
  });
  assert.equal(named(fake.calls, 'wipeTpmEnrollment').length, 1);
  assert.equal(fake.state.descriptor.tpm.slot, TPM_SLOTS.NEEDS_REPAIR);
});

test('a chip waiting for repair is not tried, and the page says why', async () => {
  const fake = adapter({
    descriptor: {
      device: '/dev/sda3',
     
      tpm: { enrolledAt: null, mode: TPM_MODES.PASSWORD, pcrs: [7], slot: TPM_SLOTS.NEEDS_REPAIR },
      version: 1,
    },
  });
  const result = await new VaultAgentCore(fake).open({ pin: PASSWORD });

  assert.equal(result.opened, false);
  assert.equal(result.reason, 'chip-needs-repair');
  assert.match(result.sentence, /sign in to Suite Manager/u);
  // A slot left over from a failed change would be tried with a password it
  // does not know, and wrong tries are what feed the chip's lockout.
  assert.equal(named(fake.calls, 'luksOpenWithTpm').length, 0);
});

test('a password change on a machine that opens itself has no chip work to do', async () => {
  const fake = adapter({
    descriptor: {
      device: '/dev/sda3',
     
      tpm: { enrolledAt: '2026-09-17T09:00:00Z', mode: TPM_MODES.AUTOMATIC, pcrs: [7], slot: TPM_SLOTS.ENROLLED },
      version: 1,
    },
    mounted: true,
  });
  const result = await new VaultAgentCore(fake).enrollChip({ mode: 'current', pin: PASSWORD });

  assert.equal(result.unchanged, true);
  assert.equal(named(fake.calls, 'enrollTpm').length, 0);
});

test('a password change on a machine that asks for one re-enrolls it, without changing the mode', async () => {
  const fake = adapter(sealed({ mounted: true }));
  const result = await new VaultAgentCore(fake).enrollChip({ mode: 'current', pin: 'a new password' });

  assert.equal(result.ok, true);
  assert.equal(result.mode, TPM_MODES.PASSWORD);
  assert.equal(named(fake.calls, 'enrollTpm')[0][1].pin, 'a new password');
});

test('password mode without a password is refused rather than enrolled blind', async () => {
  const fake = adapter(sealed({ mounted: true }));
  assert.deepEqual(
    await new VaultAgentCore(fake).enrollChip({ mode: TPM_MODES.PASSWORD }),
    { ok: false, reason: 'no-password' },
  );
  assert.equal(named(fake.calls, 'enrollTpm').length, 0);
});

test('a locked vault is not enrolled', async () => {
  const fake = adapter(sealed({ mounted: false }));
  assert.deepEqual(await new VaultAgentCore(fake).enrollChip({ mode: TPM_MODES.AUTOMATIC }), { ok: false, reason: 'locked' });
});

test('a machine with no vault reports nothing to enroll rather than a failure', async () => {
  const fake = adapter();
  assert.deepEqual(await new VaultAgentCore(fake).enrollChip({ mode: TPM_MODES.AUTOMATIC }), { ok: true, vault: false });
});

// The standing statement in settings is written from this, so it must not say
// "this machine opens itself" about a machine that waits for a password or one
// whose chip is waiting to be taught.
test('status says a machine only opens itself when it really does', async () => {
  const asking = adapter(sealed({ mounted: true }));
  const asked = await new VaultAgentCore(asking).status();
  assert.equal(asked.unlocksItself, false);
  assert.equal(asked.tpm.mode, TPM_MODES.PASSWORD);
  assert.equal(asked.tpm.slot, TPM_SLOTS.ENROLLED);

  const broken = adapter({
    descriptor: {
      device: '/dev/sda3',
     
      tpm: { enrolledAt: null, mode: TPM_MODES.AUTOMATIC, pcrs: [7], slot: TPM_SLOTS.NEEDS_REPAIR },
      version: 1,
    },
    mounted: true,
  });
  assert.equal((await new VaultAgentCore(broken).status()).unlocksItself, false);
});

// A machine with no chip is not a machine with a broken one. A password change
// there used to come back as "the chip refused", which is a sentence about
// hardware this machine does not have.
test('a password change on a machine with no chip reports nothing to do', async () => {
  const fake = adapter({
    descriptor: { device: '/dev/sda3', tpm: null, version: 1 },
    mounted: true,
  });
  const result = await new VaultAgentCore(fake).enrollChip({ mode: 'current', pin: PASSWORD });

  assert.deepEqual(result, { mode: null, ok: true, slot: TPM_SLOTS.ENROLLED, unchanged: true, vault: true });
  assert.equal(named(fake.calls, 'enrollTpm').length, 0);
});

// A chip left needing repair is taught again by the next thing that holds the
// owner's password, whichever mode the machine is in.
test('a chip waiting for repair is repaired by a password change', async () => {
  const fake = adapter({
    descriptor: {
      device: '/dev/sda3',
     
      tpm: { enrolledAt: null, mode: TPM_MODES.PASSWORD, pcrs: [7], slot: TPM_SLOTS.NEEDS_REPAIR },
      version: 1,
    },
    mounted: true,
  });
  const result = await new VaultAgentCore(fake).enrollChip({ mode: 'current', pin: 'a new password' });

  assert.equal(result.ok, true);
  assert.equal(result.slot, TPM_SLOTS.ENROLLED);
  assert.equal(fake.state.descriptor.tpm.slot, TPM_SLOTS.ENROLLED);
});
