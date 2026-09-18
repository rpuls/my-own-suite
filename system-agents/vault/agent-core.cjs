// The vault: the encrypted partition that holds everything of the owner's.
//
// The system partition is deliberately plaintext. It carries Ubuntu, the MOS
// checkout and a kernel — all of it public, identical on every install, and
// downloadable from us. Nothing on it is worth a thief's time. What is worth
// their time lives here: `/var/lib/docker` (every app's data), `/var/lib/mos`
// (the Suite Manager store, agent state, app packages) and `/etc/mos/secrets`.
// Each is bind-mounted back to its usual path once the vault is open, so no
// other part of MOS has to know the vault exists.
//
// Nothing is in `/etc/crypttab` and nothing is in `/etc/fstab`. Both would make
// a locked disk a boot failure, and a headless machine that fails to boot is a
// machine with no way left to tell its owner what it wants. Instead the vault is
// opened by `mos-vault.service`, which every unit holding owner data requires:
// while it has not succeeded, dockerd and Suite Manager do not start, and the
// only thing listening is the page that asks for the recovery key.
//
// The key is the recovery key the owner already has for their backups. It opens
// the backups that hold the same data, so one card to write down is both fewer
// things to lose and no less safe than two.
//
// How the vault opens is a setting of the machine, and there are two modes.
// By default the chip opens it, so a power cut is invisible; because the system
// partition is plaintext and nothing measures it, that also means a thief with
// the machine in hand can edit it offline, boot it, and be handed the key. The
// other mode makes the chip require the owner's Suite Manager password as well,
// which is the only thing on this layout that a stolen machine does not have.
// It is off by default because it costs an absent owner their apps until they
// type it, and the copy beside the switch says exactly that.
//
// Until the owner has confirmed they saved the recovery key, a copy of it sits
// on the plaintext partition and opens the vault whatever the chip does. The key
// is first shown after sign-in, and sign-in needs an open vault: without this a
// chip that refused on the second boot would lock an owner out of a key they
// were never given. The copy is discarded the moment the acknowledgement lands,
// so the encryption starts protecting at the same moment the owner can recover
// from it, and never earlier than they could.

const path = require('node:path');

const { planLayout } = require('./layout.cjs');
const {
  VAULT_DESCRIPTOR_PATH,
  VAULT_STATES,
  VAULT_TPM_MODES,
  VAULT_TPM_SLOTS,
} = require('../../shared/vault-contract.cjs');
const { HANDOVER } = require('../lib/recovery-key-store.cjs');

const MAPPER_NAME = 'mos-vault';
const MOUNTPOINT = '/var/lib/mos-vault';
const DESCRIPTOR_PATH = VAULT_DESCRIPTOR_PATH;
const FILESYSTEM_LABEL = 'mos-vault';

// Moved into the vault at creation, bind-mounted back on every open. `source`
// is where the data lives inside the vault; `target` is the path the rest of MOS
// keeps using and must never learn to stop using.
const PROTECTED_PATHS = [
  { mode: 0o710, name: 'docker', source: 'docker', target: '/var/lib/docker' },
  { mode: 0o755, name: 'state', source: 'mos', target: '/var/lib/mos' },
  { mode: 0o750, name: 'secrets', source: 'secrets', target: '/etc/mos/secrets' },
];

// Swap holds pages of decrypted app data. On the plaintext system partition that
// is a copy of the thing the vault exists to protect, sitting next to it, so the
// swapfile lives in the vault and is only ever swapped on after it opens. A
// locked machine has no swap because a locked machine is running nothing.
const SWAPFILE_NAME = 'swap.img';
// Where swap goes on a machine that has no vault to put it in: the same path
// Ubuntu and the first-boot script this replaces both used.
const SYSTEM_SWAPFILE_PATH = '/swap.img';
// Left by the gate on a boot from the installer stick, for the units after it
// that behave differently there. Per boot, because /run is.
const INSTALLER_MEDIA_MARKER = '/run/mos/installer-media';

class VaultError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.details = details;
  }
}

const STATES = VAULT_STATES;
const TPM_MODES = VAULT_TPM_MODES;
const TPM_SLOTS = VAULT_TPM_SLOTS;

