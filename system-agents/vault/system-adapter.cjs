'use strict';

// The commands behind the vault. Everything here is a privileged operation on a
// partition table or a block device, which is why the decisions live next door
// in `agent-core.cjs` and `layout.cjs` where they can be tested: this file is
// meant to be dull.
//
// Binaries are called by name rather than by absolute path. util-linux and
// cryptsetup split between /usr/bin and /usr/sbin differently across releases,
// and a hardcoded path that is wrong turns "the disk could not be read" into
// "the vault is broken". The unit sets PATH.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { VaultError } = require('./agent-core.cjs');
const { INSTALLER_MEDIA_MARKER } = require('../../shared/vault-contract.cjs');
const { describeFailure, runCommand } = require('../lib/command-output.cjs');
const { fingerprint, generate } = require('../backup/recovery-key.cjs');
const { RecoveryKeyStore } = require('../lib/recovery-key-store.cjs');

// The GPT type GUID for a LUKS partition. Naming the partition for what it is
// keeps a future MOS, a rescue disk and a curious owner from having to guess.
const LUKS_PARTITION_TYPE = 'CA7D7CCB-63ED-4C53-861C-1742536059CC';
const FILESYSTEM_LABEL = 'mos-vault';
// Written by `mos-image-finalize` as the last step of turning a baked VM into
// the published image. Its absence is what stops the bake itself, and a cloud
// install where MOS does not own the disk layout, from creating a vault.
const VAULT_ARMED_PATH = '/etc/mos/vault-armed';
// PCR 7 is the Secure Boot policy: which keys the firmware trusts and whether
// it is enforcing at all. Sealing to it means a disk moved to another machine,
// or a machine with Secure Boot switched off to boot something else, does not
// get its key back.
//
// It deliberately does not cover which bootloader or kernel ran, and adding
// them would buy nothing here: the system partition is plaintext and nothing
// measures it, so an attacker with the machine in hand edits it offline and
// boots it unchanged, and every PCR still matches. A chip that opens the vault
// on its own opens it for whoever holds the machine, whatever it measures. What
// closes that is a secret the machine does not have — the owner's password, as
// a chip PIN, which is `VAULT_TPM_MODES.PASSWORD` — or encrypting the system
// half too, which is a boot-stack change and is where kernel measurement
// belongs, because there it protects something that cannot be edited.
const TPM_PCRS = '7';
const TPM_DEVICE_PATHS = ['/dev/tpmrm0', '/dev/tpm0'];
const SYSTEMD_CRYPTSETUP_PATHS = ['/usr/lib/systemd/systemd-cryptsetup', '/lib/systemd/systemd-cryptsetup'];
// tmpfs, so nothing written here to hand a secret to a command ever reaches a
// disk — least of all the plaintext one next to the vault.
const AGENT_RUNTIME_DIR = '/run/mos-vault-agent';
// Secrets are staged one level down, because the directory above them holds the
// socket Suite Manager connects to. Staging used to create that directory
// itself, from a root-only process that runs before the agent, and a directory
// private to root is one Suite Manager cannot reach the socket through.
const AGENT_SECRET_DIR = path.join(AGENT_RUNTIME_DIR, 'secrets');
// The system credential systemd-cryptsetup reads a TPM2 PIN from when it is not
// allowed to ask a human. See `stagePin` for why both this and `$PIN` are set.
const TPM_PIN_CREDENTIAL = 'cryptsetup.tpm2-pin';
// cryptsetup's exit code for "the passphrase does not open this device". Every
// other non-zero code is a real fault and is raised rather than reported as a
// wrong key.
const CRYPTSETUP_NO_PERMISSION = 2;
const SWAPFILE_BYTES = 2 * 1024 * 1024 * 1024;
// Left free after the swapfile, and the smallest swapfile worth making.
const SWAPFILE_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;
const SWAPFILE_FLOOR_BYTES = 512 * 1024 * 1024;

// The parent is created without a mode of its own, so a directory that is
// already there keeps the one the agent gave it; only the staging directory
// inside is private to root.
async function stagingDir() {
  await fsp.mkdir(AGENT_RUNTIME_DIR, { recursive: true });
  await fsp.mkdir(AGENT_SECRET_DIR, { mode: 0o700, recursive: true });
  return AGENT_SECRET_DIR;
}

