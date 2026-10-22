// The storage module's one list. The app agent knows every drive and bucket and
// what claims each; the backup agent knows what the backups there amount to. Both
// are merged here by identity, and every screen and picker reads this list.

const { FORMATTED_DRIVE_LABEL } = require('../../../../shared/storage-contract.cjs');
const { STICK_ACTION, stickDevicePath, stickJobId } = require('../apps/drive-jobs.cjs');

const SYSTEM_ID = 'system';
// lsblk and one findmnt per drive: cheap enough to ask every few seconds while a
// page is open, and quick enough that an unplug shows before the owner looks away.
const WATCH_INTERVAL_MS = 3_000;

// A drive's own files can be browsed while it is plugged in, in a format any
// computer reads; one MOS keeps nothing on yet is opened by the first look.
// They change only while it is open read-write.
function capabilitiesOf(entry) {
  const none = { browsable: false, checkable: false, ejectable: false, holdsAppFolders: false, holdsBackups: false, renamable: false, writable: false };
  if (entry.kind === 'system') return none;
  if (entry.kind === 'bucket') return { ...none, holdsBackups: true, renamable: true };
  const open = entry.connected && (entry.state === 'ready' || entry.state === 'read-only') && Boolean(entry.mountPath);
  return {
    browsable: entry.holdsAppFoldersFormat === true && (open || (entry.connected && entry.state === 'available')),
    checkable: entry.connected && entry.fileSystem === 'ntfs' && (entry.state === 'read-only' || entry.state === 'failed'),
    ejectable: open,
    holdsAppFolders: entry.holdsAppFoldersFormat === true,
    holdsBackups: entry.holdsBackupsFormat === true,
    renamable: true,
    writable: open && entry.holdsAppFoldersFormat === true && entry.state === 'ready',
  };
}

// What backups mean for one piece of storage, as the backup agent states it:
// whether this server backs up there, and the archives other servers left on
// it. Null when neither.
function backupFacts(storageId, status, { held }) {
  const destination = (status?.destinations || []).find((item) => item.id === storageId) || null;
  const others = (status?.archives || []).filter((archive) => archive.placeId === storageId && archive.owner === 'other');
  if (!destination && !held && !others.length) return null;
  return {
    destination: Boolean(destination || (held && !others.length)),
    lastBackupAt: destination?.lastBackupAt || null,
    otherServers: others.map(({ id, keyState, newestAt, restorePoints, writtenBy }) => ({ id, keyState, newestAt: newestAt || null, restorePoints: restorePoints ?? null, writtenBy })),
    primary: storageId === (status?.primaryDestination?.destinationId || null),
    ready: destination?.state === 'ready',
    restorePoints: destination?.ownArchive?.restorePoints ?? 0,
    storedBytes: destination?.ownArchive?.storedBytes ?? null,
  };
}

function driveEntry(drive, status) {
  const entry = {
    apps: drive.apps || [],
    availableBytes: drive.availableBytes,
    backups: backupFacts(drive.id, status, { held: drive.backups }),
    connected: drive.connected,
    detail: drive.detail || null,
    devicePath: drive.devicePath || null,
    fileSystem: drive.fileSystem || null,
    holdsAppFoldersFormat: drive.holdsAppFoldersFormat,
    holdsBackupsFormat: drive.holdsBackupsFormat,
    id: drive.id,
    kind: 'drive',
    label: drive.label,
    model: drive.model || null,
    mountPath: drive.mountPath || null,
    name: drive.name || drive.label,
    named: Boolean(drive.name),
    reason: drive.reason || null,
    removable: drive.removable === true,
    sizeBytes: drive.sizeBytes,
    state: drive.state,
    transport: drive.transport || null,
  };
  return { ...entry, capabilities: capabilitiesOf(entry) };
}