// Every sentence this agent can put in front of an owner. They are here rather
// than at the call sites because a machine that says two different things about
// one condition is a machine nobody can be talked through on the phone.
const SENTENCES = {
  'disk-already-full': 'This machine was installed before MOS encrypted app data, so its disk has no room for a vault. Encrypting it means a fresh install and a restore from backup.',
  'disk-too-small-for-vault': 'This machine\'s disk is too small to hold an encrypted vault alongside the system, so app data is stored unencrypted.',
  'unrecognised-partitions-after-system': 'This disk holds partitions MOS did not create, so MOS left it alone. App data is stored unencrypted.',
  'no-tpm': 'This machine has no security chip, so it cannot unlock its own disk. Enter your recovery key after every restart.',
  'tpm-refused': 'This machine\'s security chip would not release the key. That happens after a firmware change, or if the disk has been moved to another machine.',
  'wrong-key': 'That is a valid recovery key, but not the one this machine\'s vault was created with.',
  'needs-password': 'This server restarted. Enter the password you sign in to Suite Manager with, and your apps start.',
  'wrong-password': 'The security chip did not accept that password. It only allows a few tries before it stops answering for a while; your recovery key does not go through the chip and works either way.',
  'tpm-locked-out': 'Too many wrong passwords, so this machine\'s security chip has stopped answering for a while. Your recovery key does not go through the chip and works right now.',
  'chip-needs-repair': 'This machine\'s security chip is waiting to be set up again, so it cannot open the disk on its own yet. Enter your recovery key, then sign in to Suite Manager and MOS repairs it.',
};

function sentenceFor(reason) {
  return SENTENCES[reason] || null;
}

/**
 * What the chip on this machine is currently good for.
 *
 * `mode` is what the owner chose and `slot` is whether the chip actually holds
 * what that choice needs; `enrolled` is the only question the unlock path asks,
 * because a slot that needs repair must not be tried. In password mode that
 * matters twice over: a chip slot left over from before a failed password
 * change would be tried with a password it does not know, and wrong tries are
 * what feed the chip's lockout.
 */
function chipState(descriptor) {
  const tpm = descriptor?.tpm || null;
  const mode = tpm?.mode === TPM_MODES.PASSWORD ? TPM_MODES.PASSWORD : TPM_MODES.AUTOMATIC;
  const slot = tpm?.slot === TPM_SLOTS.NEEDS_REPAIR ? TPM_SLOTS.NEEDS_REPAIR : TPM_SLOTS.ENROLLED;
  return { enrolled: Boolean(tpm) && slot === TPM_SLOTS.ENROLLED, mode, present: Boolean(tpm), slot };
}

// Why a vault that exists is not open, for a machine nobody has typed anything
// into yet. Four different things, four different sentences: this machine never
// had a chip, its chip is waiting to be repaired, its chip is waiting for the
// owner's password, or its chip refused for a reason of its own.
function lockedReason(descriptor) {
  const chip = chipState(descriptor);
  if (!chip.present) return 'no-tpm';
  if (chip.slot === TPM_SLOTS.NEEDS_REPAIR) return 'chip-needs-repair';
  if (chip.mode === TPM_MODES.PASSWORD) return 'needs-password';
  return 'tpm-refused';
}

// Added to the lockout sentence when the chip could be asked how long it sulks
// for. Never guessed: a machine with no `tpm2-tools` says nothing about time
// rather than inventing a number an owner would sit and wait out.
function describeLockout(seconds) {
  if (!seconds || seconds < 60) return '';
  const minutes = Math.round(seconds / 60);
  return ` It starts answering again about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} after the last wrong try.`;
}

class VaultAgentCore {
  constructor(adapter, { descriptorPath = DESCRIPTOR_PATH, mountpoint = MOUNTPOINT } = {}) {
    this.adapter = adapter;
    this.descriptorPath = descriptorPath;
    this.mountpoint = mountpoint;
  }

  async status() {
    const descriptor = await this.adapter.readDescriptor(this.descriptorPath);
    if (!descriptor) return { protects: [], state: STATES.ABSENT, reason: 'not-created' };
    if (descriptor.state === STATES.UNSUPPORTED) {
      return {
        protects: [],
        reason: descriptor.reason,
        sentence: sentenceFor(descriptor.reason),
        state: STATES.UNSUPPORTED,
      };
    }

    const mounted = await this.adapter.isMounted(this.mountpoint);
    const chip = chipState(descriptor);
    const reason = mounted ? null : lockedReason(descriptor);
    return {
      createdAt: descriptor.createdAt,
      device: descriptor.device,
      // `pending` means a copy of the key still sits on the plaintext partition
      // and the encryption protects nothing yet; the screens say so.
      handover: (await this.adapter.hasEscrow()) ? HANDOVER.PENDING : HANDOVER.DONE,
      protects: PROTECTED_PATHS.map((entry) => entry.target),
      reason,
      sentence: reason ? sentenceFor(reason) : null,
      state: mounted ? STATES.UNLOCKED : STATES.LOCKED,
      tpm: chip.present
        ? { enrolledAt: descriptor.tpm.enrolledAt, mode: chip.mode, pcrs: descriptor.tpm.pcrs, slot: chip.slot }
        : null,
      // Derived rather than stored, so the standing statement in settings can
      // only ever say something that is true right now: a machine in password
      // mode does not open itself, and neither does one whose chip is waiting
      // to be repaired.
      unlocksItself: chip.enrolled && chip.mode === TPM_MODES.AUTOMATIC,
    };
  }

