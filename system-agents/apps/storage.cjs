const fs = require('node:fs');
const path = require('node:path');
const { BACKUPS_DIR, FILES_DIR, STORAGE_MOUNT_ROOT } = require('../../shared/storage-contract.cjs');
const { LSBLK_ARGS, directorySize, holdsSystem, isWholeDiskFilesystem } = require('../lib/block-devices.cjs');

// Drives that hold app folders, found by filesystem UUID and mounted under MOS's
// own root. The app sees only its folder; where that lives is known here alone.

const STORAGE_DRIVE_LABEL = 'mos.storage-drive';
// lsblk's filesystem name, and the kernel driver that mounts it. These carry no
// Unix permissions, so MOS sets them at mount and every container can read.
const STORAGE_FILESYSTEMS = new Map([['exfat', 'exfat'], ['ntfs', 'ntfs3'], ['vfat', 'vfat']]);
// Files 0644 and folders 0755 owned by root: readable by any container user,
// written only by MOS. A later writer app gets a group here, not a chmod.
const MOUNT_OPTIONS = 'uid=0,gid=0,fmask=0133,dmask=0022,noatime,nodev,nosuid,noexec';
const UUID_PATTERN = /^[A-Za-z0-9-]{4,64}$/u;
// ntfs3 refuses read-write on a volume Windows would check first, and says why only
// in the kernel log. Never answered with its `force` option: that writes to a volume
// in exactly the state where writing can corrupt it.
const NTFS_NEEDS_CHECK = /volume is dirty|failed to replay log file/u;
const READ_ONLY_REASON = 'Your apps can read this drive, but nothing can be saved to it until it is checked. It was unplugged or lost power without being ejected.';
const WINDOWS_CHECK = 'Plug it into a Windows computer, open the drive\'s Properties, choose Tools and then Check, and eject it before plugging it back in here.';
const CHECK_FAILED_REASON = `The quick check could not repair this drive, so your apps can still only read it. ${WINDOWS_CHECK}`;
const UNREADABLE_REASON = `This drive could not be opened, even to read it. ${WINDOWS_CHECK}`;
const BUSY_REASON = 'Something on the server is still using this drive, so it was not ejected. Try again in a minute.';
const NOT_OPENED_REASON = 'MOS could not open this drive. Unplug it and plug it back in.';
const ONE_GIB = 1024 * 1024 * 1024;
// A process holds the claims lock for one synchronous read and write, so a lock this
// old belongs to one that died holding it.
const STALE_LOCK_MS = 5_000;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

class StorageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'APP_STORAGE_UNAVAILABLE';
    this.statusCode = 409;
  }
}

function driveMountPath(driveId, root = STORAGE_MOUNT_ROOT) {
  if (!UUID_PATTERN.test(String(driveId))) throw new StorageError('That drive id is not valid.');
  return path.posix.join(root, driveId);
}

function appFolderPath(driveId, packageId, name, root = STORAGE_MOUNT_ROOT) {
  return path.posix.join(driveMountPath(driveId, root), FILES_DIR, 'apps', packageId, name);
}

function unusableReason(fileSystem) {
  return `This drive is formatted as ${fileSystem}. App files go on drives formatted as exFAT, NTFS or FAT32, which open on any computer.`;
}

// Every filesystem lsblk reports off the system disk, as a drive an owner could
// pick. Partitions too small or shaped like a boot partition are not drives.
function storageCandidates(blockdevices = []) {
  const drives = [];
  function visit(device, driveModel = null) {
    if (device.type === 'disk' && holdsSystem(device)) return;
    const fileSystem = String(device.fstype || '').toLowerCase();
    const sizeBytes = Number(device.size) || null;
    const usable = STORAGE_FILESYSTEMS.has(fileSystem);
    // A disk image attached as a loop device counts only when it could hold app
    // files, so the read-only images snaps mount never show up as drives.
    const isFilesystem = (device.type === 'part' || isWholeDiskFilesystem(device) || (device.type === 'loop' && usable)) && fileSystem && device.uuid;
    const bootShaped = String(device.label || '').toLowerCase() === 'efi' || (fileSystem === 'vfat' && sizeBytes && sizeBytes < ONE_GIB);
    if (isFilesystem && !bootShaped && !holdsSystem(device)) {
      drives.push({
        devicePath: device.path || `/dev/${device.name}`,
        fileSystem,
        id: device.uuid,
        label: device.label || device.model || driveModel || device.name,
        mountpoints: (device.mountpoints || []).filter(Boolean),
        reason: usable ? null : unusableReason(fileSystem),
        sizeBytes,
        usable,
      });
    }
    for (const child of device.children || []) visit(child, device.model || driveModel);
  }
  for (const device of blockdevices) visit(device);
  return drives;
}

