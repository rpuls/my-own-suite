const assert = require('node:assert/strict');
const test = require('node:test');

const { StorageService } = require('../src/storage/storage-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

const FILMS = { apps: ['jellyfin'], availableBytes: 346e9, backups: false, connected: true, devicePath: '/dev/sdb1', fileSystem: 'ntfs', holdsAppFoldersFormat: true, holdsBackups: true, holdsBackupsFormat: true, id: '20C2CDDCC2CDB676', label: 'Expansion', model: 'Seagate Expansion', mountPath: '/media/mos-storage/20C2CDDCC2CDB676', name: 'Movies drive', sizeBytes: 1e12, state: 'ready', transport: 'usb', usable: true };
const LINUX = { ...FILMS, apps: [], fileSystem: 'ext4', holdsAppFoldersFormat: false, id: 'e1e1e1e1-0000', mountPath: null, name: null, state: 'available' };
const DRAWER = { ...FILMS, apps: [], availableBytes: null, backups: true, connected: false, devicePath: null, id: 'DRAWER-0001', mountPath: null, name: 'Backup drive', state: 'away' };
const BUCKET = { accessKeyId: 'AKIAEXAMPLE', backups: true, bucket: 'family', endpoint: 'https://s3.test', folder: '', id: 'object:0123456789ab', label: 'Family backups', region: '' };
const STATUS = {
  archives: [
    { containerId: 'object:0123456789ab', id: 'object:0123456789ab', keyState: 'own', owner: 'this', restorePoints: 6, storedBytes: 140e9 },
    { containerId: '20C2CDDCC2CDB676', id: '20C2CDDCC2CDB676/archive-0000beef', keyState: 'locked', owner: 'other', writtenBy: { hostname: 'mos-old', installId: 'old' } },
  ],
  destinations: [
    { condition: 'ready', id: 'object:0123456789ab', kind: 'object', lastBackupAt: '2026-10-18T03:00:00.000Z', ownArchive: { id: 'object:0123456789ab', restorePoints: 6, storedBytes: 140e9 } },
    { condition: 'away', id: 'DRAWER-0001', kind: 'disk', lastBackupAt: '2026-10-01T03:00:00.000Z', ownArchive: null },
  ],
  primaryDestination: { destinationId: 'object:0123456789ab' },
};

function service({ calls = [], status = async () => STATUS } = {}) {
  const appAgent = {
    holdBackups: async (input) => { calls.push(['hold', input]); },
    storageInventory: async () => ({ buckets: [BUCKET], drives: [FILMS, LINUX, DRAWER], installerSticks: [{ devicePath: '/dev/sdd' }], system: { appsBytes: 200e9, availableBytes: 236e9, encrypted: true, sizeBytes: 500e9, systemBytes: 14e9 } }),
  };
  const backupAgent = {
    holdObjectBackups: async (input) => { calls.push(['hold-object', input]); },
    setPrimaryDestination: async (input) => { calls.push(['primary', input]); },
    status,
  };
  return new StorageService({ appAgent, backupAgent });
}

test('one list holds the system drive, every drive and every bucket, each with what it can do', async () => {
  const { storage } = await service().inventory();
  assert.deepEqual(storage.map((entry) => [entry.id, entry.kind, entry.state]), [
    ['system', 'system', 'ready'],
    ['20C2CDDCC2CDB676', 'drive', 'ready'],
    ['e1e1e1e1-0000', 'drive', 'available'],
    ['DRAWER-0001', 'drive', 'away'],
    ['object:0123456789ab', 'bucket', 'ready'],
  ]);
  const [system, films, linux, drawer, bucket] = storage;
  assert.deepEqual(system.capabilities, { browsable: false, checkable: false, ejectable: false, holdsAppFolders: false, holdsBackups: false, renamable: false, writable: false });
  assert.equal(system.encrypted, true);
  assert.deepEqual([system.sizeBytes, system.diskSizeBytes, system.systemUsage], [450e9, 500e9, { appsBytes: 200e9, systemBytes: 14e9 }]);
  assert.deepEqual([films.capabilities.holdsAppFolders, films.capabilities.ejectable, films.capabilities.checkable], [true, true, false]);
  assert.deepEqual([linux.capabilities.holdsAppFolders, linux.capabilities.holdsBackups], [false, true]);
  assert.deepEqual([bucket.capabilities.holdsAppFolders, bucket.capabilities.holdsBackups], [false, true]);
  assert.deepEqual([bucket.backups.primary, bucket.backups.storedBytes, bucket.backups.lastBackupAt], [true, 140e9, '2026-10-18T03:00:00.000Z']);
  assert.deepEqual(films.backups.otherServers, [{ id: '20C2CDDCC2CDB676/archive-0000beef', keyState: 'locked', writtenBy: { hostname: 'mos-old', installId: 'old' } }]);
  assert.equal(films.backups.destination, false, 'another server\'s archive does not make a drive this server\'s place');
  assert.deepEqual([drawer.backups.lastBackupAt, drawer.name], ['2026-10-01T03:00:00.000Z', 'Backup drive']);
});

test('without the backup agent the drives are still listed, and without the app agent nothing is', async () => {
  const listed = await service({ status: async () => { throw new Error('down'); } }).inventory();
  assert.equal(listed.backupsKnown, false);
  assert.equal(listed.storage.find((entry) => entry.id === '20C2CDDCC2CDB676').backups, null);
  const blind = new StorageService({ appAgent: { storageInventory: async () => { throw new Error('down'); } }, backupAgent: { status: async () => STATUS } });
  assert.equal(await blind.inventory(), null);
});

test('making storage a backup destination is a claim for its kind, and the primary follows the destination it becomes', async () => {
  const calls = [];
  const claimed = { ...STATUS, destinations: [...STATUS.destinations, { condition: 'ready', id: '20C2CDDCC2CDB676', kind: 'disk', ownArchive: null }] };
  await service({ calls, status: async () => claimed }).holdBackups('20C2CDDCC2CDB676', { primary: true });
  await service({ calls }).holdBackups('object:0123456789ab');
  assert.deepEqual(calls, [
    ['hold', { drive: '20C2CDDCC2CDB676', held: true }],
    ['primary', { destinationId: '20C2CDDCC2CDB676' }],
    ['hold-object', { destinationId: 'object:0123456789ab', held: true }],
  ]);
  await assert.rejects(service().holdBackups('system'), /cannot hold backups/u);
  await assert.rejects(service().releaseBackups('object:0123456789ab'), /Choose another place/u);
});

test('a drive holding another server\'s backups still becomes this server\'s place, beside them', async () => {
  const calls = [];
  const claimed = { ...STATUS, destinations: [...STATUS.destinations, { condition: 'ready', id: '20C2CDDCC2CDB676', kind: 'disk', ownArchive: null }] };
  const added = await service({ calls, status: async () => claimed }).holdBackups('20C2CDDCC2CDB676', { primary: true });
  assert.deepEqual(calls, [['hold', { drive: '20C2CDDCC2CDB676', held: true }], ['primary', { destinationId: '20C2CDDCC2CDB676' }]]);
  assert.equal(added.destination.id, '20C2CDDCC2CDB676');
  const { storage } = await service({ status: async () => claimed }).inventory();
  const films = storage.find((entry) => entry.id === '20C2CDDCC2CDB676');
  assert.deepEqual([films.backups.destination, films.backups.otherServers.length], [true, 1]);
});

test('the install stick is formatted only while it is still the one listed', async () => {
  await assert.rejects(service().formatInstallerStick('/dev/sdb'), /no longer plugged in/u);
});

test('storage routes start drive jobs, rename by identity, and refuse an unconfirmed format', async () => {
  const begun = [];
  const services = {
    driveJobs: { begin: (driveId, input) => { begun.push([driveId, input]); return { status: 'running' }; } },
    storage: { formatInstallerStick: async () => ({ status: 'formatted' }), inventory: async () => ({ storage: [] }), rename: async (id, name) => ({ id, name }) },
  };
  await withRoutes(services, async (call) => {
    assert.equal((await call('POST', '/storage/drives/20C2CDDCC2CDB676/use')).status, 202);
    assert.equal((await call('POST', '/storage/drives/20C2CDDCC2CDB676/format')).status, 404);
    assert.deepEqual((await call('POST', '/storage/object%3A0123456789ab/rename', { body: { name: 'Offsite' } })).json(), { id: 'object:0123456789ab', name: 'Offsite' });
    assert.equal((await call('POST', '/storage/installer-stick/format', { body: { devicePath: '/dev/sdd' } })).status, 400);
    assert.equal((await call('POST', '/storage/installer-stick/format', { body: { confirmed: true, devicePath: '/dev/sdd' } })).status, 200);
  });
  assert.deepEqual(begun, [['20C2CDDCC2CDB676', { action: 'use' }]]);
});

test('an open page is told when a drive changes, and the poll stops when the last page goes', async () => {
  let drives = [FILMS];
  const storage = new StorageService({ appAgent: { storageInventory: async () => ({ drives }) }, backupAgent: { status: async () => STATUS }, watchIntervalMs: 60_000 });
  let told = 0;
  const unsubscribe = storage.subscribe(() => { told += 1; });
  await storage.watch();
  await storage.watch();
  assert.equal(told, 0, 'the first look only records what is there');
  drives = [{ ...FILMS, connected: false, state: 'away' }];
  await storage.watch();
  assert.equal(told, 1);
  unsubscribe();
  assert.equal(storage.watchTimer, null);
});