  /**
   * The whole of boot, in the order a first boot needs it: lay the disk out if
   * this machine has never been laid out, then open what is there.
   *
   * Returns `{ opened: false, reason }` rather than throwing when the vault is
   * simply locked. A locked vault is not a failure of this code — it is the
   * state the machine is designed to sit in until someone types the key.
   *
   * No vault is created, and no descriptor written, until the machine is armed
   * and running from its own disk. The published image is baked by running this
   * bootstrap in a VM and snapshotting the disk, and the installer stick is
   * `dd`'d onto the internal disk: a vault or a descriptor made in either place
   * would travel to every machine after it, sharing one key or claiming a
   * decision that was never made there. `mos-image-finalize` arms the image as
   * its last act.
   */
  async open({ key = null, pin = null } = {}) {
    let descriptor = await this.adapter.readDescriptor(this.descriptorPath);

    if (!descriptor) {
      if (!(await this.adapter.isVaultArmed())) return { opened: true, reason: 'not-armed', vault: false };
      if (await this.adapter.isRemovableRoot()) {
        await this.adapter.markInstallerMedia();
        return { opened: true, reason: 'running-from-installer-media', vault: false };
      }

      const created = await this.create();
      if (created.descriptor.state === STATES.UNSUPPORTED) return { opened: true, reason: created.descriptor.reason, vault: false };
      return { created: true, opened: true, vault: true, ...(created.enrollment.enrolled ? {} : { chip: created.enrollment }) };
    }
    if (descriptor.state === STATES.UNSUPPORTED) return { opened: true, reason: descriptor.reason, vault: false };

    if (await this.adapter.isMounted(this.mountpoint)) return { opened: true, vault: true };

    const unlocked = await this.unlockMapper(descriptor, { key, pin });
    if (!unlocked.ok) {
      const sentence = sentenceFor(unlocked.reason);
      return {
        opened: false,
        reason: unlocked.reason,
        sentence: sentence ? `${sentence}${describeLockout(unlocked.lockoutSeconds)}` : null,
        vault: true,
      };
    }

    await this.mountAll(descriptor);
    // Inside the handover window the escrow is the key, and the key is what
    // authorises teaching the chip again. A chip that refused before the owner
    // ever signed in heals here, so the first restart after the handover does
    // not ask for a key the escrow has just been destroyed to protect.
    if (unlocked.by === 'escrow') {
      const resealed = await this.reseal({ key: await this.adapter.readEscrow() });
      return { opened: true, resealed: Boolean(resealed.resealed), unlockedBy: unlocked.by, vault: true };
    }
    return { opened: true, unlockedBy: unlocked.by, vault: true };
  }