function fail(code, message, error) {
  const details = error ? [describeFailure(error)] : [];
  return new VaultError(code, message, { details });
}

async function atomicWriteJson(filePath, value, mode = 0o644) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fsp.chmod(temporary, mode);
  await fsp.rename(temporary, filePath);
}

async function run(file, args, options = {}) {
  return runCommand(file, args, { timeoutMs: 600_000, ...options });
}

// `findmnt` and friends answer on stdout and say nothing useful on failure, so
// a failure here means "no" rather than an error worth carrying.
async function quiet(file, args, options = {}) {
  try {
    const result = await run(file, args, options);
    return String(result.stdout || '').trim();
  } catch {
    return '';
  }
}

function partitionNumber(node) {
  const match = /(\d+)$/u.exec(String(node || ''));
  return match ? Number(match[1]) : null;
}

class SystemVaultAdapter {
  constructor({ keys = new RecoveryKeyStore() } = {}) {
    this.keys = keys;
  }

  now() {
    return new Date().toISOString();
  }

  async generateRecoveryKey() {
    return generate();
  }

  async isVaultArmed() {
    return fs.existsSync(VAULT_ARMED_PATH);
  }

  // The recovery key's files are the store's; this agent only ever asks. The
  // acknowledgement is written to the same record by the backup agent, which is
  // how "the owner has been shown the key" reaches the escrow without a socket.
  async escrowKey(key) {
    this.keys.escrow(key);
  }

  async hasEscrow() {
    return this.keys.hasEscrow();
  }

  async readEscrow() {
    return this.keys.readEscrow();
  }

  async keyAcknowledged() {
    return this.keys.acknowledged();
  }

  async discardEscrow() {
    this.keys.discardEscrow();
  }

  // Left for the units that run after the gate: the address banner and the
  // login generator both behave differently on the installer stick, and this is
  // the one place the answer is worked out.
  async markInstallerMedia() {
    await fsp.mkdir(path.dirname(INSTALLER_MEDIA_MARKER), { recursive: true });
    await fsp.writeFile(INSTALLER_MEDIA_MARKER, '');
  }

  async readDescriptor(descriptorPath) {
    try {
      return JSON.parse(await fsp.readFile(descriptorPath, 'utf8'));
    } catch {
      return null;
    }
  }

  async writeDescriptor(descriptorPath, descriptor) {
    await atomicWriteJson(descriptorPath, descriptor);
  }

  // The partition the root filesystem is on, and the whole disk under it.
  async rootDisk() {
    const source = await quiet('findmnt', ['-no', 'SOURCE', '/']);
    const parent = source ? (await quiet('lsblk', ['-no', 'PKNAME', source])).split('\n')[0].trim() : '';
    return { device: parent ? `/dev/${parent}` : null, parent, source };
  }

  // The same guard the installer carries: a machine running from the stick is a
  // machine whose owner declined the install, and partitioning it would eat the
  // installer they are still running.
  async isRemovableRoot() {
    const { device, parent } = await this.rootDisk();
    if (!device) return true;
    const transport = (await quiet('lsblk', ['-dno', 'TRAN', device])).trim();
    let removable = '0';
    try { removable = (await fsp.readFile(`/sys/block/${parent}/removable`, 'utf8')).trim(); } catch {}
    return transport === 'usb' || removable === '1';
  }

  /**
   * Moves the backup GPT to the end of the disk and sets the table's last
   * usable sector to match. The image's table was written for the disk it was
   * built on; copied onto any other it still ends where that one did, and every
   * sector past that is invisible to the layout until this has run.
   */
  async fitTableToDisk() {
    const { device } = await this.rootDisk();
    if (!device) throw fail('VAULT_DISK_UNREADABLE', 'MOS could not tell which disk it is running from.');
    try {
      await run('sfdisk', ['--no-reread', '--force', '--relocate', 'gpt-bak-std', device]);
    } catch (error) {
      throw fail('VAULT_DISK_UNREADABLE', 'MOS could not fit this machine\'s partition table to its disk.', error);
    }
  }

