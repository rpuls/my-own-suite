'use strict';

// TEMPORARY. Delete before alpha, together with every line marked "early-image-repair".
//
// Servers installed from the 0.21–0.23 disk images were handed a recovery kit
// whose key never opened their disk (#345): only the chip does. This finds them
// and lets "Change recovery key" authorise through the chip instead.
// The key on such a kit is public, inside the image, so it is replaced rather
// than added to the disk. Those servers can only be in automatic chip mode:
// every PIN enrolment needs the kit key, and failed on them.

const fsp = require('node:fs/promises');
const path = require('node:path');

const { runCommand } = require('../lib/command-output.cjs');

const SECRET_DIR = '/run/mos-vault-agent/secrets';

async function run(file, args, options = {}) {
  return runCommand(file, args, { timeoutMs: 120_000, ...options });
}

async function keyslots(device) {
  const { stdout } = await run('cryptsetup', ['luksDump', '--dump-json-metadata', device]);
  const metadata = JSON.parse(String(stdout));
  const chipSlots = Object.values(metadata.tokens || {}).flatMap((token) => token.keyslots || []);
  return { all: Object.keys(metadata.keyslots || {}), chip: new Set(chipSlots) };
}

const systemCommands = {
  async addKeyThroughChip({ device, key }) {
    const keyFile = path.join(SECRET_DIR, `early-image-repair-${process.pid}.key`);
    try {
      await fsp.mkdir(SECRET_DIR, { mode: 0o700, recursive: true });
      await fsp.writeFile(keyFile, key, { mode: 0o600 });
      await run('cryptsetup', ['luksAddKey', '--batch-mode', '--token-only', device, keyFile], { mask: [key] });
      return true;
    } catch {
      return false;
    } finally {
      try { await fsp.rm(keyFile, { force: true }); } catch {}
    }
  },

  keyslots,

  async killSlot({ device, key, slot }) {
    await run('cryptsetup', ['luksKillSlot', '--batch-mode', '--key-file', '-', device, String(slot)], { input: key, mask: [key] });
  },
};

class EarlyImageRepair {
  constructor(adapter, commands = systemCommands) {
    this.adapter = adapter;
    this.commands = commands;
    this.kitChecked = null;
  }

  // Asked once per agent start: proving a key costs an Argon2 run.
  kitOpensDisk(device) {
    this.kitChecked ||= this.adapter.readOwnKey()
      .then((key) => (key ? this.adapter.opensWith({ device, key }) : true))
      .catch(() => true);
    return this.kitChecked;
  }

  // The slot holding the key nobody was given is removed, so the new kit is the only key besides the chip.
  async rekey({ device, toKey }) {
    const before = await this.commands.keyslots(device);
    if (!await this.commands.addKeyThroughChip({ device, key: toKey })) return { ok: false, reason: 'current-key-rejected' };
    if (!await this.adapter.opensWith({ device, key: toKey })) return { ok: false, reason: 'rekey-failed' };

    const after = await this.commands.keyslots(device);
    const added = after.all.filter((slot) => !before.all.includes(slot));
    for (const slot of after.all) {
      if (!added.includes(slot) && !after.chip.has(slot)) await this.commands.killSlot({ device, key: toKey, slot });
    }
    this.kitChecked = Promise.resolve(true);
    return { ok: true, repaired: true, vault: true };
  }
}

module.exports = { EarlyImageRepair, keyslots };