  /**
   * The chip where the chip can answer, the owner's password where the mode
   * says the chip needs one, the typed recovery key behind both — and, until
   * the owner has been handed that key, the escrowed copy behind everything.
   *
   * The chip is never tried in password mode without a password: it would only
   * fail slowly, and on a mode-`password` machine `mos-vault.service` calls
   * this at boot with neither, which is exactly the state that has to end in
   * "ask the owner" rather than in a minute of TPM timeouts.
   */
  async unlockMapper(descriptor, { key = null, pin = null } = {}) {
    if (await this.adapter.mapperExists(MAPPER_NAME)) return { by: 'already-open', ok: true };

    const chip = chipState(descriptor);
    let refused;
    if (chip.enrolled && chip.mode === TPM_MODES.PASSWORD) {
      if (pin) {
        const viaPin = await this.adapter.luksOpenWithTpm({ device: descriptor.device, mapper: MAPPER_NAME, pin });
        if (viaPin.ok) return { by: 'password', ok: true };
        refused = { lockoutSeconds: viaPin.lockoutSeconds, ok: false, reason: viaPin.reason || 'wrong-password' };
      } else {
        refused = { ok: false, reason: 'needs-password' };
      }
    } else if (chip.enrolled) {
      const viaTpm = await this.adapter.luksOpenWithTpm({ device: descriptor.device, mapper: MAPPER_NAME });
      if (viaTpm.ok) return { by: 'tpm', ok: true };
      refused = { ok: false, reason: 'tpm-refused' };
    } else {
      refused = { ok: false, reason: lockedReason(descriptor) };
    }

    if (key) {
      const viaKey = await this.adapter.luksOpen({ device: descriptor.device, key, mapper: MAPPER_NAME });
      return viaKey.ok ? { by: 'key', ok: true } : { ok: false, reason: 'wrong-key' };
    }

    const escrowed = await this.adapter.readEscrow();
    if (escrowed) {
      const viaEscrow = await this.adapter.luksOpen({ device: descriptor.device, key: escrowed, mapper: MAPPER_NAME });
      if (viaEscrow.ok) return { by: 'escrow', ok: true };
    }
    return refused;
  }

  /**
   * Discards the escrowed key once the owner has confirmed they hold theirs.
   *
   * The acknowledgement is the backup agent's record, read here rather than
   * pushed over a socket, so an acknowledgement recorded while this agent was
   * down still takes effect the next time anything asks about the vault.
   */
  async settleHandover() {
    if (!await this.adapter.hasEscrow()) return { discarded: false };
    if (!await this.adapter.keyAcknowledged()) return { discarded: false };
    await this.adapter.discardEscrow();
    return { discarded: true };
  }

  /**
   * Teaches the chip what this machine's mode says it must know, and records
   * what it now knows.
   *
   * This is the whole of the startup-protection switch, of a password change
   * the chip has to follow, of the repair after one that did not, and of
   * re-sealing when the measurements changed under it. Three properties hold in
   * every one of those cases:
   *
   * - the recovery-key keyslot is never touched, so nothing here can brick a
   *   machine — the worst outcome is an owner typing their key once;
   * - the chip is never left holding a secret MOS does not believe it holds,
   *   because a failed enrollment takes the chip slot with it;
   * - nothing is asked of the owner that they do not already have. The
   *   enrollment is authorised by this machine's own recovery key, read from
   *   the vault it is already inside.
   *
   * `mode: 'current'` is for the callers that are not choosing a mode — a
   * password change, a repair — and must not accidentally change one. The
   * machine's own descriptor decides, and on a machine in automatic mode there
   * is nothing to do.
   */
  async enrollChip({ key = null, mode = 'current', pin = null } = {}) {
    const descriptor = await this.adapter.readDescriptor(this.descriptorPath);
    if (!descriptor || descriptor.state === STATES.UNSUPPORTED) return { ok: true, vault: false };
    if (!await this.adapter.isMounted(this.mountpoint)) return { ok: false, reason: 'locked' };

    const chip = chipState(descriptor);
    const wanted = mode === 'current' ? chip.mode : mode;
    // A caller not choosing a mode has nothing to do on a machine with no chip,
    // or on one that opens itself with a healthy slot: unchanged, not refused.
    if (mode === 'current' && (!chip.present || (wanted === TPM_MODES.AUTOMATIC && chip.enrolled))) {
      return { mode: chip.present ? wanted : null, ok: true, slot: chip.slot, unchanged: true, vault: true };
    }
    if (wanted === TPM_MODES.PASSWORD && !pin) return { ok: false, reason: 'no-password' };

    const authorising = key || await this.adapter.readOwnKey();
    if (!authorising) return { ok: false, reason: 'own-key-unreadable' };

    const enrolled = await this.adapter.enrollTpm({
      device: descriptor.device,
      key: authorising,
      pin: wanted === TPM_MODES.PASSWORD ? pin : null,
    });
    if (enrolled.enrolled) {
      await this.writeChip(descriptor, {
        enrolledAt: this.adapter.now(),
        mode: wanted,
        pcrs: enrolled.pcrs,
        slot: TPM_SLOTS.ENROLLED,
      });
      return { mode: wanted, ok: true, slot: TPM_SLOTS.ENROLLED, vault: true };
    }

    if (enrolled.reason === 'no-tpm') return { ok: false, reason: 'no-tpm' }; // no chip is not a broken chip

    // Whether the wipe the enrollment starts with reached the old slot is not
    // knowable from here, and a slot still holding the previous password is
    // the one outcome worth undoing.
    await this.adapter.wipeTpmEnrollment({ device: descriptor.device });
    await this.writeChip(descriptor, {
      enrolledAt: null,
      mode: wanted,
      pcrs: descriptor.tpm?.pcrs || null,
      slot: TPM_SLOTS.NEEDS_REPAIR,
    });
    return { mode: wanted, ok: false, reason: enrolled.reason, slot: TPM_SLOTS.NEEDS_REPAIR, vault: true };
  }