  /**
   * The disk as the partition table describes it. `sfdisk --json` is the only
   * one of these tools that reports start sectors, sizes, the sector size and
   * the last usable LBA together, which is exactly the arithmetic the layout
   * needs and exactly what it must not guess.
   */
  async inspectDisk() {
    const { device, source } = await this.rootDisk();
    if (!device) throw fail('VAULT_DISK_UNREADABLE', 'MOS could not tell which disk it is running from.');

    let table;
    try {
      const result = await run('sfdisk', ['--json', device]);
      table = JSON.parse(result.stdout).partitiontable;
    } catch (error) {
      throw fail('VAULT_DISK_UNREADABLE', 'MOS could not read this machine\'s partition table.', error);
    }

    const sectorSize = Number(table.sectorsize || 512);
    const sizeOutput = await quiet('blockdev', ['--getsize64', device]);
    const diskBytes = Number(sizeOutput) || (Number(table.lastlba || 0) + 34) * sectorSize;

    const partitions = (table.partitions || []).map((partition) => ({
      device: partition.node,
      endSector: Number(partition.start) + Number(partition.size) - 1,
      number: partitionNumber(partition.node),
      startSector: Number(partition.start),
      type: String(partition.type || '').toUpperCase(),
    }));

    return {
      device,
      diskBytes,
      lastUsableSector: table.lastlba ? Number(table.lastlba) : undefined,
      partitions,
      sectorSize,
      systemPartition: partitions.find((partition) => partition.device === source) || null,
      vaultPresent: partitions.some((partition) => partition.type === LUKS_PARTITION_TYPE),
    };
  }

  /**
   * Grows one partition in place. Never shrinks: the guard is here as well as in
   * the layout because this is the call that would destroy a filesystem, and a
   * second opinion costs one comparison.
   */
  async resizePartition({ device, endSector, number }) {
    const table = JSON.parse((await run('sfdisk', ['--json', device])).stdout).partitiontable;
    const current = (table.partitions || []).find((partition) => partitionNumber(partition.node) === number);
    if (!current) throw fail('VAULT_PARTITION_MISSING', 'The system partition disappeared while MOS was laying out the disk.');

    const sectors = endSector - Number(current.start) + 1;
    if (sectors < Number(current.size)) {
      throw fail('VAULT_REFUSED_SHRINK', 'MOS refused to shrink the system partition.');
    }
    if (sectors === Number(current.size)) return;

    try {
      await run('sfdisk', ['--no-reread', '--force', '-N', String(number), device], { input: `,${sectors}\n` });
    } catch (error) {
      throw fail('VAULT_RESIZE_FAILED', 'MOS could not grow the system partition to fill this disk.', error);
    }
    await quiet('partx', ['-u', device]);
    await quiet('udevadm', ['settle']);
  }

  async growFilesystem({ device }) {
    try {
      await run('resize2fs', [device]);
    } catch (error) {
      throw fail('VAULT_RESIZE_FAILED', 'MOS could not grow the system filesystem.', error);
    }
  }

  /**
   * Appends the vault partition and returns a name that survives a disk being
   * moved, another disk being added, or the kernel enumerating them in a
   * different order — all three of which change /dev/sdaN and none of which
   * change a PARTUUID.
   */
  async createVaultPartition({ disk, endSector, startSector }) {
    const sectors = endSector - startSector + 1;
    try {
      await run('sfdisk', ['--append', '--force', disk], {
        input: `${startSector},${sectors},${LUKS_PARTITION_TYPE},\n`,
      });
    } catch (error) {
      throw fail('VAULT_PARTITION_FAILED', 'MOS could not create the encrypted partition on this disk.', error);
    }
    await quiet('partx', ['-a', disk]);
    await quiet('udevadm', ['settle']);

    const table = JSON.parse((await run('sfdisk', ['--json', disk])).stdout).partitiontable;
    const created = (table.partitions || []).find((partition) => Number(partition.start) === startSector);
    if (!created) throw fail('VAULT_PARTITION_FAILED', 'MOS created the encrypted partition but could not find it again.');
    if (!created.uuid) return created.node;

    const byPartuuid = `/dev/disk/by-partuuid/${String(created.uuid).toLowerCase()}`;
    return fs.existsSync(byPartuuid) ? byPartuuid : created.node;
  }

  async luksFormat({ device, key }) {
    try {
      await run('cryptsetup', [
        'luksFormat', '--type', 'luks2', '--batch-mode', '--label', FILESYSTEM_LABEL, '--key-file', '-', device,
      ], { input: key, mask: [key] });
    } catch (error) {
      throw fail('VAULT_FORMAT_FAILED', 'MOS could not encrypt the vault partition.', error);
    }
  }

