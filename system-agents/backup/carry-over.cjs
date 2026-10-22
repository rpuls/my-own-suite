'use strict';

// The one compatibility bridge MOS carries: a server updated from 0.22 finds its
// backups, backup drives and storage online with nothing to do. 0.22 kept a drive's
// archive at the root of MOS-backups, drives and the primary by mount path, and
// buckets in a file of their own. Acts on sight, idempotent, deleted in a later release.

const fs = require('node:fs');
const path = require('node:path');
const { ARCHIVE_DIR_PATTERN, BACKUPS_DIR } = require('../../shared/storage-contract.cjs');
const { archiveRoot, newArchiveName, repositoryExists, repositoryPathFor, repositorySidecarPath, restorePointsDir } = require('./engines/engine.cjs');
const { isObjectDestinationId } = require('./object-destinations.cjs');
const { StorageRegistry } = require('../lib/storage-registry.cjs');

const KNOWN_DRIVES_FILENAME = 'known-drives.json';
const OBJECT_DESTINATIONS_FILENAME = 'object-destinations.json';
const KNOWN_DRIVES_VERSION = 1;

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function directoryNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function moveIfPresent(from, to) {
  if (fs.existsSync(from)) fs.renameSync(from, to);
}

// The archive folder a move cut short was filling: the one without a repository.
function unfinishedArchive(backupsRoot) {
  const candidates = directoryNames(backupsRoot).filter((name) => ARCHIVE_DIR_PATTERN.test(name) && !isDirectory(repositoryPathFor(path.join(backupsRoot, name))));
  return candidates.length === 1 ? candidates[0] : null;
}

class CarryOver {
  constructor({ agentStateDir, appAgent, lastBackups, log = () => {}, primary, registryPath }) {
    this.appAgent = appAgent;
    this.knownDrivesPath = path.join(agentStateDir, KNOWN_DRIVES_FILENAME);
    this.lastBackups = lastBackups;
    this.log = log;
    this.objectDestinationsPath = path.join(agentStateDir, OBJECT_DESTINATIONS_FILENAME);
    this.primary = primary;
    this.registry = new StorageRegistry({ registryPath });
  }

  atStart() {
    this.adoptBuckets();
    this.repointPrimary();
  }

  // Every 0.22 bucket was a backup destination. The old file held the keys and the
  // registry is their only home now, so it goes once they are in.
  adoptBuckets() {
    const stored = this.readRecords(this.objectDestinationsPath, 'destinations');
    if (!stored) return;
    const records = stored.filter((record) => isObjectDestinationId(record?.id));
    const added = this.registry.update(({ buckets }) => {
      const fresh = records.filter((record) => !buckets[record.id]);
      for (const record of fresh) buckets[record.id] = { ...record, backups: true };
      return fresh.length;
    });
    fs.rmSync(this.objectDestinationsPath, { force: true });
    this.log(`carried ${added} of ${records.length} storage connection(s) over from MOS 0.22`);
  }

  // 0.22 named a disk destination by its mount path; today it is the drive's filesystem UUID.
  repointPrimary() {
    const chosen = this.primary.read();
    if (!String(chosen?.destinationId || '').startsWith('/')) return;
    const drive = this.knownDrives().find((entry) => entry.id === chosen.destinationId);
    if (!drive) return;
    this.primary.write({ destinationId: drive.fsUuid, label: chosen.label || drive.label || null, setAt: chosen.setAt || null });
    this.log(`automatic backups carried over from ${chosen.destinationId} to drive ${drive.fsUuid}`);
  }

  // Answers with the list to survey from: re-read when a claim mounted a drive, so
  // the pass that claims a drive also adopts and lists its archive.
  async onSight(drives, refresh) {
    if (!drives) return drives;
    this.adoptLayouts(drives);
    if (!await this.claimKnownDrives(drives)) return drives;
    const fresh = await refresh();
    if (!fresh) return drives;
    this.adoptLayouts(fresh);
    return fresh;
  }

  adoptLayouts(drives) {
    for (const drive of drives) {
      if (!drive.connected || !drive.mountPath || drive.state !== 'ready' || !drive.holdsBackupsFormat) continue;
      try {
        this.adoptLayout(drive);
      } catch (error) {
        this.log(`drive ${drive.id}: backups from MOS 0.22 not moved into an archive: ${error.message}`);
      }
    }
  }

  // Renamed on the drive itself, repository last: a move cut short still shows the
  // repository at the root and is finished into the one archive folder without one.
  adoptLayout(drive) {
    const backupsRoot = path.join(drive.mountPath, BACKUPS_DIR);
    if (!repositoryExists(backupsRoot)) return;
    const name = unfinishedArchive(backupsRoot) || newArchiveName();
    const archive = archiveRoot(drive.mountPath, name);
    fs.mkdirSync(archive, { recursive: true });
    moveIfPresent(repositorySidecarPath(backupsRoot), repositorySidecarPath(archive));
    moveIfPresent(restorePointsDir(backupsRoot), restorePointsDir(archive));
    fs.renameSync(repositoryPathFor(backupsRoot), repositoryPathFor(archive));
    this.log(`drive ${drive.id}: backups from MOS 0.22 moved into ${name}`);
  }

  // Kept for backups through the storage module once connected and open; a drive in
  // a drawer, or one refused, waits in the file.
  async claimKnownDrives(drives) {
    const known = this.knownDrives();
    const kept = [];
    let mounted = false;
    for (const entry of known) {
      const drive = drives.find((item) => item.id === entry.fsUuid && item.connected);
      const open = drive?.holdsBackupsFormat && ['available', 'ready'].includes(drive.state);
      if (!drive || (!open && drive.backups !== true)) {
        kept.push(entry);
        continue;
      }
      if (drive.backups !== true) {
        try {
          await this.appAgent.holdBackups({ drive: entry.fsUuid, held: true });
        } catch {
          kept.push(entry);
          continue;
        }
        mounted = true;
        this.log(`drive ${entry.fsUuid}: kept for backups as in MOS 0.22`);
      }
      if (entry.lastBackupAt && !this.lastBackups.of(entry.fsUuid)) this.lastBackups.note(entry.fsUuid, entry.lastBackupAt);
    }
    if (kept.length !== known.length) this.writeKnownDrives(kept);
    return mounted;
  }

  knownDrives() {
    return (this.readRecords(this.knownDrivesPath, 'drives') || []).filter((drive) => typeof drive?.fsUuid === 'string');
  }

  writeKnownDrives(drives) {
    if (!drives.length) {
      fs.rmSync(this.knownDrivesPath, { force: true });
      return;
    }
    fs.writeFileSync(this.knownDrivesPath, `${JSON.stringify({ drives, version: KNOWN_DRIVES_VERSION }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  // Null when absent or unparseable, so an unreadable file is never deleted unread.
  readRecords(file, key) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed?.[key]) ? parsed[key] : null;
    } catch {
      return null;
    }
  }
}

module.exports = { CarryOver, KNOWN_DRIVES_FILENAME, OBJECT_DESTINATIONS_FILENAME };