  /**
   * What happens after an owner typed their recovery key.
   *
   * The key is the authority, not the boot state: someone who has it already
   * has everything, so re-sealing the chip against whatever the machine now
   * measures gives nothing away, and it is what makes one key entry after a
   * firmware update the whole cost of that update rather than the start of a
   * habit.
   *
   * In password mode MOS cannot finish the job here, because the chip needs the
   * owner's password and this page never had it. The slot is marked as needing
   * repair — so the next restart asks for the key rather than a password the
   * chip may no longer know — and the next sign-in, which does hold the
   * password for a moment, completes it.
   */
  async reseal({ key = null } = {}) {
    const descriptor = await this.adapter.readDescriptor(this.descriptorPath);
    const chip = chipState(descriptor);
    if (!chip.present) return { resealed: false, reason: 'no-chip' };

    if (chip.mode === TPM_MODES.PASSWORD) {
      await this.writeChip(descriptor, { ...descriptor.tpm, slot: TPM_SLOTS.NEEDS_REPAIR });
      return { repairPending: true, resealed: false };
    }

    const result = await this.enrollChip({ key, mode: TPM_MODES.AUTOMATIC });
    return { reason: result.reason, resealed: result.ok };
  }

  async writeChip(descriptor, tpm) {
    await this.adapter.writeDescriptor(this.descriptorPath, { ...descriptor, tpm });
  }

  /**
   * Makes a key this machine was handed its own, for the disk as well as the
   * backups.
   *
   * This is the second half of what a takeover restore already does. A machine
   * that takes another's place adopts that machine's recovery key, because the
   * two are now one server with one key — and once that key also opens a disk,
   * adopting it for the backups alone would leave an owner holding a card that
   * opens their archive and not their server. The archive is never touched:
   * adding this machine's key to it instead would leave every test restore's
   * key able to open it for good.
   *
   * A machine with no vault answers `{ ok: true, vault: false }`, because there
   * is nothing here to rekey and the caller's next step — writing the key file —
   * is the whole of adoption on that machine.
   */
  async rekey({ nextKey }) {
    if (!nextKey) return { ok: false, reason: 'no-key' };

    const descriptor = await this.adapter.readDescriptor(this.descriptorPath);
    if (!descriptor || descriptor.state === STATES.UNSUPPORTED) return { ok: true, vault: false };
    if (!await this.adapter.isMounted(this.mountpoint)) return { ok: false, reason: 'locked' };

    const currentKey = await this.adapter.readOwnKey();
    if (!currentKey) return { ok: false, reason: 'own-key-unreadable' };
    // Already the key being adopted: a restore repeated after an interrupted
    // one must not report a failure for work that is already done.
    if (currentKey === nextKey) return { ok: true, unchanged: true, vault: true };

    const result = await this.adapter.rekey({ device: descriptor.device, fromKey: currentKey, toKey: nextKey });
    if (!result.ok) return { ok: false, reason: result.reason || 'rekey-failed' };
    return { ok: true, vault: true };
  }

  async mountAll(descriptor) {
    await this.adapter.mount({ device: `/dev/mapper/${MAPPER_NAME}`, mountpoint: this.mountpoint });
    for (const entry of PROTECTED_PATHS) {
      const source = path.posix.join(this.mountpoint, entry.source);
      await this.adapter.ensureDirectory({ mode: entry.mode, path: source });
      await this.adapter.ensureDirectory({ mode: entry.mode, path: entry.target });
      await this.adapter.bind({ source, target: entry.target });
    }
    await this.adapter.enableSwapfile({ path: path.posix.join(this.mountpoint, SWAPFILE_NAME) });
    return descriptor;
  }

