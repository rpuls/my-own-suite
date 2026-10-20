const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_FOLDER_FILESYSTEMS, BACKUPS_DIR, BACKUP_FILESYSTEMS, FILES_DIR, STORAGE_MOUNT_ROOT } = require('../../shared/storage-contract.cjs');
const { LSBLK_ARGS, directorySize, holdsSystem, isWholeDiskFilesystem } = require('../lib/block-devices.cjs');
const { StorageRegistry, isRememberedDrive, publicBucket } = require('../lib/storage-registry.cjs');

// The drives side of the storage module: every drive plugged in, found by its
// filesystem UUID and mounted under MOS's own root when something is kept on it.
// An app sees only its folder; where that lives is known here alone.

const STORAGE_DRIVE_LABEL = 'mos.storage-drive';
// lsblk's filesystem name, and the kernel driver that mounts it.
const KERNEL_DRIVERS = new Map([['exfat', 'exfat'], ['ntfs', 'ntfs3'], ['vfat', 'vfat'], ['ext4', 'ext4']]);
// Files 0644 and folders 0755 owned by root: readable by any container user,
// written only by MOS. A later writer app gets a group here, not a chmod.
const MOUNT_OPTIONS = 'uid=0,gid=0,fmask=0133,dmask=0022,noatime,nodev,nosuid,noexec';
// ext4 keeps its own owners and modes, so it takes only the safety options.
const LINUX_MOUNT_OPTIONS = 'noatime,nodev,nosuid,noexec';
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
const EFI_PARTITION_TYPE = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b';
// The file the image builder writes on the stick's EFI partition, which is how the
// stick knows itself. A disk this does not prove is never offered for formatting.
const INSTALLER_IMAGE_ID = 'mos-image.json';
const FORMATTED_LABEL = 'MOS STORAGE';

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

function formatReason(fileSystem) {
  if (APP_FOLDER_FILESYSTEMS.includes(fileSystem)) return null;
  if (BACKUP_FILESYSTEMS.includes(fileSystem)) return `This drive is formatted as ${fileSystem}, so it can hold backups but not app files. App files go on drives formatted as exFAT, NTFS or FAT32, which open on any computer.`;
  return `This drive is formatted as ${fileSystem}, which MOS cannot use for app files or backups. Drives formatted as exFAT, NTFS or FAT32 work for both.`;
}

function isRemovable(device, disk) {
  return [device.rm, disk?.rm].some((value) => value === true || value === 1 || value === '1');
}

function transportOf(device, disk) {
  const tran = String(device.tran || disk?.tran || '').toLowerCase();
  const removable = isRemovable(device, disk);
  if (tran === 'usb') return 'usb';
  if (device.type === 'loop') return 'image';
  return removable ? 'removable' : tran || 'internal';
}

// Shaped like the image the installer writes: an EFI partition and a Linux system
// partition on a disk that boots from a port. Proven by reading the stick itself.
function looksLikeInstallerStick(disk) {
  if (disk.type !== 'disk' || holdsSystem(disk)) return false;
  if (transportOf(disk) !== 'usb' && transportOf(disk) !== 'removable') return false;
  const parts = disk.children || [];
  const efi = parts.filter((part) => String(part.parttype || '').toLowerCase() === EFI_PARTITION_TYPE && part.fstype === 'vfat');
  return efi.length === 1 && parts.some((part) => part.fstype === 'ext4') && parts.every((part) => !(part.mountpoints || []).some(Boolean));
}

