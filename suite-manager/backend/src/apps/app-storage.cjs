// Where an app's declared folders live. The owner picks one drive at install and
// every folder of the app is placed on it; nothing here knows a host path.

const { AppPackageServiceError } = require('./app-package-internals.cjs');

function declaredFolders(manifest) {
  return Array.isArray(manifest?.storage?.folders) ? manifest.storage.folders : [];
}

function storageRequired(manifest) {
  return manifest?.storage?.required === true && declaredFolders(manifest).length > 0;
}

// The folder rows an install records, or [] when the app declares none or the
// owner chose to install an optional-folder app without a drive.
function placeFolders(manifest, driveId, drives) {
  const folders = declaredFolders(manifest);
  if (!folders.length) return [];
  if (!driveId) {
    if (storageRequired(manifest)) throw new AppPackageServiceError('APP_STORAGE_DRIVE_REQUIRED', `${manifest.name} keeps its files on an extra storage device. Plug one in and choose it to install.`, 409);
    return [];
  }
  const drive = (Array.isArray(drives) ? drives : []).find((item) => item.id === driveId);
  if (!drive || !drive.usable) {
    throw new AppPackageServiceError('APP_STORAGE_DRIVE_UNAVAILABLE', drive?.reason || 'The drive you chose is no longer connected. Plug it back in and try again.', 409);
  }
  return folders.map((folder) => ({ driveId, name: folder.name }));
}

module.exports = {
  declaredFolders,
  placeFolders,
  storageRequired,
};
