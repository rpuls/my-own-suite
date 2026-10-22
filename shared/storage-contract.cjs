// Where MOS mounts the drives it keeps things on, and the folders it keeps them
// in. The app agent owns these mounts; the backup agent reads the same names so
// it can tell a drive that also holds app files and list it once.
const STORAGE_MOUNT_ROOT = '/media/mos-storage';
const FILES_DIR = 'MOS-files';
// The folder backups live in on a drive or in a bucket, beside MOS-files on a shared drive.
const BACKUPS_DIR = 'MOS-backups';
// One archive is one folder under MOS-backups; anything else there is just a folder.
const ARCHIVE_DIR_PATTERN = /^archive-[0-9a-f]{8}$/u;
// The label the install stick carries once it is formatted into a drive.
const FORMATTED_DRIVE_LABEL = 'MOS STORAGE';
// The storage module's record of every drive and bucket, in the state root.
const STORAGE_REGISTRY_FILENAME = 'storage.json';
// lsblk's filesystem names. App folders go only where any computer can open them;
// a Linux drive can still hold backups, which nothing outside MOS reads.
const APP_FOLDER_FILESYSTEMS = Object.freeze(['exfat', 'ntfs', 'vfat']);
const BACKUP_FILESYSTEMS = Object.freeze([...APP_FOLDER_FILESYSTEMS, 'ext4']);

module.exports = {
  APP_FOLDER_FILESYSTEMS,
  ARCHIVE_DIR_PATTERN,
  BACKUPS_DIR,
  BACKUP_FILESYSTEMS,
  FILES_DIR,
  FORMATTED_DRIVE_LABEL,
  STORAGE_MOUNT_ROOT,
  STORAGE_REGISTRY_FILENAME,
};