// Every filesystem lsblk reports off the system disk. Partitions too small or shaped
// like a boot partition are not drives, and the disks in `skip` are listed elsewhere.
function storageCandidates(blockdevices = [], skip = new Set()) {
  const drives = [];
  function visit(device, disk = null) {
    if (device.type === 'disk' && (holdsSystem(device) || skip.has(device.path || `/dev/${device.name}`))) return;
    const fileSystem = String(device.fstype || '').toLowerCase();
    const sizeBytes = Number(device.size) || null;
    const reason = fileSystem ? formatReason(fileSystem) : null;
    // A disk image attached as a loop device counts only when it could hold app
    // files, so the read-only images snaps mount never show up as drives.
    const isFilesystem = (device.type === 'part' || isWholeDiskFilesystem(device) || (device.type === 'loop' && APP_FOLDER_FILESYSTEMS.includes(fileSystem))) && fileSystem && device.uuid;
    const bootShaped = String(device.label || '').toLowerCase() === 'efi' || (fileSystem === 'vfat' && sizeBytes && sizeBytes < ONE_GIB);
    if (isFilesystem && !bootShaped && !holdsSystem(device)) {
      drives.push({
        devicePath: device.path || `/dev/${device.name}`,
        fileSystem,
        holdsAppFoldersFormat: APP_FOLDER_FILESYSTEMS.includes(fileSystem),
        holdsBackupsFormat: BACKUP_FILESYSTEMS.includes(fileSystem),
        id: device.uuid,
        label: device.label || device.model || disk?.model || device.name,
        model: String(disk?.model || device.model || '').trim() || null,
        mountpoints: (device.mountpoints || []).filter(Boolean),
        reason,
        removable: isRemovable(device, disk),
        sizeBytes,
        transport: transportOf(device, disk),
      });
    }
    for (const child of device.children || []) visit(child, device.type === 'disk' ? device : disk);
  }
  for (const device of blockdevices) visit(device);
  return drives;
}

// The five states an owner is shown, or `available` for a drive MOS keeps nothing on.
function driveState({ claim, connected, mount }) {
  if (claim?.ejected) return 'ejected';
  if (!connected) return 'away';
  if (mount) return mount.readOnly ? 'read-only' : 'ready';
  return isRememberedDrive(claim) ? 'failed' : 'available';
}

function stateReason(state, claim) {
  if (state === 'read-only') return claim?.problem?.reason || READ_ONLY_REASON;
  if (state === 'failed') return claim?.problem?.reason || NOT_OPENED_REASON;
  if (state === 'away') return 'This drive is not connected.';
  if (state === 'ejected') return 'You ejected this drive. Plug it back in to use it again.';
  return null;
}

class AppStorage {
  constructor({ execute, executeCapture, mountRoot = STORAGE_MOUNT_ROOT, registryPath }) {
    this.registry = new StorageRegistry({ registryPath });
    this.execute = execute;
    this.executeCapture = executeCapture;
    this.mountRoot = mountRoot;
    this.provenSticks = new Map();
  }

  async blockDevices() {
    const output = await this.executeCapture('lsblk', [...LSBLK_ARGS], { timeoutMs: 10_000 }).catch(() => null);
    try { return JSON.parse(output).blockdevices || []; } catch { return []; }
  }

  async candidates() {
    const devices = await this.blockDevices();
    const sticks = await this.installerSticks(devices);
    return storageCandidates(devices, new Set(sticks.map((stick) => stick.devicePath)));
  }

  async mountOn(target) {
    const output = await this.executeCapture('findmnt', ['--raw', '--noheadings', '--output', 'SOURCE,OPTIONS', '--mountpoint', target], { timeoutMs: 10_000 }).catch(() => '');
    const [source, options = ''] = String(output || '').trim().split('\n')[0].split(' ');
    return source ? { readOnly: options.split(',').includes('ro'), source } : null;
  }

