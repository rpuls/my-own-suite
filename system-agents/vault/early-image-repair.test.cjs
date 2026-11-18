'use strict';

// TEMPORARY: deleted with early-image-repair.cjs before alpha.

const assert = require('node:assert/strict');
const test = require('node:test');

const { EarlyImageRepair } = require('./early-image-repair.cjs');
const { VaultAgentCore } = require('./agent-core.cjs');

const IMAGE_KEY = 'MOS-IMAGE-KEY';
const DISK_KEY = 'MOS-DISK-KEY';
const NEW_KEY = 'MOS-NEW-KEY';

// Slot 0 is the install's key nobody holds, slot 1 the chip's.
function disk({ chipAnswers = true } = {}) {
  const slots = { 0: DISK_KEY, 1: 'chip' };
  const killed = [];
  return {
    killed,
    slots,
    adapter: {
      isMounted: async () => true,
      opensWith: async ({ key }) => Object.values(slots).includes(key),
      readDescriptor: async () => ({ device: '/dev/sda3', tpm: { pcrs: [7], slot: 'enrolled' }, version: 1 }),
      readOwnKey: async () => IMAGE_KEY,
      rekey: async () => ({ ok: false, reason: 'current-key-rejected' }),
    },
    commands: {
      addKeyThroughChip: async ({ key }) => {
        if (!chipAnswers) return false;
        slots[2] = key;
        return true;
      },
      keyslots: async () => ({ all: Object.keys(slots), chip: new Set(['1']) }),
      killSlot: async ({ slot }) => { killed.push(slot); delete slots[slot]; },
    },
  };
}

function core(fake) {
  return new VaultAgentCore(fake.adapter, { earlyImageRepair: new EarlyImageRepair(fake.adapter, fake.commands) });
}

test('a server whose kit does not open its disk says so', async () => {
  const fake = disk();
  assert.equal(await new EarlyImageRepair(fake.adapter, fake.commands).kitOpensDisk('/dev/sda3'), false);
});

test('a check that could not run warns nobody and is asked again', async () => {
  const fake = disk();
  const repair = new EarlyImageRepair(fake.adapter, fake.commands);
  fake.adapter.opensWith = async () => { throw new Error('cryptsetup ran out of memory'); };
  assert.equal(await repair.kitOpensDisk('/dev/sda3'), null);

  fake.adapter.opensWith = async () => true;
  assert.equal(await repair.kitOpensDisk('/dev/sda3'), true);
});

test('changing the key through the chip leaves only the new key and the chip', async () => {
  const fake = disk();
  const vault = core(fake);

  assert.deepEqual(await vault.rekey({ nextKey: NEW_KEY }), { ok: true, repaired: true, vault: true });
  assert.deepEqual(fake.killed, ['0']);
  assert.deepEqual(fake.slots, { 1: 'chip', 2: NEW_KEY });
  assert.equal(await vault.earlyImageRepair.kitOpensDisk('/dev/sda3'), true);
});

test('a chip that will not authorise the change leaves the disk as it was', async () => {
  const fake = disk({ chipAnswers: false });

  assert.deepEqual(await core(fake).rekey({ nextKey: NEW_KEY }), { ok: false, reason: 'current-key-rejected' });
  assert.deepEqual(fake.slots, { 0: DISK_KEY, 1: 'chip' });
});