  /**
   * First boot. Claims the rest of the disk, encrypts the part of it that holds
   * owner data, and moves what already exists on the system partition into it.
   *
   * The move happens here, once, while dockerd and Suite Manager have never
   * started — that is the only moment these directories can be relocated without
   * anything holding them open, and it is why this runs before them rather than
   * being something the owner turns on later.
   *
   * The chip is enrolled best effort and always in automatic mode. A machine
   * with no usable chip still gets a vault and is told the key after every
   * restart; a chip that refused here is recorded as needing repair, so the
   * first recovery-key unlock tries it again rather than the machine believing
   * for good that it has no chip. Startup protection is chosen later, in
   * settings, by an owner who has had a chance to understand the trade.
   */
  async create() {
    const disk = await this.adapter.inspectDisk();
    const plan = planLayout(disk);

    if (plan.action === 'none') return { descriptor: await this.recordUnsupported(plan.reason), enrollment: null };
    if (plan.action === 'grow-system') {
      await this.growSystem(disk, plan.systemEndSector);
      await this.adapter.enableSwapfile({ path: SYSTEM_SWAPFILE_PATH });
      return { descriptor: await this.recordUnsupported(plan.reason), enrollment: null };
    }

    await this.growSystem(disk, plan.systemEndSector);
    const device = await this.adapter.createVaultPartition({
      disk: disk.device,
      endSector: plan.vault.endSector,
      startSector: plan.vault.startSector,
    });

    const { key } = await this.adapter.generateRecoveryKey();
    await this.adapter.luksFormat({ device, key });
    const opened = await this.adapter.luksOpen({ device, key, mapper: MAPPER_NAME });
    if (!opened.ok) throw new VaultError('VAULT_CREATE_FAILED', 'The vault was created but could not be opened.');
    await this.adapter.makeFilesystem({ device: `/dev/mapper/${MAPPER_NAME}`, label: FILESYSTEM_LABEL });
    await this.adapter.mount({ device: `/dev/mapper/${MAPPER_NAME}`, mountpoint: this.mountpoint });

    for (const entry of PROTECTED_PATHS) {
      await this.adapter.moveIntoVault({
        mode: entry.mode,
        source: entry.target,
        target: path.posix.join(this.mountpoint, entry.source),
      });
      await this.adapter.bind({ source: path.posix.join(this.mountpoint, entry.source), target: entry.target });
    }
    await this.adapter.enableSwapfile({ path: path.posix.join(this.mountpoint, SWAPFILE_NAME) });

    const tpm = await this.adapter.enrollTpm({ device, key });
    await this.adapter.publishRecoveryKey({ key });
    await this.adapter.escrowKey(key);

    let chip = null;
    if (tpm.enrolled) chip = { enrolledAt: this.adapter.now(), mode: TPM_MODES.AUTOMATIC, pcrs: tpm.pcrs, slot: TPM_SLOTS.ENROLLED };
    else if (tpm.reason !== 'no-tpm') chip = { enrolledAt: null, mode: TPM_MODES.AUTOMATIC, pcrs: null, slot: TPM_SLOTS.NEEDS_REPAIR };

    // Decisions only, never state: whether the vault is open is asked of the
    // mapper, and a stored answer would be stale by the first locked boot.
    const descriptor = {
      createdAt: this.adapter.now(),
      device,
      mapper: MAPPER_NAME,
      mountpoint: this.mountpoint,
      tpm: chip,
      version: 1,
    };
    await this.adapter.writeDescriptor(this.descriptorPath, descriptor);
    return { descriptor, enrollment: tpm };
  }

  async growSystem(disk, systemEndSector) {
    if (systemEndSector <= disk.systemPartition.endSector) return;
    await this.adapter.resizePartition({
      device: disk.device,
      endSector: systemEndSector,
      number: disk.systemPartition.number,
    });
    await this.adapter.growFilesystem({ device: disk.systemPartition.device });
  }

  // A machine that will never have a vault still records why, because "your data
  // is not encrypted" is a sentence the owner has to be able to find an
  // explanation for, months later, without an agent to ask.
  async recordUnsupported(reason) {
    const descriptor = { createdAt: this.adapter.now(), reason, state: STATES.UNSUPPORTED, version: 1 };
    await this.adapter.writeDescriptor(this.descriptorPath, descriptor);
    return descriptor;
  }
}

module.exports = {
  DESCRIPTOR_PATH,
  INSTALLER_MEDIA_MARKER,
  SYSTEM_SWAPFILE_PATH,
  MAPPER_NAME,
  MOUNTPOINT,
  PROTECTED_PATHS,
  SENTENCES,
  STATES,
  TPM_MODES,
  TPM_SLOTS,
  VaultAgentCore,
  VaultError,
  sentenceFor,
};