  // Every drive plugged in, plus remembered ones that are away. A remembered drive
  // nothing claims any more is still mounted while connected, for what is left on it.
  async drives() {
    const claims = this.registry.read().drives;
    const listed = [];
    for (const drive of await this.candidates()) {
      const target = driveMountPath(drive.id, this.mountRoot);
      const found = await this.mountOn(target);
      const mount = found?.source === drive.devicePath ? found : null;
      const claim = claims[drive.id];
      const state = driveState({ claim, connected: true, mount });
      const roots = mount ? [target, ...drive.mountpoints] : drive.mountpoints;
      const open = ['available', 'ready'].includes(state);
      listed.push({
        apps: claim?.apps || [],
        availableBytes: mount ? availableBytes(target) : drive.mountpoints.length ? availableBytes(drive.mountpoints[0]) : null,
        backups: claim?.backups === true,
        connected: true,
        detail: claim?.problem?.detail || null,
        devicePath: drive.devicePath,
        fileSystem: drive.fileSystem,
        holdsAppFoldersFormat: drive.holdsAppFoldersFormat,
        holdsBackups: roots.some((root) => fs.existsSync(path.join(root, BACKUPS_DIR))),
        holdsBackupsFormat: drive.holdsBackupsFormat,
        id: drive.id,
        label: drive.label,
        model: drive.model,
        mountPath: mount ? target : null,
        name: claim?.name || null,
        reason: drive.reason || stateReason(state, claim),
        removable: drive.removable,
        sizeBytes: drive.sizeBytes,
        state,
        transport: drive.transport,
        usable: drive.holdsAppFoldersFormat && open,
        usableForBackups: drive.holdsBackupsFormat && open,
      });
    }
    for (const [id, claim] of Object.entries(claims)) {
      if (listed.some((drive) => drive.id === id) || !(claim.apps?.length || claim.backups)) continue;
      const state = driveState({ claim, connected: false });
      listed.push({ apps: claim.apps || [], availableBytes: null, backups: claim.backups === true, connected: false, detail: null, devicePath: null, fileSystem: claim.fileSystem || null, holdsAppFoldersFormat: APP_FOLDER_FILESYSTEMS.includes(claim.fileSystem), holdsBackups: false, holdsBackupsFormat: BACKUP_FILESYSTEMS.includes(claim.fileSystem), id, label: claim.label || id, model: claim.model || null, mountPath: null, name: claim.name || null, reason: stateReason(state, claim), sizeBytes: claim.sizeBytes || null, state, transport: claim.transport || null, usable: false, usableForBackups: false });
    }
    return listed;
  }

  // The disk MOS runs from, which holds every app's own data.
  // The disk MOS runs from, as the owner needs it: what MOS itself takes, what the
  // apps and their data take, and what is left for them. On a machine with a vault
  // the apps live there, so the system partition's own free space is not theirs.
  async systemDrive() {
    const devices = await this.blockDevices();
    const disk = devices.find((device) => device.type === 'disk' && holdsSystem(device));
    const spaces = systemSpaces(disk, (point) => {
      try { const stat = fs.statfsSync(point); return { availableBytes: stat.bavail * stat.bsize, sizeBytes: stat.blocks * stat.bsize }; } catch { return null; }
    });
    const system = spaces.find((space) => space.role === 'system');
    const apps = spaces.filter((space) => space.role === 'apps');
    const sum = (list, key) => list.reduce((total, space) => total + space[key], 0);
    const appsBytes = apps.length ? sum(apps, 'sizeBytes') - sum(apps, 'availableBytes') : 0;
    return {
      appsBytes,
      availableBytes: apps.length ? sum(apps, 'availableBytes') : system?.availableBytes ?? null,
      encrypted: JSON.stringify(disk || {}).includes('"crypto_LUKS"'),
      model: String(disk?.model || '').trim() || null,
      sizeBytes: Number(disk?.size) || null,
      systemBytes: system ? system.sizeBytes - system.availableBytes : null,
      usableBytes: spaces.length ? sum(spaces, 'sizeBytes') : null,
    };
  }

  async inventory() {
    const devices = await this.blockDevices();
    const sticks = await this.installerSticks(devices);
    return {
      buckets: this.registry.bucketList().map(publicBucket),
      drives: await this.drives(),
      installerSticks: sticks.map(({ devicePath, model, sizeBytes }) => ({ devicePath, model, sizeBytes })),
      system: await this.systemDrive(),
    };
  }

  // A stick is proven once by its own image file and remembered by the EFI
  // partition's identity, so the page's polling does not mount it every minute.
  async installerSticks(devices) {
    const sticks = [];
    for (const disk of devices) {
      if (!looksLikeInstallerStick(disk)) continue;
      const efi = disk.children.find((part) => String(part.parttype || '').toLowerCase() === EFI_PARTITION_TYPE);
      const key = `${efi.path}:${efi.uuid}`;
      if (!this.provenSticks.has(key)) this.provenSticks.set(key, await this.carriesInstallerImage(efi.path || `/dev/${efi.name}`));
      if (this.provenSticks.get(key)) sticks.push({ devicePath: disk.path || `/dev/${disk.name}`, model: String(disk.model || '').trim() || null, sizeBytes: Number(disk.size) || null });
    }
    return sticks;
  }

