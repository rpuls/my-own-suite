const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AppStorage, MOUNT_OPTIONS, storageCandidates, systemSpaces } = require('./storage.cjs');

const SYSTEM_DISK = {
  children: [
    { fstype: 'vfat', label: null, mountpoints: ['/boot/efi'], name: 'sda1', path: '/dev/sda1', size: 1_000_000_000, type: 'part', uuid: 'AAAA-1111' },
    { fstype: 'ext4', mountpoints: ['/'], name: 'sda2', path: '/dev/sda2', size: 20_000_000_000, type: 'part', uuid: 'root-uuid' },
    { fstype: 'exfat', mountpoints: [null], name: 'sda3', path: '/dev/sda3', size: 200_000_000_000, type: 'part', uuid: 'SAME-DISK' },
  ],
  model: 'Internal SSD',
  name: 'sda',
  type: 'disk',
};
const USB_DRIVE = {
  children: [{ fstype: 'exfat', label: 'FILMS', mountpoints: [null], name: 'sdb1', path: '/dev/sdb1', size: 2_000_000_000_000, type: 'part', uuid: '1A2B-3C4D' }],
  model: 'Portable',
  name: 'sdb',
  tran: 'usb',
  type: 'disk',
};
const LINUX_DRIVE = { fstype: 'ext4', label: 'linux', mountpoints: [null], name: 'sdc', path: '/dev/sdc', size: 500_000_000_000, type: 'disk', uuid: 'e1e1e1e1-0000' };

test('only drives off the system disk are candidates, and only permission-less filesystems are usable', () => {
  const snap = { fstype: 'squashfs', mountpoints: ['/snap/core/1'], name: 'loop0', path: '/dev/loop0', size: 70_000_000, type: 'loop', uuid: null };
  const image = { fstype: 'vfat', label: 'LABDRIVE', mountpoints: [null], name: 'loop1', path: '/dev/loop1', size: 2_147_483_648, type: 'loop', uuid: 'ABCD-0001' };
  const drives = storageCandidates([SYSTEM_DISK, USB_DRIVE, LINUX_DRIVE, snap, image]);
  assert.deepEqual(drives.map((drive) => [drive.id, drive.holdsAppFoldersFormat, drive.holdsBackupsFormat]), [['1A2B-3C4D', true, true], ['e1e1e1e1-0000', false, true], ['ABCD-0001', true, true]]);
  assert.equal(drives[0].label, 'FILMS');
  assert.equal(drives[0].transport, 'usb');
  assert.match(drives[1].reason, /can hold backups but not app files/u);
});

// `refuse` names the mount options the "kernel" turns down, logging why as ntfs3 does.
function fakeHost(blockdevices, { busy = [], fsck = true, refuse = () => null } = {}) {
  const mounts = new Map();
  const calls = [];
  let kernelLog = '';
  const executeCapture = async (file, args) => {
    if (file === 'lsblk') return JSON.stringify({ blockdevices });
    if (file === 'findmnt') {
      const mount = mounts.get(args.at(-1));
      if (!mount) throw new Error('not mounted');
      return `${mount.source} ${mount.readOnly ? 'ro' : 'rw'},noatime\n`;
    }
    if (file === 'dmesg') return kernelLog;
    if (file === 'docker') return 'c1\nc2\n';
    throw new Error(`unexpected ${file}`);
  };
  const execute = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'mount') {
      const options = args[args.indexOf('-o') + 1];
      const refusal = refuse(options);
      if (refusal) {
        kernelLog += `[${(calls.length / 10).toFixed(1)}] ntfs3: ${path.posix.basename(args.at(-2))}: ${refusal}\n`;
        throw new Error('COMMAND_FAILED');
      }
      mounts.set(args.at(-1), { readOnly: options.split(',').includes('ro'), source: args.at(-2) });
    }
    if (file === 'umount') {
      if (busy.includes(args.at(-1))) throw new Error('target is busy');
      mounts.delete(args.at(-1));
    }
    if (file === 'ntfsfix' && !fsck) throw new Error('Volume is corrupt. You should run chkdsk.');
    return { stdout: '' };
  };
  return { calls, execute, executeCapture, mounts };
}

async function storageFor(host) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-storage-'));
  const storage = new AppStorage({ registryPath: path.join(root, 'storage.json'), execute: host.execute, executeCapture: host.executeCapture, mountRoot: path.join(root, 'media') });
  return { root, storage };
}

