const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AppStorage, MOUNT_OPTIONS, storageCandidates } = require('./storage.cjs');

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
  assert.deepEqual(drives.map((drive) => [drive.id, drive.usable]), [['1A2B-3C4D', true], ['e1e1e1e1-0000', false], ['ABCD-0001', true]]);
  assert.equal(drives[0].label, 'FILMS');
  assert.match(drives[1].reason, /formatted as ext4/u);
});

function fakeHost(blockdevices) {
  const mounts = new Map();
  const calls = [];
  const executeCapture = async (file, args) => {
    if (file === 'lsblk') return JSON.stringify({ blockdevices });
    if (file === 'findmnt') {
      const source = mounts.get(args.at(-1));
      if (!source) throw new Error('not mounted');
      return `${source}\n`;
    }
    if (file === 'docker') return 'c1\nc2\n';
    throw new Error(`unexpected ${file}`);
  };
  const execute = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'mount') mounts.set(args.at(-1), args.at(-2));
    if (file === 'umount') mounts.delete(args.at(-1));
    return { stdout: '' };
  };
  return { calls, execute, executeCapture, mounts };
}

async function storageFor(host) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-storage-'));
  const storage = new AppStorage({ claimsPath: path.join(root, 'claims.json'), execute: host.execute, executeCapture: host.executeCapture, mountRoot: path.join(root, 'media') });
  return { root, storage };
}

test('preparing folders mounts the drive with MOS options, creates them on it, and claims it', async () => {
  const host = fakeHost([USB_DRIVE]);
  const { root, storage } = await storageFor(host);
  const binds = await storage.prepareFolders('jellyfin', [
    { drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' },
    { drive: '1A2B-3C4D', name: 'Series', path: '/media/series' },
  ]);

  const target = path.posix.join(path.join(root, 'media'), '1A2B-3C4D');
  assert.deepEqual(host.calls, [['mount', '-t', 'exfat', '-o', MOUNT_OPTIONS, '/dev/sdb1', target]]);
  assert.deepEqual(binds.map((bind) => [bind.target, path.relative(target, bind.source).split(path.sep).join('/')]), [
    ['/media/movies', 'MOS-files/apps/jellyfin/Movies'],
    ['/media/series', 'MOS-files/apps/jellyfin/Series'],
  ]);
  assert.ok(fs.statSync(binds[0].source).isDirectory());
  assert.deepEqual(storage.readClaims().drives['1A2B-3C4D'], { apps: ['jellyfin'], fileSystem: 'exfat', label: 'FILMS' });

  await storage.prepareFolders('jellyfin', [{ drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' }]);
  assert.equal(host.calls.length, 1, 'a drive already mounted on its MOS path is not mounted again');
});

test('a drive that is not there creates nothing, and a pulled drive is remounted fresh', async () => {
  const host = fakeHost([]);
  const { root, storage } = await storageFor(host);
  await assert.rejects(storage.prepareFolders('jellyfin', [{ drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' }]), /not connected/u);
  assert.equal(fs.existsSync(path.join(root, 'media')), false);

  const stale = fakeHost([USB_DRIVE]);
  stale.mounts.set(path.posix.join(path.join(root, 'media'), '1A2B-3C4D'), '/dev/sdz1');
  const fresh = new AppStorage({ claimsPath: storage.claimsPath, execute: stale.execute, executeCapture: stale.executeCapture, mountRoot: path.join(root, 'media') });
  await fresh.attach('1A2B-3C4D');
  assert.deepEqual(stale.calls.map((call) => call[0]), ['umount', 'mount']);
});

test('an NTFS drive Windows left dirty is refused with the way to fix it', async () => {
  const ntfs = { fstype: 'ntfs', label: 'Ext HDD', mountpoints: [null], name: 'sdc1', path: '/dev/sdc1', size: 1_000_000_000_000, type: 'part', uuid: '20C2CDDCC2CDB676' };
  const host = fakeHost([ntfs]);
  const kernelLog = '[1914.66] ntfs3: sdc1: Mark volume as dirty due to NTFS errors\n[1917.77] ntfs3: sdc1: volume is dirty and "force" flag is not set!\n';
  const failingHost = {
    ...host,
    execute: async (file) => { if (file === 'mount') throw new Error('COMMAND_FAILED'); return { stdout: '' }; },
    executeCapture: async (file, args) => (file === 'dmesg' ? kernelLog : host.executeCapture(file, args)),
  };
  const { storage } = await storageFor(failingHost);
  await assert.rejects(storage.attach('20C2CDDCC2CDB676'), (error) => error.code === 'APP_STORAGE_UNAVAILABLE' && /Windows did not finish with this drive/u.test(error.message));
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

test('a Linux-formatted drive is refused in plain words', async () => {
  const { storage } = await storageFor(fakeHost([LINUX_DRIVE]));
  await assert.rejects(storage.attach('e1e1e1e1-0000'), /exFAT, NTFS or FAT32/u);
});

test('drives lists remembered drives that are away, and release forgets an uninstalled app', async () => {
  const host = fakeHost([USB_DRIVE]);
  const { storage } = await storageFor(host);
  await storage.prepareFolders('jellyfin', [{ drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' }]);
  storage.claim('1A2B-3C4D', 'immich', { fileSystem: 'exfat', label: 'FILMS' });

  const away = new AppStorage({ claimsPath: storage.claimsPath, execute: host.execute, executeCapture: fakeHost([]).executeCapture, mountRoot: storage.mountRoot });
  assert.deepEqual((await away.drives()).map((drive) => [drive.id, drive.connected, drive.apps]), [['1A2B-3C4D', false, ['immich', 'jellyfin']]]);

  storage.release('jellyfin');
  assert.deepEqual(storage.readClaims().drives['1A2B-3C4D'].apps, ['immich']);
  storage.release('immich');
  assert.equal(storage.isClaimed('1A2B-3C4D'), false);
});