// The five states an owner is shown, or `available` for a drive MOS keeps nothing on.
function driveState({ claim, connected, mount }) {
  if (claim?.ejected) return 'ejected';
  if (!connected) return 'away';
  if (mount) return mount.readOnly ? 'read-only' : 'ready';
  return claim ? 'failed' : 'available';
}

function stateReason(state, claim) {
  if (state === 'read-only') return claim?.problem?.reason || READ_ONLY_REASON;
  if (state === 'failed') return claim?.problem?.reason || NOT_OPENED_REASON;
  if (state === 'away') return 'This drive is not connected.';
  if (state === 'ejected') return 'You ejected this drive. Plug it back in to use it again.';
  return null;
}

class AppStorage {
  constructor({ claimsPath, execute, executeCapture, mountRoot = STORAGE_MOUNT_ROOT }) {
    this.claimsPath = claimsPath;
    this.execute = execute;
    this.executeCapture = executeCapture;
    this.mountRoot = mountRoot;
  }

  readClaims() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.claimsPath, 'utf8'));
      return parsed && typeof parsed.drives === 'object' ? parsed : { drives: {}, version: 1 };
    } catch {
      return { drives: {}, version: 1 };
    }
  }

  // The attach unit udev starts writes here too, in a process of its own.
  updateClaims(change) {
    const lock = `${this.claimsPath}.lock`;
    fs.mkdirSync(path.dirname(this.claimsPath), { recursive: true });
    for (;;) {
      try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { force: true }); } catch {}
        Atomics.wait(LOCK_WAIT, 0, 0, 20);
      }
    }
    try {
      const claims = this.readClaims();
      change(claims.drives);
      const temporary = `${this.claimsPath}.${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(claims, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.claimsPath);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  recordDrive(driveId, fields) {
    this.updateClaims((drives) => {
      if (!drives[driveId]) return;
      const next = { ...drives[driveId], ...fields };
      for (const [key, value] of Object.entries(fields)) if (value === undefined) delete next[key];
      drives[driveId] = next;
    });
  }

  async candidates() {
    const output = await this.executeCapture('lsblk', [...LSBLK_ARGS], { timeoutMs: 10_000 }).catch(() => null);
    try { return storageCandidates(JSON.parse(output).blockdevices); } catch { return []; }
  }

  async mountOn(target) {
    const output = await this.executeCapture('findmnt', ['--raw', '--noheadings', '--output', 'SOURCE,OPTIONS', '--mountpoint', target], { timeoutMs: 10_000 }).catch(() => '');
    const [source, options = ''] = String(output || '').trim().split('\n')[0].split(' ');
    return source ? { readOnly: options.split(',').includes('ro'), source } : null;
  }

  // Connected drives, plus remembered ones that are away. A remembered drive no app
  // claims any more is still mounted while connected, for the folders left on it.
  async drives() {
    const claims = this.readClaims().drives;
    const listed = [];
    for (const drive of await this.candidates()) {
      const target = driveMountPath(drive.id, this.mountRoot);
      const found = await this.mountOn(target);
      const mount = found?.source === drive.devicePath ? found : null;
      const claim = claims[drive.id];
      const state = driveState({ claim, connected: true, mount });
      const roots = mount ? [target, ...drive.mountpoints] : drive.mountpoints;
      listed.push({
        apps: claim?.apps || [],
        availableBytes: mount ? availableBytes(target) : null,
        connected: true,
        detail: claim?.problem?.detail || null,
        fileSystem: drive.fileSystem,
        holdsBackups: roots.some((root) => fs.existsSync(path.join(root, BACKUPS_DIR))),
        id: drive.id,
        label: drive.label,
        reason: drive.reason || stateReason(state, claim),
        sizeBytes: drive.sizeBytes,
        state,
        usable: drive.usable && ['available', 'ready'].includes(state),
      });
    }
    for (const [id, claim] of Object.entries(claims)) {
      if (listed.some((drive) => drive.id === id) || !claim.apps?.length) continue;
      const state = driveState({ claim, connected: false });
      listed.push({ apps: claim.apps, availableBytes: null, connected: false, detail: null, fileSystem: claim.fileSystem || null, holdsBackups: false, id, label: claim.label || id, reason: stateReason(state, claim), sizeBytes: null, state, usable: false });
    }
    return listed;
  }

  // Every app folder on the drives mounted right now, with its size, including
  // the folders of apps that were uninstalled, which nothing else would show.
  async folders() {
    const listed = [];
    for (const driveId of readDirectoryNames(this.mountRoot)) {
      const target = driveMountPath(driveId, this.mountRoot);
      if (!await this.mountOn(target)) continue;
      const appsDir = path.join(target, FILES_DIR, 'apps');
      for (const app of readDirectoryNames(appsDir)) {
        for (const name of readDirectoryNames(path.join(appsDir, app))) {
          listed.push({ app, bytes: directorySize(path.join(appsDir, app, name)), driveId, name });
        }
      }
    }
    return listed;
  }

  async connectedDrive(driveId) {
    const drive = (await this.candidates()).find((item) => item.id === driveId);
    if (!drive) throw new StorageError('The drive that holds this app\'s folders is not connected.');
    if (!drive.usable) throw new StorageError(drive.reason);
    return drive;
  }

  // Replaces a mount a pulled drive left behind. A drive Windows would check first
  // opens read-only, so its apps keep their files. Folders are made only after this.
  async attach(driveId) {
    const target = driveMountPath(driveId, this.mountRoot);
    const drive = await this.connectedDrive(driveId);
    const current = await this.mountOn(target);
    if (current?.source === drive.devicePath) return { drive, readOnly: current.readOnly, target };
    if (current) await this.execute('umount', ['--lazy', target], { timeoutMs: 30_000 });
    fs.mkdirSync(target, { recursive: true });
    const logBefore = drive.fileSystem === 'ntfs' ? await this.kernelLog() : '';
    const mount = (options) => this.execute('mount', ['-t', STORAGE_FILESYSTEMS.get(drive.fileSystem), '-o', options, drive.devicePath, target], { timeoutMs: 60_000 });
    let refusal = null;
    try {
      await mount(MOUNT_OPTIONS);
    } catch (error) {
      refusal = drive.fileSystem === 'ntfs' ? await this.kernelRefusal(drive, logBefore) : null;
      if (!refusal) {
        this.recordDrive(driveId, { ejected: undefined, problem: { detail: error.message, reason: NOT_OPENED_REASON } });
        throw error;
      }
      await mount(`ro,${MOUNT_OPTIONS}`).catch(() => {
        this.recordDrive(driveId, { ejected: undefined, problem: { detail: refusal, reason: UNREADABLE_REASON } });
        throw new StorageError(UNREADABLE_REASON);
      });
    }
    const mounted = await this.mountOn(target);
    if (mounted?.source !== drive.devicePath) throw new StorageError('The drive could not be opened.');
    this.recordDrive(driveId, { ejected: undefined, problem: refusal ? { detail: refusal, reason: READ_ONLY_REASON } : undefined });
    return { drive, readOnly: mounted.readOnly, target };
  }

  kernelLog() {
    return this.executeCapture('dmesg', [], { timeoutMs: 10_000 }).then(String, () => '');
  }

  // Why ntfs3 refused to write, which `mount` itself reports as "wrong fs type". Only
  // lines logged after `logBefore` count, because the next drive reuses a device name.
  async kernelRefusal(drive, logBefore) {
    const log = await this.kernelLog();
    const marker = logBefore.trimEnd().split('\n').pop();
    const markerAt = marker ? log.lastIndexOf(marker) : -1;
    const sinceMount = markerAt < 0 ? log : log.slice(markerAt + marker.length);
    const prefix = `ntfs3: ${path.posix.basename(drive.devicePath)}:`;
    const lastWord = sinceMount.split('\n').filter((line) => line.includes(prefix)).pop() || '';
    return NTFS_NEEDS_CHECK.test(lastWord) ? lastWord.trim() : null;
  }

  // NTFS is marked clean only when its last mount goes, and a lazy unmount reports
  // success while the drive is still in use, so every mount goes and none lazily.
  async closeDrive(drive) {
    const target = driveMountPath(drive.id, this.mountRoot);
    const points = [...new Set([...(await this.mountOn(target) ? [target] : []), ...drive.mountpoints])];
    try {
      for (const point of points) await this.execute('umount', [point], { timeoutMs: 60_000 });
    } catch {
      throw new StorageError(BUSY_REASON);
    }
  }

  async eject(driveId) {
    const drive = await this.connectedDrive(driveId);
    await this.closeDrive(drive);
    this.recordDrive(driveId, { ejected: true, problem: undefined });
  }

  // ntfsfix's quick repair, then read-write again. It clears what an unplugged or
  // powered-off drive leaves behind, not real damage, which only Windows checks.
  async check(driveId) {
    const drive = await this.connectedDrive(driveId);
    if (drive.fileSystem !== 'ntfs') throw new StorageError('Only drives formatted as NTFS need this check.');
    await this.closeDrive(drive);
    const repaired = await this.execute('ntfsfix', ['--clear-dirty', drive.devicePath], { timeoutMs: 10 * 60_000 }).then(() => true, (error) => error);
    const { readOnly } = await this.attach(driveId);
    if (repaired !== true || readOnly) {
      this.recordDrive(driveId, { problem: { detail: repaired === true ? 'ntfsfix finished, but the drive still needs a check.' : String(repaired.message || repaired), reason: CHECK_FAILED_REASON } });
      throw new StorageError(CHECK_FAILED_REASON);
    }
  }

  async prepareFolders(packageId, folders) {
    const binds = [];
    const byDrive = new Map();
    for (const folder of folders) byDrive.set(folder.drive, [...(byDrive.get(folder.drive) || []), folder]);
    for (const [driveId, onDrive] of byDrive) {
      const { drive, target } = await this.attach(driveId);
      this.claim(driveId, packageId, drive);
      let created = false;
      for (const folder of onDrive) {
        const source = appFolderPath(driveId, packageId, folder.name, this.mountRoot);
        try {
          created = Boolean(fs.mkdirSync(source, { recursive: true })) || created;
        } catch (error) {
          throw error.code === 'EROFS' ? new StorageError(READ_ONLY_REASON) : error;
        }
        binds.push({ drive: driveId, source, target: folder.path });
      }
      // ntfs3 marks a drive dirty at its first write and clean again when flushed, so
      // the folders just made never leave a drive unplugged later needing a check.
      if (created) await this.execute('sync', ['--file-system', target], { timeoutMs: 60_000 });
    }
    return binds;
  }

  claim(driveId, packageId, drive) {
    this.updateClaims((drives) => {
      const current = drives[driveId] || { apps: [] };
      const apps = current.apps.includes(packageId) ? current.apps : [...current.apps, packageId].sort();
      drives[driveId] = { ...current, apps, fileSystem: drive.fileSystem, label: drive.label };
    });
  }

  // An app lets go of every drive it no longer mounts; its folders stay on them, and
  // each drive stays remembered so they are still there to see after a restart.
  release(packageId, keptDrives = []) {
    const letGo = (driveId, claim) => !keptDrives.includes(driveId) && claim.apps?.includes(packageId);
    if (!Object.entries(this.readClaims().drives).some(([driveId, claim]) => letGo(driveId, claim))) return;
    this.updateClaims((drives) => {
      for (const [driveId, claim] of Object.entries(drives)) {
        if (letGo(driveId, claim)) claim.apps = claim.apps.filter((app) => app !== packageId);
      }
    });
  }

  isRemembered(driveId) {
    return Boolean(this.readClaims().drives[driveId]);
  }
}

function readDirectoryNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function availableBytes(dir) {
  try { const stat = fs.statfsSync(dir); return stat.bavail * stat.bsize; } catch { return null; }
}

module.exports = {
  AppStorage,
  CHECK_FAILED_REASON,
  FILES_DIR,
  MOUNT_OPTIONS,
  READ_ONLY_REASON,
  STORAGE_DRIVE_LABEL,
  STORAGE_MOUNT_ROOT,
  StorageError,
  appFolderPath,
  driveMountPath,
  storageCandidates,
};
