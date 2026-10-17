const fs = require('node:fs');
const path = require('node:path');
const { FILES_DIR, STORAGE_MOUNT_ROOT } = require('../../shared/storage-contract.cjs');
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
const DIRTY_VOLUME_REASON = 'Windows did not finish with this drive: it was unplugged without ejecting, or it needs a check. Plug it into a Windows computer, open the drive\'s Properties, choose Tools and then Check, and eject it before plugging it back in here.';
const ONE_GIB = 1024 * 1024 * 1024;

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

  writeClaims(claims) {
    fs.mkdirSync(path.dirname(this.claimsPath), { recursive: true });
    const temporary = `${this.claimsPath}.${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(claims, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.claimsPath);
  }

  async candidates() {
    const output = await this.executeCapture('lsblk', [...LSBLK_ARGS], { timeoutMs: 10_000 }).catch(() => null);
    try { return storageCandidates(JSON.parse(output).blockdevices); } catch { return []; }
  }

  // The device mounted on a path, positively, or null.
  async mountedSource(target) {
    const output = await this.executeCapture('findmnt', ['--raw', '--noheadings', '--output', 'SOURCE', '--mountpoint', target], { timeoutMs: 10_000 }).catch(() => '');
    return String(output || '').trim().split('\n')[0] || null;
  }

  // Connected drives, plus remembered ones that are away.
  async drives() {
    const claims = this.readClaims().drives;
    const listed = [];
    for (const drive of await this.candidates()) {
      const target = driveMountPath(drive.id, this.mountRoot);
      const mounted = await this.mountedSource(target) === drive.devicePath;
      const roots = mounted ? [target, ...drive.mountpoints] : drive.mountpoints;
      listed.push({
        apps: claims[drive.id]?.apps || [],
        availableBytes: mounted ? availableBytes(target) : null,
        connected: true,
        fileSystem: drive.fileSystem,
        holdsBackups: roots.some((root) => fs.existsSync(path.join(root, 'MOS-backups'))),
        id: drive.id,
        label: drive.label,
        reason: drive.reason,
        sizeBytes: drive.sizeBytes,
        usable: drive.usable,
      });
    }
    for (const [id, claim] of Object.entries(claims)) {
      if (listed.some((drive) => drive.id === id)) continue;
      listed.push({ apps: claim.apps || [], availableBytes: null, connected: false, fileSystem: claim.fileSystem || null, holdsBackups: false, id, label: claim.label || id, reason: 'This drive is not connected.', sizeBytes: null, usable: false });
    }
    return listed;
  }

  // Every app folder on the drives mounted right now, with its size, including
  // the folders of apps that were uninstalled, which nothing else would show.
  async folders() {
    const listed = [];
    for (const driveId of readDirectoryNames(this.mountRoot)) {
      const target = driveMountPath(driveId, this.mountRoot);
      if (!await this.mountedSource(target)) continue;
      const appsDir = path.join(target, FILES_DIR, 'apps');
      for (const app of readDirectoryNames(appsDir)) {
        for (const name of readDirectoryNames(path.join(appsDir, app))) {
          listed.push({ app, bytes: directorySize(path.join(appsDir, app, name)), driveId, name });
        }
      }
    }
    return listed;
  }

  // Mounts a drive on its MOS path, replacing a mount left behind by a drive that
  // was pulled out. Folders are only ever created after this proves the drive.
  async attach(driveId) {
    const target = driveMountPath(driveId, this.mountRoot);
    const drive = (await this.candidates()).find((item) => item.id === driveId);
    if (!drive) throw new StorageError('The drive that holds this app\'s folders is not connected.');
    if (!drive.usable) throw new StorageError(drive.reason);
    const current = await this.mountedSource(target);
    if (current === drive.devicePath) return { drive, target };
    if (current) await this.execute('umount', ['--lazy', target], { timeoutMs: 30_000 });
    fs.mkdirSync(target, { recursive: true });
    await this.execute('mount', ['-t', STORAGE_FILESYSTEMS.get(drive.fileSystem), '-o', MOUNT_OPTIONS, drive.devicePath, target], { timeoutMs: 60_000 }).catch(async (error) => {
      if (await this.refusedAsDirty(drive)) throw new StorageError(DIRTY_VOLUME_REASON);
      throw error;
    });
    if (await this.mountedSource(target) !== drive.devicePath) throw new StorageError('The drive could not be opened.');
    return { drive, target };
  }

  // ntfs3 gives its reason only in the kernel log; `mount` itself just says "wrong fs type".
  async refusedAsDirty(drive) {
    const log = await this.executeCapture('dmesg', [], { timeoutMs: 10_000 }).catch(() => '');
    const prefix = `ntfs3: ${path.posix.basename(drive.devicePath)}:`;
    const lastWord = String(log).split('\n').filter((line) => line.includes(prefix)).pop() || '';
    return lastWord.includes('volume is dirty');
  }

  async prepareFolders(packageId, folders) {
    const binds = [];
    const byDrive = new Map();
    for (const folder of folders) byDrive.set(folder.drive, [...(byDrive.get(folder.drive) || []), folder]);
    for (const [driveId, onDrive] of byDrive) {
      const { drive } = await this.attach(driveId);
      this.claim(driveId, packageId, drive);
      for (const folder of onDrive) {
        const source = appFolderPath(driveId, packageId, folder.name, this.mountRoot);
        fs.mkdirSync(source, { recursive: true });
        binds.push({ drive: driveId, source, target: folder.path });
      }
    }
    return binds;
  }

  claim(driveId, packageId, drive) {
    const claims = this.readClaims();
    const current = claims.drives[driveId] || { apps: [] };
    const apps = current.apps.includes(packageId) ? current.apps : [...current.apps, packageId].sort();
    claims.drives[driveId] = { apps, fileSystem: drive.fileSystem, label: drive.label };
    this.writeClaims(claims);
  }

  // An app that is removed lets go of its drive; its folders stay on it.
  release(packageId) {
    const claims = this.readClaims();
    let changed = false;
    for (const [driveId, claim] of Object.entries(claims.drives)) {
      if (!claim.apps?.includes(packageId)) continue;
      changed = true;
      const apps = claim.apps.filter((app) => app !== packageId);
      if (apps.length) claims.drives[driveId] = { ...claim, apps };
      else delete claims.drives[driveId];
    }
    if (changed) this.writeClaims(claims);
  }

  isClaimed(driveId) {
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
  FILES_DIR,
  MOUNT_OPTIONS,
  STORAGE_DRIVE_LABEL,
  STORAGE_MOUNT_ROOT,
  StorageError,
  appFolderPath,
  driveMountPath,
  storageCandidates,
};