// A connection whose one archive another server made is reachable, and listed
// only as that archive; so is one MOS has not heard back from yet.
function bucketEntry(bucket, status) {
  const destination = (status?.destinations || []).find((item) => item.id === bucket.id);
  const archive = (status?.archives || []).find((item) => item.placeId === bucket.id);
  const reachable = destination ? destination.state === 'ready' : archive ? true : null;
  const entry = {
    apps: [],
    availableBytes: null,
    backups: backupFacts(bucket.id, status, { held: bucket.backups }),
    bucket: { accessKeyId: bucket.accessKeyId, bucket: bucket.bucket, endpoint: bucket.endpoint, folder: bucket.folder || '', region: bucket.region || '' },
    connected: true,
    detail: destination?.reason || null,
    id: bucket.id,
    kind: 'bucket',
    label: bucket.label,
    name: bucket.label,
    named: true,
    reason: reachable === false ? destination.reason || 'MOS could not reach this storage.' : null,
    sizeBytes: null,
    state: reachable === false ? 'unreachable' : 'ready',
  };
  return { ...entry, capabilities: capabilitiesOf(entry) };
}

// The bar spans what MOS itself takes, what the apps take and what is left for
// them; the disk's own size is said in words, since part of it is neither.
function systemEntry(system) {
  const known = system && system.systemBytes !== null && system.availableBytes !== null;
  const entry = {
    apps: [],
    availableBytes: system?.availableBytes ?? null,
    backups: null,
    connected: true,
    diskSizeBytes: system?.sizeBytes ?? null,
    encrypted: system?.encrypted === true,
    id: SYSTEM_ID,
    kind: 'system',
    label: 'System drive',
    model: system?.model || null,
    name: 'System drive',
    named: false,
    reason: null,
    sizeBytes: known ? system.systemBytes + system.appsBytes + system.availableBytes : null,
    state: 'ready',
    systemUsage: known ? { appsBytes: system.appsBytes, systemBytes: system.systemBytes } : null,
  };
  return { ...entry, capabilities: capabilitiesOf(entry) };
}

// What a plug, an unplug, a rename or a finished check changes in the list.
function signatureOf(found) {
  return JSON.stringify([
    (found.drives || []).map((drive) => [drive.id, drive.state, drive.connected, drive.mountPath, drive.name]),
    (found.installerSticks || []).map((stick) => stick.devicePath),
    (found.buckets || []).map((bucket) => [bucket.id, bucket.label, bucket.backups]),
  ]);
}

class StorageService {
  constructor({ appAgent, backupAgent, driveJobs = null, names = () => new Map(), watchIntervalMs = WATCH_INTERVAL_MS }) {
    this.appAgent = appAgent;
    this.backupAgent = backupAgent;
    this.driveJobs = driveJobs;
    this.names = names;
    this.watchIntervalMs = watchIntervalMs;
    this.listeners = new Set();
    this.watchTimer = null;
    this.lastSignature = null;
  }

