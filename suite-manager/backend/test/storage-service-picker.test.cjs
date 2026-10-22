const assert = require('node:assert/strict');
const test = require('node:test');

const { StorageService } = require('../src/storage/storage-service.cjs');

const LIBRARY = { apps: ['media-app'], availableBytes: 346e9, backups: false, connected: true, devicePath: '/dev/sdb1', fileSystem: 'ntfs', holdsAppFoldersFormat: true, holdsBackups: false, holdsBackupsFormat: true, id: '20C2CDDCC2CDB676', label: 'Expansion', mountPath: '/media/mos-storage/20C2CDDCC2CDB676', name: null, sizeBytes: 1e12, state: 'ready', transport: 'usb' };
const SPARE = { ...LIBRARY, apps: [], id: 'SPARE-0001', label: 'Spare' };
const LINUX = { ...LIBRARY, apps: [], fileSystem: 'ext4', holdsAppFoldersFormat: false, id: 'e1e1e1e1-0000', label: 'Linux', mountPath: null, state: 'available' };

function service() {
  const names = () => new Map([['media-app', { installed: true, name: 'Media App' }]]);
  const appAgent = { storageInventory: async () => ({ buckets: [], drives: [LIBRARY, SPARE, LINUX], installerSticks: [], system: null }) };
  const backupAgent = { status: async () => ({ archives: [], destinations: [], primaryDestination: null }) };
  return new StorageService({ appAgent, backupAgent, names });
}

// The backup picker warns when a library would be backed up onto its own drive. The
// fact it reads is stated here: which apps keep folders on an entry that can hold backups.
test('a drive that holds app folders names its apps and still offers to hold backups', async () => {
  const { storage } = await service().inventory();
  const byId = Object.fromEntries(storage.map((entry) => [entry.id, entry]));

  assert.deepEqual(byId[LIBRARY.id].apps, ['media-app']);
  assert.deepEqual([byId[LIBRARY.id].capabilities.holdsBackups, byId[LIBRARY.id].capabilities.holdsAppFolders], [true, true]);
  assert.deepEqual([byId[SPARE.id].apps, byId[SPARE.id].capabilities.holdsBackups], [[], true]);
  assert.deepEqual([byId[LINUX.id].apps, byId[LINUX.id].capabilities.holdsBackups, byId[LINUX.id].capabilities.holdsAppFolders], [[], true, false]);
});

test('the inventory carries the display name of every app, so no screen asks the app list for them', async () => {
  const listed = await service().inventory();

  assert.deepEqual(listed.appNames, { 'media-app': 'Media App' });
});