  async carriesInstallerImage(efiPath) {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-stick-'));
    try {
      await this.execute('mount', ['-t', 'vfat', '-o', 'ro,nodev,nosuid,noexec', efiPath, probe], { timeoutMs: 30_000 });
    } catch {
      fs.rmSync(probe, { force: true, recursive: true });
      return false;
    }
    try {
      return Boolean(JSON.parse(fs.readFileSync(path.join(probe, INSTALLER_IMAGE_ID), 'utf8')));
    } catch {
      return false;
    } finally {
      await this.execute('umount', [probe], { timeoutMs: 30_000 }).catch(() => {});
      fs.rmSync(probe, { force: true, recursive: true });
    }
  }

  // Erases the install stick into one exFAT drive that opens on any computer. Only a
  // disk proven to be the stick right now, with nothing on it mounted, is touched.
  async formatInstallerStick(devicePath) {
    const devices = await this.blockDevices();
    this.provenSticks.clear();
    const stick = (await this.installerSticks(devices)).find((item) => item.devicePath === devicePath);
    if (!stick) throw new StorageError('That is not the MOS install stick, so nothing was erased.');
    await this.execute('wipefs', ['--all', '--force', devicePath], { timeoutMs: 60_000 });
    await this.execute('sh', ['-c', `printf 'type=7\\n' | sfdisk --quiet --label dos ${devicePath}`], { timeoutMs: 60_000 });
    await this.execute('udevadm', ['settle'], { timeoutMs: 60_000 }).catch(() => {});
    const partition = (await this.blockDevices()).find((device) => (device.path || `/dev/${device.name}`) === devicePath)?.children?.[0];
    if (!partition) throw new StorageError('The stick was erased, but MOS could not make a drive on it. Unplug it and plug it back in.');
    await this.execute('mkfs.exfat', ['-L', FORMATTED_LABEL, partition.path || `/dev/${partition.name}`], { timeoutMs: 10 * 60_000 });
    await this.execute('udevadm', ['settle'], { timeoutMs: 60_000 }).catch(() => {});
  }

  // Every app folder on the drives mounted right now, with its size, including
  // the folders of apps that were uninstalled, and what the backups there take.
  async usage() {
    const folders = [];
    const backups = [];
    for (const driveId of readDirectoryNames(this.mountRoot)) {
      const target = driveMountPath(driveId, this.mountRoot);
      if (!await this.mountOn(target)) continue;
      const appsDir = path.join(target, FILES_DIR, 'apps');
      for (const app of readDirectoryNames(appsDir)) {
        for (const name of readDirectoryNames(path.join(appsDir, app))) {
          folders.push({ app, bytes: directorySize(path.join(appsDir, app, name)), driveId, name });
        }
      }
      if (fs.existsSync(path.join(target, BACKUPS_DIR))) backups.push({ bytes: directorySize(path.join(target, BACKUPS_DIR)), driveId });
    }
    return { backups, folders };
  }