  // A page showing storage is told when it changed, so it never shows a drive
  // that was pulled a minute ago. One poll serves every open page, and runs only
  // while one is open.
  subscribe(listener) {
    this.listeners.add(listener);
    this.watchTimer ??= setInterval(() => void this.watch(), this.watchIntervalMs);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      clearInterval(this.watchTimer);
      this.watchTimer = null;
      this.lastSignature = null;
    };
  }

  async watch() {
    if (this.watching) return;
    this.watching = true;
    try {
      const found = await Promise.resolve(this.appAgent.storageInventory()).catch(() => null);
      if (!found) return;
      const signature = signatureOf(found);
      if (this.lastSignature !== null && signature !== this.lastSignature) for (const listener of this.listeners) listener();
      this.lastSignature = signature;
    } finally {
      this.watching = false;
    }
  }

  // Null when the app agent cannot say, which every screen treats as "not known".
  async inventory() {
    const [found, status] = await Promise.all([
      Promise.resolve(this.appAgent.storageInventory()).catch(() => null),
      Promise.resolve(this.backupAgent.status()).catch(() => null),
    ]);
    if (!found) return null;
    const storage = [
      systemEntry(found.system),
      ...(found.drives || []).map((drive) => driveEntry(drive, status)),
      ...(found.buckets || []).map((bucket) => bucketEntry(bucket, status)),
    ].map((entry) => ({ ...entry, job: this.driveJobs?.get(entry.id) || null }));
    return {
      appNames: Object.fromEntries([...this.names()].map(([packageId, { name }]) => [packageId, name])),
      backupsKnown: Boolean(status),
      formattedLabel: FORMATTED_DRIVE_LABEL,
      installerSticks: (found.installerSticks || []).map((stick) => ({ ...stick, job: this.driveJobs?.get(stickJobId(stick.devicePath)) || null })),
      storage,
    };
  }

  async entry(id) {
    const listed = await this.inventory();
    return listed?.storage.find((item) => item.id === id) || null;
  }

  // One drive as the app agent sees it right now, without asking the backup agent:
  // what the files screen checks before every read.
  async drive(id) {
    const found = await Promise.resolve(this.appAgent.storageInventory()).catch(() => null);
    const drive = found?.drives?.find((item) => item.id === id);
    return drive ? driveEntry(drive, null) : null;
  }

  // What each app folder and each backup store takes on the drives open right now.
  async usage() {
    const answer = await Promise.resolve(this.appAgent.storageUsage()).catch(() => null);
    if (!answer) return null;
    const names = this.names();
    return {
      backups: answer.backups || [],
      folders: (answer.folders || []).map((folder) => ({ ...folder, appName: names.get(folder.app)?.name || folder.app, installed: names.get(folder.app)?.installed === true })),
    };
  }

  rename(id, name) {
    return this.appAgent.renameStorage({ id, name: String(name ?? '') });
  }

  // What a drive job does: Check, Eject, "use it again" after Eject, or formatting
  // the install stick. The agent stops and starts the apps reading the drive itself.
  driveAction(id, action) {
    if (action === STICK_ACTION) return this.formatInstallerStick(stickDevicePath(id));
    if (action === 'check') return this.appAgent.checkDrive({ drive: id });
    if (action === 'eject') return this.appAgent.ejectDrive({ drive: id });
    return this.appAgent.useDrive({ drive: id });
  }

  // Making storage a backup destination is a claim the storage module records;
  // this server's archive on it is created by the first backup. Archives other
  // servers left there stay beside it and never stand in its way.
  async holdBackups(storageId, { primary = false } = {}) {
    const entry = await this.entry(storageId);
    if (!entry) throw Object.assign(new Error('That storage is no longer connected.'), { code: 'STORAGE_NOT_FOUND', statusCode: 404 });
    if (!entry.capabilities.holdsBackups) throw Object.assign(new Error(entry.reason || 'This storage cannot hold backups.'), { code: 'STORAGE_CANNOT_HOLD_BACKUPS', statusCode: 409 });
    if (entry.kind === 'bucket') await this.backupAgent.holdObjectBackups({ destinationId: storageId, held: true });
    else await this.appAgent.holdBackups({ drive: storageId, held: true });
    const status = await this.backupAgent.status();
    const destination = (status.destinations || []).find((item) => item.id === storageId) || null;
    if (primary && destination) await this.backupAgent.setPrimaryDestination({ destinationId: destination.id });
    return { destination };
  }

  async releaseBackups(storageId) {
    const entry = await this.entry(storageId);
    if (!entry) throw Object.assign(new Error('That storage is no longer connected.'), { code: 'STORAGE_NOT_FOUND', statusCode: 404 });
    if (entry.backups?.primary) throw Object.assign(new Error('Automatic backups go here. Choose another place for them first.'), { code: 'STORAGE_IS_PRIMARY', statusCode: 409 });
    if (entry.kind === 'bucket') await this.backupAgent.holdObjectBackups({ destinationId: storageId, held: false });
    else await this.appAgent.holdBackups({ drive: storageId, held: false });
    return { released: true };
  }

  // A drive that is away and that no app reads. Backups going to it are let go
  // with it, unless automatic backups go there.
  async forgetDrive(driveId) {
    const entry = await this.entry(driveId);
    if (entry?.backups?.primary) throw Object.assign(new Error('Automatic backups go to this drive. Choose another place for them first.'), { code: 'STORAGE_IS_PRIMARY', statusCode: 409 });
    return this.appAgent.forgetDrive({ drive: driveId });
  }

  async formatInstallerStick(devicePath) {
    const listed = await this.inventory();
    if (!listed?.installerSticks.some((stick) => stick.devicePath === devicePath)) {
      throw Object.assign(new Error('The MOS install stick is no longer plugged in, so nothing was erased.'), { code: 'STORAGE_NOT_FOUND', statusCode: 404 });
    }
    return this.appAgent.formatInstallerStick({ devicePath });
  }
}

module.exports = { StorageService, capabilitiesOf };