  async luksOpen({ device, key, mapper }) {
    if (!key) return { ok: false };
    try {
      await run('cryptsetup', ['open', '--key-file', '-', device, mapper], { input: key, mask: [key] });
      return { ok: true };
    } catch (error) {
      if (error?.exitCode === CRYPTSETUP_NO_PERMISSION) return { ok: false };
      if (fs.existsSync(`/dev/mapper/${mapper}`)) return { ok: true };
      throw fail('VAULT_OPEN_FAILED', 'MOS could not open the encrypted vault.', error);
    }
  }

  hasTpmDevice() {
    return TPM_DEVICE_PATHS.some((candidate) => fs.existsSync(candidate));
  }

  /**
   * Hands a PIN to systemd-cryptsetup without putting it on a command line.
   *
   * Which of the two mechanisms a release honours has changed: `$PIN` is
   * documented for systemd-cryptenroll, and the `cryptsetup.tpm2-pin` system
   * credential is the documented way in for systemd-cryptsetup, which is not
   * allowed to ask a human here because `headless=true` is the only safe
   * setting for a process with no terminal. Both are set rather than betting on
   * one, and the credential directory is a fresh tmpfs directory that is
   * removed whether the attempt worked or not.
   */
  async stagePin(pin) {
    const directory = await fsp.mkdtemp(path.join(await stagingDir(), 'pin-'));
    await fsp.writeFile(path.join(directory, TPM_PIN_CREDENTIAL), pin, { mode: 0o600 });
    return {
      directory,
      discard: async () => { try { await fsp.rm(directory, { force: true, recursive: true }); } catch {} },
    };
  }

  /**
   * Whether the chip has stopped answering because of wrong PINs.
   *
   * The chip's own dictionary-attack lockout is what makes an owner's password
   * a strong disk key — a disk taken away from the chip has nothing to guess
   * against, and the chip itself only allows a handful of tries. It is also
   * what an owner hits by mistyping their password a few times, so "that was
   * wrong" and "it has stopped listening" must not be told as the same thing.
   *
   * `tpm2-tools` is installed best effort by the bootstrap, so a machine
   * without it gets the wrong-password sentence. That is the safer of the two
   * to be wrong about: it never tells an owner to wait when they could simply
   * try again, and the recovery key works in both cases.
   */
  async readTpmLockout() {
    const output = await quiet('tpm2_getcap', ['properties-variable']);
    if (!output) return { lockedOut: false, readable: false };
    const value = (name) => {
      const match = new RegExp(`${name}:\\s*(0x[0-9a-fA-F]+|\\d+)`, 'u').exec(output);
      return match ? Number(match[1]) : null;
    };
    const counter = value('TPM2_PT_LOCKOUT_COUNTER');
    const maxFailures = value('TPM2_PT_MAX_AUTH_FAIL');
    const interval = value('TPM2_PT_LOCKOUT_INTERVAL');
    const lockedOut = /inLockout:\s*1/u.test(output)
      || (counter !== null && maxFailures !== null && counter >= maxFailures);
    return { lockedOut, readable: true, recoverySeconds: interval ?? null };
  }

