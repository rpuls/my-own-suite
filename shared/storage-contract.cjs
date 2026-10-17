// Where MOS mounts the drives that hold app folders, and the folder it keeps
// them in. The app agent owns these mounts; the backup agent reads the same
// names so it can tell a drive that also holds app files and list it once.
const STORAGE_MOUNT_ROOT = '/media/mos-storage';
const FILES_DIR = 'MOS-files';
// Which apps keep folders on which drive, in the state root beside the app packages.
const STORAGE_CLAIMS_FILENAME = 'storage-drives.json';

module.exports = {
  FILES_DIR,
  STORAGE_CLAIMS_FILENAME,
  STORAGE_MOUNT_ROOT,
};