test('preparing folders mounts the drive with MOS options, creates them on it, flushes it, and claims it', async () => {
  const host = fakeHost([USB_DRIVE]);
  const { root, storage } = await storageFor(host);
  const binds = await storage.prepareFolders('jellyfin', [
    { drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' },
    { drive: '1A2B-3C4D', name: 'Series', path: '/media/series' },
  ]);

  const target = path.posix.join(path.join(root, 'media'), '1A2B-3C4D');
  assert.deepEqual(host.calls, [['mount', '-t', 'exfat', '-o', MOUNT_OPTIONS, '/dev/sdb1', target], ['sync', '--file-system', target]]);
  assert.deepEqual(binds.map((bind) => [bind.target, path.relative(target, bind.source).split(path.sep).join('/')]), [
    ['/media/movies', 'MOS-files/apps/jellyfin/Movies'],
    ['/media/series', 'MOS-files/apps/jellyfin/Series'],
  ]);
  assert.ok(fs.statSync(binds[0].source).isDirectory());
  assert.deepEqual(storage.registry.read().drives['1A2B-3C4D'], { apps: ['jellyfin'], fileSystem: 'exfat', label: 'FILMS', model: 'Portable', sizeBytes: 2_000_000_000_000, transport: 'usb' });

  await storage.prepareFolders('jellyfin', [{ drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' }]);
  assert.equal(host.calls.length, 2, 'a drive already mounted with its folders made is neither mounted nor flushed again');
});

test('a drive that is not there creates nothing, and a pulled drive is remounted fresh', async () => {
  const host = fakeHost([]);
  const { root, storage } = await storageFor(host);
  await assert.rejects(storage.prepareFolders('jellyfin', [{ drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' }]), /not connected/u);
  assert.equal(fs.existsSync(path.join(root, 'media')), false);

  const stale = fakeHost([USB_DRIVE]);
  stale.mounts.set(path.posix.join(path.join(root, 'media'), '1A2B-3C4D'), { readOnly: false, source: '/dev/sdz1' });
  const fresh = new AppStorage({ registryPath: storage.registry.registryPath, execute: stale.execute, executeCapture: stale.executeCapture, mountRoot: path.join(root, 'media') });
  await fresh.attach('1A2B-3C4D');
  assert.deepEqual(stale.calls.map((call) => call[0]), ['umount', 'mount']);
});

test('opening a drive for its files mounts it and remembers it without claiming it for anything', async () => {
  const host = fakeHost([USB_DRIVE, LINUX_DRIVE]);
  const { storage } = await storageFor(host);
  await assert.rejects(storage.open('e1e1e1e1-0000'), /can hold backups but not app files/u);
  assert.deepEqual(await storage.open('1A2B-3C4D'), { readOnly: false });
  assert.equal(host.calls.filter((call) => call[0] === 'mount').length, 1);
  assert.deepEqual(storage.registry.read().drives['1A2B-3C4D'].apps, []);
  assert.equal(storage.isRemembered('1A2B-3C4D'), true);
  assert.equal((await storage.drives()).find((drive) => drive.id === '1A2B-3C4D').state, 'ready');
});

const NTFS = { fstype: 'ntfs', label: 'Ext HDD', mountpoints: [null], name: 'sdc1', path: '/dev/sdc1', size: 1_000_000_000_000, type: 'part', uuid: '20C2CDDCC2CDB676' };
const DIRTY = (options) => (options.startsWith('ro,') ? null : 'volume is dirty and "force" flag is not set!');

async function claimedNtfs(options) {
  const host = fakeHost([NTFS], options);
  const { storage } = await storageFor(host);
  storage.claim(NTFS.uuid, 'jellyfin', { fileSystem: 'ntfs', label: 'Ext HDD' });
  return { host, storage, target: path.posix.join(storage.mountRoot, NTFS.uuid) };
}

test('an NTFS drive Windows would check first opens read-only, so its apps keep their files', async () => {
  const { host, storage, target } = await claimedNtfs({ refuse: DIRTY });
  assert.equal((await storage.attach(NTFS.uuid)).readOnly, true);
  assert.deepEqual(host.calls.filter((call) => call[0] === 'mount').map((call) => call[4]), [MOUNT_OPTIONS, `ro,${MOUNT_OPTIONS}`]);
  assert.ok(!host.calls.some((call) => call.join(' ').includes('force')), 'ntfs3 force is never used');
  assert.equal(host.mounts.get(target).readOnly, true);

  const [drive] = await storage.drives();
  assert.equal(drive.state, 'read-only');
  assert.equal(drive.usable, false);
  assert.match(drive.reason, /can read this drive, but nothing can be saved/u);
  assert.match(drive.detail, /volume is dirty/u);
});

test('a read-only drive refuses a new folder in plain words', async () => {
  const { storage } = await claimedNtfs({ refuse: DIRTY });
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (target, options) => {
    if (String(target).endsWith('Music')) throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    return mkdir(target, options);
  };
  try {
    await assert.rejects(storage.prepareFolders('jellyfin', [{ drive: NTFS.uuid, name: 'Music', path: '/media/music' }]), /nothing can be saved/u);
  } finally {
    fs.mkdirSync = mkdir;
  }
});

test('a drive that cannot be opened even to read it says so and points at Windows', async () => {
  const { storage } = await claimedNtfs({ refuse: () => 'volume is dirty and "force" flag is not set!' });
  await assert.rejects(storage.attach(NTFS.uuid), /even to read it\. Plug it into a Windows computer/u);
  const [drive] = await storage.drives();
  assert.deepEqual([drive.state, drive.usable], ['failed', false]);
  assert.match(drive.reason, /even to read it/u);
});

test('Check drive closes the drive, clears what an unplug left, and opens it read-write again', async () => {
  let dirty = true;
  const { host, storage, target } = await claimedNtfs({ refuse: (options) => (dirty ? DIRTY(options) : null) });
  await storage.attach(NTFS.uuid);
  const execute = storage.execute;
  storage.execute = async (file, args, options) => {
    if (file === 'ntfsfix') dirty = false;
    return execute(file, args, options);
  };

  await storage.check(NTFS.uuid);
  assert.deepEqual(host.calls.filter((call) => ['umount', 'ntfsfix'].includes(call[0])), [['umount', target], ['ntfsfix', '--clear-dirty', '/dev/sdc1']]);
  assert.equal(host.mounts.get(target).readOnly, false);
  const [drive] = await storage.drives();
  assert.deepEqual([drive.state, drive.detail], ['ready', null]);
});

test('a drive the quick check cannot repair stays readable and keeps the pointer to Windows', async () => {
  const { storage } = await claimedNtfs({ fsck: false, refuse: DIRTY });
  await storage.attach(NTFS.uuid);
  await assert.rejects(storage.check(NTFS.uuid), /quick check could not repair this drive/u);
  const [drive] = await storage.drives();
  assert.equal(drive.state, 'read-only');
  assert.match(drive.reason, /Properties, choose Tools and then Check/u);
});

test('only NTFS drives are offered the check', async () => {
  const { storage } = await storageFor(fakeHost([USB_DRIVE]));
  await assert.rejects(storage.check('1A2B-3C4D'), /Only drives formatted as NTFS/u);
});

test('eject unmounts the drive everywhere, never lazily, and plugging it back in opens it again', async () => {
  const backupPoint = '/media/mos-backup';
  const { host, storage, target } = await claimedNtfs();
  NTFS.mountpoints = [backupPoint];
  try {
    await storage.attach(NTFS.uuid);
    await storage.eject(NTFS.uuid);
    assert.deepEqual(host.calls.filter((call) => call[0] === 'umount'), [['umount', target], ['umount', backupPoint]]);
    assert.equal((await storage.drives())[0].state, 'ejected');

    await storage.attach(NTFS.uuid);
    assert.equal((await storage.drives())[0].state, 'ready');
  } finally {
    NTFS.mountpoints = [null];
  }
});

test('a drive something still holds open is not called safe to unplug', async () => {
  const { storage } = await storageFor(fakeHost([USB_DRIVE]));
  storage.claim('1A2B-3C4D', 'jellyfin', { fileSystem: 'exfat', label: 'FILMS' });
  const target = path.posix.join(storage.mountRoot, '1A2B-3C4D');
  const busy = fakeHost([USB_DRIVE], { busy: [target] });
  busy.mounts.set(target, { readOnly: false, source: '/dev/sdb1' });
  const held = new AppStorage({ registryPath: storage.registry.registryPath, execute: busy.execute, executeCapture: busy.executeCapture, mountRoot: storage.mountRoot });
  await assert.rejects(held.eject('1A2B-3C4D'), /still using this drive/u);
  assert.equal((await held.drives())[0].state, 'ready');
});

test('a mount failure the kernel log does not explain stays the command failure', async () => {
  const host = fakeHost([USB_DRIVE]);
  const { storage } = await storageFor({
    ...host,
    execute: async (file) => { if (file === 'mount') throw new Error('COMMAND_FAILED'); return { stdout: '' }; },
    executeCapture: async (file, args) => (file === 'dmesg' ? 'ntfs3: sdz1: volume is dirty\n' : host.executeCapture(file, args)),
  });
  await assert.rejects(storage.attach('1A2B-3C4D'), /COMMAND_FAILED/u);
});

test('a dirty line the kernel logged before this mount attempt is not read as its refusal', async () => {
  const host = fakeHost([NTFS]);
  const { storage } = await storageFor({
    ...host,
    execute: async (file, args) => { if (file === 'mount') throw new Error('COMMAND_FAILED'); return host.execute(file, args); },
    executeCapture: async (file, args) => (file === 'dmesg' ? '[3.1] ntfs3: sdc1: volume is dirty and "force" flag is not set!\n' : host.executeCapture(file, args)),
  });
  await assert.rejects(storage.attach(NTFS.uuid), /COMMAND_FAILED/u);
});

test('a Linux-formatted drive is refused for app folders in plain words, before anything is mounted', async () => {
  const host = fakeHost([LINUX_DRIVE]);
  const { storage } = await storageFor(host);
  await assert.rejects(storage.prepareFolders('jellyfin', [{ drive: 'e1e1e1e1-0000', name: 'Movies', path: '/media/movies' }]), /exFAT, NTFS or FAT32/u);
  assert.deepEqual(host.calls, []);
});

test('a drive kept for backups is opened with the safety options its format takes, remembered, and listed while away', async () => {
  const host = fakeHost([LINUX_DRIVE]);
  const { root, storage } = await storageFor(host);
  await storage.holdBackups('e1e1e1e1-0000');
  assert.deepEqual(host.calls, [['mount', '-t', 'ext4', '-o', 'noatime,nodev,nosuid,noexec', '/dev/sdc', path.posix.join(path.join(root, 'media'), 'e1e1e1e1-0000')]]);
  assert.equal(storage.isRemembered('e1e1e1e1-0000'), true);
  const away = new AppStorage({ registryPath: storage.registry.registryPath, execute: host.execute, executeCapture: fakeHost([]).executeCapture, mountRoot: storage.mountRoot });
  assert.deepEqual((await away.drives()).map((drive) => [drive.id, drive.state, drive.backups]), [['e1e1e1e1-0000', 'away', true]]);
  storage.releaseBackups('e1e1e1e1-0000');
  assert.deepEqual(await away.drives(), []);
});

test('naming a drive changes only what MOS calls it, and does not make MOS keep anything on it', async () => {
  const { storage } = await storageFor(fakeHost([USB_DRIVE]));
  assert.deepEqual(storage.rename('1A2B-3C4D', '  Movies   drive '), { name: 'Movies drive' });
  const [drive] = await storage.drives();
  assert.deepEqual([drive.name, drive.label, drive.state], ['Movies drive', 'FILMS', 'available']);
  assert.equal(storage.isRemembered('1A2B-3C4D'), false);
  storage.rename('1A2B-3C4D', '');
  assert.equal((await storage.drives())[0].name, null);
});

test('drives lists remembered drives that are away, release keeps a drive open for what an app left, and forget lets it go', async () => {
  const host = fakeHost([USB_DRIVE]);
  const { storage } = await storageFor(host);
  await storage.prepareFolders('jellyfin', [{ drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' }]);
  storage.claim('1A2B-3C4D', 'immich', { fileSystem: 'exfat', label: 'FILMS' });

  const away = new AppStorage({ registryPath: storage.registry.registryPath, execute: host.execute, executeCapture: fakeHost([]).executeCapture, mountRoot: storage.mountRoot });
  assert.deepEqual((await away.drives()).map((drive) => [drive.id, drive.connected, drive.apps]), [['1A2B-3C4D', false, ['immich', 'jellyfin']]]);

  storage.release('jellyfin', ['1A2B-3C4D']);
  assert.deepEqual(storage.registry.read().drives['1A2B-3C4D'].apps, ['immich', 'jellyfin'], 'a drive the app still mounts stays claimed');
  storage.release('jellyfin');
  assert.deepEqual(storage.registry.read().drives['1A2B-3C4D'].apps, ['immich']);
  storage.release('immich');
  assert.equal(storage.isRemembered('1A2B-3C4D'), true, 'its folders are still mounted after a restart');
  assert.deepEqual((await away.drives()).map((drive) => [drive.id, drive.state, drive.apps]), [['1A2B-3C4D', 'away', []]]);
  await assert.rejects(storage.forget('1A2B-3C4D'), /Eject the drive/u);
  await away.forget('1A2B-3C4D');
  assert.deepEqual(await away.drives(), [], 'a forgotten drive is no longer listed');
  assert.equal(away.isRemembered('1A2B-3C4D'), false);
  assert.equal(fs.existsSync(`${storage.registry.registryPath}.lock`), false);
});

test('a claims lock left by a process that died is taken over', async () => {
  const { storage } = await storageFor(fakeHost([USB_DRIVE]));
  const lock = `${storage.registry.registryPath}.lock`;
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  storage.claim('1A2B-3C4D', 'jellyfin', { fileSystem: 'exfat', label: 'FILMS' });
  assert.deepEqual(storage.registry.read().drives['1A2B-3C4D'].apps, ['jellyfin']);
});

const INSTALL_STICK = {
  children: [
    { fstype: 'vfat', mountpoints: [null], name: 'sdd1', parttype: 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b', path: '/dev/sdd1', size: 800_000_000, type: 'part', uuid: '21A9-69FB' },
    { fstype: 'ext4', mountpoints: [null], name: 'sdd2', parttype: '0fc63daf-8483-4772-8e79-3d69d8477de4', path: '/dev/sdd2', size: 7_516_192_768, type: 'part', uuid: '723ed40b-0000' },
  ],
  model: 'SanDisk 3.2Gen1', name: 'sdd', path: '/dev/sdd', rm: true, size: 30_816_600_064, tran: 'usb', type: 'disk',
};

// The stick's EFI partition carries the image's own id file, which only the stick can show.
function stickHost(devices, { carriesImage = true } = {}) {
  const host = fakeHost(devices);
  const execute = host.execute;
  host.execute = async (file, args, options) => {
    if (file === 'mount' && args.includes('ro,nodev,nosuid,noexec') && carriesImage) fs.writeFileSync(path.join(args.at(-1), 'mos-image.json'), '{"version":"0.23.0"}');
    return execute(file, args, options);
  };
  return host;
}

test('the install stick is recognised by its own image file, kept out of the drives, and nothing else is taken for it', async () => {
  const { storage } = await storageFor(stickHost([SYSTEM_DISK, INSTALL_STICK, USB_DRIVE]));
  const inventory = await storage.inventory();
  assert.deepEqual(inventory.installerSticks.map((stick) => stick.devicePath), ['/dev/sdd']);
  assert.ok(!inventory.drives.some((drive) => drive.devicePath?.startsWith('/dev/sdd')));

  const lookalike = await storageFor(stickHost([INSTALL_STICK], { carriesImage: false }));
  assert.deepEqual((await lookalike.storage.inventory()).installerSticks, []);
  const internal = { ...INSTALL_STICK, rm: false, tran: 'sata' };
  assert.equal((await (await storageFor(stickHost([internal]))).storage.inventory()).installerSticks.length, 0, 'an internal disk with a MOS system on it is never the stick');
});

test('formatting erases only the proven stick, into one exFAT drive', async () => {
  const host = stickHost([INSTALL_STICK]);
  const { storage } = await storageFor(host);
  await assert.rejects(storage.formatInstallerStick('/dev/sdb'), /not the MOS install stick/u);
  assert.ok(!host.calls.some(([file]) => file === 'wipefs'));
  await storage.formatInstallerStick('/dev/sdd');
  const erasing = host.calls.filter(([file]) => ['wipefs', 'sh', 'mkfs.exfat'].includes(file));
  assert.deepEqual(erasing[0], ['wipefs', '--all', '--force', '/dev/sdd']);
  assert.deepEqual(erasing.at(-1), ['mkfs.exfat', '-L', 'MOS STORAGE', '/dev/sdd1']);
});

test('the system disk is measured per filesystem, so the vault that holds the apps is told apart from MOS itself', () => {
  const vaultDisk = {
    children: [
      { fstype: 'vfat', mountpoints: ['/boot/efi'], name: 'sda1', type: 'part' },
      { fstype: 'ext4', mountpoints: ['/'], name: 'sda2', type: 'part' },
      { children: [{ fstype: 'ext4', mountpoints: ['/var/lib/mos-vault', '/var/lib/docker'], name: 'mos-vault', type: 'crypt' }], fstype: 'crypto_LUKS', mountpoints: [null], name: 'sda3', type: 'part' },
    ],
    name: 'sda',
    type: 'disk',
  };
  const sizes = { '/': { availableBytes: 19e9, sizeBytes: 30e9 }, '/var/lib/mos-vault': { availableBytes: 400e9, sizeBytes: 430e9 } };
  assert.deepEqual(systemSpaces(vaultDisk, (point) => sizes[point]), [
    { availableBytes: 19e9, role: 'system', sizeBytes: 30e9 },
    { availableBytes: 400e9, role: 'apps', sizeBytes: 430e9 },
  ]);
});