  /**
   * Asks the chip for the key, with the owner's PIN where the machine is
   * enrolled to require one.
   *
   * A refusal is a state, not a fault — it is what a moved disk, a firmware
   * update, a wrong password or a locked-out chip is supposed to produce — so
   * this reports rather than throws, and the owner is asked for the recovery
   * key instead. The reason it reports is what decides which of three
   * sentences the locked page shows.
   */
  async luksOpenWithTpm({ device, mapper, pin = null }) {
    if (!this.hasTpmDevice()) return { ok: false, reason: 'no-tpm' };

    const binary = SYSTEMD_CRYPTSETUP_PATHS.find((candidate) => fs.existsSync(candidate));
    if (binary) {
      const handed = pin ? await this.stagePin(pin) : null;
      try {
        await run(binary, ['attach', mapper, device, '-', 'tpm2-device=auto,headless=true'], {
          env: handed ? { ...process.env, CREDENTIALS_DIRECTORY: handed.directory, PIN: pin } : undefined,
          mask: pin ? [pin] : [],
          timeoutMs: 120_000,
        });
        return { ok: true };
      } catch {
        if (fs.existsSync(`/dev/mapper/${mapper}`)) return { ok: true };
        if (pin) {
          const lockout = await this.readTpmLockout();
          if (lockout.lockedOut) return { lockoutSeconds: lockout.recoverySeconds, ok: false, reason: 'tpm-locked-out' };
          return { ok: false, reason: 'wrong-password' };
        }
      } finally {
        if (handed) await handed.discard();
      }
    } else if (pin) {
      // Nothing else on the machine can present a PIN to the chip, and falling
      // through to the tokens path would ask it for a key it will not give up
      // without one.
      return { ok: false, reason: 'tpm-refused' };
    }

    try {
      await run('cryptsetup', ['open', '--token-only', device, mapper], { timeoutMs: 120_000 });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'tpm-refused' };
    }
  }

  /**
   * Teaches the chip this vault's key, and — in password mode — the PIN it must
   * be given before it will release it again.
   *
   * One invocation wipes any chip keyslot that is already there and writes the
   * new one, so there is never a moment with two of them or with a policy that
   * no longer matches this machine. The recovery key in `$PASSWORD` is what
   * authorises the enrollment: the chip never authorises itself, and this is
   * why re-sealing after an owner typed their key is safe — it is the key that
   * permits it, not the boot state.
   *
   * systemd hashes the PIN before the chip sees it, so an owner's long password
   * is a fine PIN. Nothing here touches the recovery-key keyslot, which is the
   * invariant the whole design rests on: every failure leaves a vault that
   * still opens with the key the owner already has.
   */
  async enrollTpm({ device, key, pin = null }) {
    if (!this.hasTpmDevice()) return { enrolled: false, reason: 'no-tpm' };
    // The recovery key goes in as a file rather than as `$PASSWORD`, for the
    // same reason the backup engine stages its keys: /proc is root-only, so
    // neither was a way in from outside, but a key that opens everything should
    // not sit in an environment at all. The PIN has no file form —
    // systemd-cryptenroll takes it only as `$NEWPIN` — so it stays where it is
    // and the process lives for one command.
    const unlockFile = path.join(AGENT_SECRET_DIR, `enroll-${process.pid}.key`);
    const args = ['--wipe-slot=tpm2', `--unlock-key-file=${unlockFile}`, '--tpm2-device=auto', `--tpm2-pcrs=${TPM_PCRS}`];
    if (pin) args.push('--tpm2-with-pin=yes');
    try {
      await stagingDir();
      await fsp.writeFile(unlockFile, key, { mode: 0o600 });
      await run('systemd-cryptenroll', [...args, device], {
        env: pin ? { ...process.env, NEWPIN: pin } : undefined,
        mask: pin ? [key, pin] : [key],
        timeoutMs: 120_000,
      });
      return { enrolled: true, pcrs: [Number(TPM_PCRS)], withPin: Boolean(pin) };
    } catch (error) {
      return { detail: describeFailure(error, 'systemd-cryptenroll'), enrolled: false, reason: 'tpm-refused' };
    } finally {
      try { await fsp.rm(unlockFile, { force: true }); } catch {}
    }
  }

  // Takes the chip out of the picture, leaving the recovery-key keyslot alone.
  // Called when an enrollment failed: a chip slot that may still hold the
  // password an owner has just replaced is the one state worth undoing, because
  // the machine would go on opening itself for the old secret. With no chip
  // slot the machine asks for the recovery key, which is always the safe way to
  // fail.
  async wipeTpmEnrollment({ device }) {
    if (!this.hasTpmDevice()) return { wiped: false, reason: 'no-tpm' };
    try {
      await run('systemd-cryptenroll', ['--wipe-slot=tpm2', device], { timeoutMs: 120_000 });
      return { wiped: true };
    } catch {
      return { wiped: false, reason: 'wipe-failed' };
    }
  }

  async makeFilesystem({ device, label }) {
    try {
      // -m 0: the 5% root reserve exists to keep a full root filesystem
      // bootable. This one holds app data and is not the root filesystem, so
      // the reserve is a few gigabytes of an owner's disk spent on nothing.
      await run('mkfs.ext4', ['-q', '-m', '0', '-L', label, device]);
    } catch (error) {
      throw fail('VAULT_FORMAT_FAILED', 'MOS could not create the filesystem inside the vault.', error);
    }
  }

  async ensureDirectory({ mode, path: directory }) {
    await fsp.mkdir(directory, { mode, recursive: true });
    try { await fsp.chmod(directory, mode); } catch {}
  }

  async isMounted(target) {
    return Boolean(await quiet('findmnt', ['-rno', 'TARGET', target]));
  }

  async mapperExists(mapper) {
    return fs.existsSync(`/dev/mapper/${mapper}`);
  }

  async mount({ device, mountpoint }) {
    await fsp.mkdir(mountpoint, { mode: 0o700, recursive: true });
    if (await this.isMounted(mountpoint)) return;
    try {
      await run('mount', ['-o', 'noatime', device, mountpoint]);
    } catch (error) {
      throw fail('VAULT_MOUNT_FAILED', 'MOS could not mount the vault.', error);
    }
  }

  async bind({ source, target }) {
    if (await this.isMounted(target)) return;
    try {
      await run('mount', ['--bind', source, target]);
    } catch (error) {
      throw fail('VAULT_MOUNT_FAILED', `MOS could not attach ${target} to the vault.`, error);
    }
  }

  /**
   * The one irreversible step, run once, on a machine that has never had an
   * owner: at this point `/var/lib/docker` holds the images baked into the
   * published image and nothing else, and `/var/lib/mos` is empty. That is why
   * deleting the originals afterwards is safe to do — there is no owner data on
   * the plaintext partition yet to leave recoverable traces of.
   *
   * `cp -a` rather than `mv` because Docker's overlay2 store is built out of
   * hard links, and a copy that breaks them silently multiplies the image store
   * and can leave layers that no longer share their parents.
   */
  async moveIntoVault({ mode, source, target }) {
    await this.ensureDirectory({ mode, path: target });
    if (!fs.existsSync(source)) {
      await this.ensureDirectory({ mode, path: source });
      return;
    }

    const entries = await fsp.readdir(source);
    if (entries.length === 0) return;

    try {
      await run('cp', ['-a', '--preserve=all', `${source}/.`, `${target}/`]);
    } catch (error) {
      throw fail('VAULT_MOVE_FAILED', `MOS could not move ${source} into the vault.`, error);
    }

    const before = Number((await quiet('du', ['-sb', source])).split(/\s+/u)[0] || 0);
    const after = Number((await quiet('du', ['-sb', target])).split(/\s+/u)[0] || 0);
    if (before > 0 && after < before * 0.99) {
      throw fail('VAULT_MOVE_FAILED', `MOS copied ${source} into the vault but the copy is smaller than the original, so nothing was removed.`);
    }

    for (const entry of entries) {
      await fsp.rm(path.join(source, entry), { force: true, recursive: true });
    }
  }

  /**
   * Swap lives in the vault because it holds pages of decrypted app data, and on
   * the plaintext partition that is a copy of what the vault protects lying next
   * to it. It is never written to /etc/fstab: a swapfile inside a locked vault
   * is a boot failure waiting for the first time the TPM says no.
   */
  async enableSwapfile({ path: swapfile }) {
    if (!fs.existsSync(swapfile)) {
      // Sized against what is actually free, because a swapfile that fills the
      // filesystem is worse than no swapfile — the first version of this rule,
      // in the script this replaces, filled a root partition to 100% and served
      // traffic for a few minutes before answering 502.
      let free = 0;
      try {
        const stats = await fsp.statfs(path.dirname(swapfile));
        free = Number(stats.bsize) * Number(stats.bavail);
      } catch {}
      const bytes = Math.min(SWAPFILE_BYTES, free - SWAPFILE_HEADROOM_BYTES);
      if (bytes < SWAPFILE_FLOOR_BYTES) return;

      try {
        await run('fallocate', ['-l', String(bytes), swapfile]);
        await fsp.chmod(swapfile, 0o600);
        await run('mkswap', [swapfile]);
      } catch {
        try { await fsp.rm(swapfile, { force: true }); } catch {}
        return;
      }
    }
    await quiet('swapon', [swapfile]);
  }

  // The key this machine currently opens its own vault with, which is the same
  // file the backup agent uses as its repository password. Read rather than
  // held, because the only moment it is needed is a rekey.
  async readOwnKey() {
    return this.keys.readKey();
  }

  /**
   * Points the vault at a different key, leaving the data alone.
   *
   * A passphrase never encrypts anything here. LUKS2 encrypts the disk with one
   * random master key and stores copies of it in keyslots, each wrapped by a
   * different passphrase — the recovery key is one, the TPM enrollment is
   * another. So this rewraps a copy inside the header: instant on a 4 TB disk,
   * no data rewritten, no half-converted state to survive a power cut, and the
   * TPM slot untouched so the machine still opens itself.
   *
   * The order is the safety. The new key is added and proven to open the device
   * before the old one is removed, so every failure leaves a vault that still
   * opens with the key its owner already has.
   */
  async rekey({ device, fromKey, toKey }) {
    // cryptsetup takes the key being added as a file rather than on stdin,
    // which is already holding the key that authorises it. /run is tmpfs, so
    // this never reaches a disk — least of all the plaintext one next to the
    // vault it would be the key to.
    const keyFile = path.join(AGENT_SECRET_DIR, `rekey-${process.pid}.key`);
    try {
      await stagingDir();
      await fsp.writeFile(keyFile, toKey, { mode: 0o600 });

      try {
        await run('cryptsetup', ['luksAddKey', '--batch-mode', '--key-file', '-', device, keyFile], {
          input: fromKey,
          mask: [fromKey, toKey],
        });
      } catch (error) {
        if (error?.exitCode === CRYPTSETUP_NO_PERMISSION) {
          return { ok: false, reason: 'current-key-rejected' };
        }
        throw fail('VAULT_REKEY_FAILED', 'MOS could not add the new key to the vault.', error);
      }

      try {
        await run('cryptsetup', ['open', '--test-passphrase', '--key-file', '-', device], { input: toKey, mask: [toKey] });
      } catch (error) {
        // The added slot cannot be left behind: a key that half-works is worse
        // than one that never went in, because nothing afterwards would report
        // it. Removed with the key that was just added, which is the only one
        // guaranteed to match that slot.
        try { await run('cryptsetup', ['luksRemoveKey', '--batch-mode', '--key-file', '-', device], { input: toKey, mask: [toKey] }); } catch {}
        throw fail('VAULT_REKEY_FAILED', 'MOS added the new key to the vault but it did not open it, so nothing was changed.', error);
      }

      try {
        await run('cryptsetup', ['luksRemoveKey', '--batch-mode', '--key-file', '-', device], { input: fromKey, mask: [fromKey] });
      } catch (error) {
        // Both keys open the vault at this point. That is safe — it is the
        // state the owner would be in either way — but it is not what was
        // asked for, so it is reported rather than swallowed.
        throw fail('VAULT_REKEY_INCOMPLETE', 'The new key now opens this vault, but the old one could not be removed.', error);
      }

      return { ok: true };
    } finally {
      try { await fsp.rm(keyFile, { force: true }); } catch {}
    }
  }

  /**
   * Hands the key to the backup agent by writing it where the agent already
   * looks for one. The agent generates its own on first start if that file is
   * absent, so writing it here — before the agent has ever run — is what makes
   * the disk key and the backup key the same key, with no change to the backup
   * agent and no second secret for the owner to keep.
   */
  async publishRecoveryKey({ key }) {
    if (this.keys.readKey()) return { published: false, reason: 'already-present' };
    this.keys.writeKey(key);
    return { fingerprint: fingerprint(key), published: true };
  }

  /**
   * Starts what was held back while the vault was locked. The list is asked of
   * systemd rather than kept here, so a unit that gains
   * `Requires=mos-vault.service` is started after an unlock without anyone
   * remembering to add it to a second list that would quietly drift.
   */
  async startDependents() {
    const output = await quiet('systemctl', ['list-dependencies', '--reverse', '--plain', '--no-pager', 'mos-vault.service']);
    const units = output.split('\n')
      .map((line) => line.replace(/[^A-Za-z0-9@._-]/gu, '').trim())
      .filter((line) => line.endsWith('.service') || line.endsWith('.socket'))
      .filter((line) => line !== 'mos-vault.service');

    const started = [];
    for (const unit of units) {
      try {
        await run('systemctl', ['start', unit], { timeoutMs: 300_000 });
        started.push(unit);
      } catch {}
    }
    // Caddy stays up while the vault is locked so it can serve the page that
    // asks for the key, which means it started without the secrets that live in
    // the vault. Now that they are there, it gets to read them.
    await quiet('systemctl', ['try-restart', 'caddy.service']);
    return started;
  }
}

module.exports = { LUKS_PARTITION_TYPE, SystemVaultAdapter, TPM_PCRS, VAULT_ARMED_PATH };