  async connectedDrive(driveId) {
    const drive = (await this.candidates()).find((item) => item.id === driveId);
    if (!drive) throw new StorageError('That drive is not connected.');
    if (!drive.holdsBackupsFormat) throw new StorageError(drive.reason);
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
    const baseOptions = drive.fileSystem === 'ext4' ? LINUX_MOUNT_OPTIONS : MOUNT_OPTIONS;
    const mount = (options) => this.execute('mount', ['-t', KERNEL_DRIVERS.get(drive.fileSystem), '-o', options, drive.devicePath, target], { timeoutMs: 60_000 });
    let refusal = null;
    try {
      await mount(baseOptions);
    } catch (error) {
      refusal = drive.fileSystem === 'ntfs' ? await this.kernelRefusal(drive, logBefore) : null;
      if (!refusal) {
        this.registry.recordDrive(driveId, { ejected: undefined, problem: { detail: error.message, reason: NOT_OPENED_REASON } });
        throw error;
      }
      await mount(`ro,${baseOptions}`).catch(() => {
        this.registry.recordDrive(driveId, { ejected: undefined, problem: { detail: refusal, reason: UNREADABLE_REASON } });
        throw new StorageError(UNREADABLE_REASON);
      });
    }
    const mounted = await this.mountOn(target);
    if (mounted?.source !== drive.devicePath) throw new StorageError('The drive could not be opened.');
    this.registry.recordDrive(driveId, { ejected: undefined, problem: refusal ? { detail: refusal, reason: READ_ONLY_REASON } : undefined });
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
    this.registry.recordDrive(driveId, { ejected: true, problem: undefined });
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
      this.registry.recordDrive(driveId, { problem: { detail: repaired === true ? 'ntfsfix finished, but the drive still needs a check.' : String(repaired.message || repaired), reason: CHECK_FAILED_REASON } });
      throw new StorageError(CHECK_FAILED_REASON);
    }
  }

  async prepareFolders(packageId, folders) {
    const binds = [];
    const byDrive = new Map();
    for (const folder of folders) byDrive.set(folder.drive, [...(byDrive.get(folder.drive) || []), folder]);
    for (const [driveId, onDrive] of byDrive) {
      const candidate = await this.connectedDrive(driveId);
      if (!candidate.holdsAppFoldersFormat) throw new StorageError(candidate.reason);
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

  remember(drives, driveId, drive) {
    const current = drives[driveId] || {};
    drives[driveId] = { ...current, apps: current.apps || [], fileSystem: drive.fileSystem, label: drive.label, model: drive.model, sizeBytes: drive.sizeBytes, transport: drive.transport };
    return drives[driveId];
  }

  claim(driveId, packageId, drive) {
    this.registry.update(({ drives }) => {
      const entry = this.remember(drives, driveId, drive);
      if (!entry.apps.includes(packageId)) entry.apps = [...entry.apps, packageId].sort();
    });
  }

  // Opened for its files alone, and remembered so it opens again when plugged back in.
  async open(driveId) {
    const candidate = await this.connectedDrive(driveId);
    if (!candidate.holdsAppFoldersFormat) throw new StorageError(candidate.reason);
    const { drive, readOnly } = await this.attach(driveId);
    this.registry.update(({ drives }) => { this.remember(drives, driveId, drive); });
    return { readOnly };
  }

  // A drive kept for backups is opened here, as any drive MOS keeps things on, and
  // opened again whenever it is plugged back in; the backup agent writes into it.
  async holdBackups(driveId) {
    const { drive, readOnly } = await this.attach(driveId);
    if (readOnly) throw new StorageError(READ_ONLY_REASON);
    this.registry.update(({ drives }) => { this.remember(drives, driveId, drive).backups = true; });
  }

  releaseBackups(driveId) {
    this.registry.recordDrive(driveId, { backups: undefined });
  }

  // An app lets go of every drive it no longer mounts; its folders stay on them, and
  // each drive stays remembered so they are still there to see after a restart.
  release(packageId, keptDrives = []) {
    const letGo = (driveId, claim) => !keptDrives.includes(driveId) && claim.apps?.includes(packageId);
    if (!Object.entries(this.registry.read().drives).some(([driveId, claim]) => letGo(driveId, claim))) return;
    this.registry.update(({ drives }) => {
      for (const [driveId, claim] of Object.entries(drives)) {
        if (letGo(driveId, claim)) claim.apps = claim.apps.filter((app) => app !== packageId);
      }
    });
  }

  isRemembered(driveId) {
    return isRememberedDrive(this.registry.drive(driveId));
  }

  rename(id, name) {
    return { name: this.registry.rename(id, name) };
  }
}

// Every filesystem mounted from the system disk, once each: `/` is MOS itself, the
// rest (the vault) hold the apps. The EFI partition is neither.
function systemSpaces(disk, measure) {
  const spaces = [];
  const visit = (device) => {
    const points = (device.mountpoints || []).filter(Boolean);
    const fileSystem = String(device.fstype || '').toLowerCase();
    if (points.length && fileSystem && fileSystem !== 'vfat' && fileSystem !== 'swap') {
      const measured = measure(points.includes('/') ? '/' : points[0]);
      if (measured) spaces.push({ ...measured, role: points.includes('/') ? 'system' : 'apps' });
    }
    (device.children || []).forEach(visit);
  };
  if (disk) visit(disk);
  return spaces;
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
  looksLikeInstallerStick,
  storageCandidates,
  systemSpaces,
};
