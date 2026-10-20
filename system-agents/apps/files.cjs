const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { CodedError } = require('../../shared/coded-error.cjs');
const {
  ABANDONED_UPLOAD_MS,
  APPS_DIR,
  DELETING_DIR,
  MAX_UPLOAD_CHUNK_BYTES,
  READ_ONLY_SENTENCE,
  UPLOAD_ID_PATTERN,
  UPLOAD_STAGING_DIRNAME,
  UPLOADS_DIR,
  addRefusal,
  changeRefusal,
  checkedName,
  deleteRefusal,
  filesRootOf,
  foldKey,
  isWithin,
  openRoot,
  parseRelativePath,
  resolveExisting,
  resolveNew,
} = require('../../shared/drive-files.cjs');
const { STORAGE_MOUNT_ROOT } = require('../../shared/storage-contract.cjs');
const { driveMountPath } = require('./storage.cjs');

// The writing half of the files screen, so the app agent stays the only writer to
// drives. Each change proves the drive is the mount first, so nothing ever lands on
// the system disk in its place.

const UPLOAD_STAGING_ROOT = process.env.MOS_FILE_UPLOAD_ROOT || `/var/lib/mos/suite-manager/${UPLOAD_STAGING_DIRNAME}`;
const MAX_PATHS_PER_REQUEST = 200;
const SWEEP_EVERY_MS = 10 * 60_000;
const WRITABLE_KERNEL_FILESYSTEMS = ['exfat', 'ntfs3', 'vfat'];
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function filesError(code, message, statusCode = 409, details) {
  return new CodedError(code, message, { details, statusCode });
}

function driveFull(name) {
  return filesError('FILES_DRIVE_FULL', `The drive is full, so ${name || 'that'} was not added.`, 507);
}

// What a write turned into when the drive changed under it.
function writeFailure(error, name) {
  if (error?.code === 'EROFS') return filesError('FILES_DRIVE_READ_ONLY', READ_ONLY_SENTENCE);
  if (error?.code === 'ENOSPC') return driveFull(name);
  return error;
}

function assertUploadId(uploadId) {
  if (!UPLOAD_ID_PATTERN.test(String(uploadId))) throw filesError('FILES_UPLOAD_INVALID', 'That upload is not valid.', 400);
  return uploadId;
}

function assertPaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS_PER_REQUEST) throw filesError('FILES_PATH_INVALID', 'Choose what to change.', 400);
  return paths.map(parseRelativePath);
}

async function copyAll(from, to) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (;;) {
    const { bytesRead } = await from.read(buffer, 0, buffer.length, null);
    if (!bytesRead) return;
    await to.write(buffer, 0, bytesRead);
  }
}

function sameFolder(left, right) {
  return left.length === right.length && isWithin(left, right);
}

class DriveFiles {
  constructor({ execute, executeCapture, mountRoot = STORAGE_MOUNT_ROOT, now = () => Date.now(), registry, stagingRoot = UPLOAD_STAGING_ROOT }) {
    this.execute = execute;
    this.executeCapture = executeCapture;
    this.mountRoot = mountRoot;
    this.now = now;
    this.registry = registry;
    this.stagingRoot = stagingRoot;
    this.sweptAt = new Map();
    this.erasing = new Set();
  }

  claimedApps(driveId) {
    return this.registry.drive(driveId)?.apps || [];
  }

  async mountOf(target) {
    const output = await this.executeCapture('findmnt', ['--raw', '--noheadings', '--output', 'SOURCE,OPTIONS,FSTYPE', '--mountpoint', target], { timeoutMs: 10_000 }).catch(() => '');
    const [source, options = '', fileSystem = ''] = String(output || '').trim().split('\n')[0].split(' ');
    return source ? { fileSystem, readOnly: options.split(',').includes('ro') } : null;
  }

  // The drive, proven mounted read-write in a format any computer opens.
  async openDrive(driveId) {
    const target = driveMountPath(driveId, this.mountRoot);
    const mount = await this.mountOf(target);
    if (!mount) throw filesError('FILES_DRIVE_AWAY', 'The drive is not connected, so nothing was changed.');
    if (!WRITABLE_KERNEL_FILESYSTEMS.includes(mount.fileSystem)) throw filesError('FILES_DRIVE_UNSUITED', 'Files can only be added to drives formatted as exFAT, NTFS or FAT32.');
    if (mount.readOnly) throw filesError('FILES_DRIVE_READ_ONLY', READ_ONLY_SENTENCE);
    const filesRoot = filesRootOf(target);
    return { claimed: this.claimedApps(driveId), driveId, filesRoot, rooted: Boolean(await openRoot(filesRoot)), target };
  }

  // MOS-files is made on the drive if this is the first thing kept there.
  async writableDrive(driveId) {
    const drive = await this.openDrive(driveId);
    if (!drive.rooted) await fsp.mkdir(drive.filesRoot).catch((error) => { throw writeFailure(error); });
    this.sweepSoon(drive);
    return drive;
  }

  // ntfs3 marks a drive dirty at its first write and clean again when flushed,
  // so a drive unplugged after a change here does not come back needing a check.
  async flush(target) {
    await this.execute('sync', ['--file-system', target], { timeoutMs: 120_000 }).catch(() => {});
  }

  async createFolder({ drive, name, path: parentPath }) {
    const { filesRoot, target } = await this.writableDrive(drive);
    const parent = parseRelativePath(parentPath);
    const refusal = addRefusal(parent);
    if (refusal) throw filesError('FILES_PROTECTED', refusal);
    const fresh = await resolveNew(filesRoot, parent, name);
    await fsp.mkdir(fresh.absolute).catch((error) => { throw writeFailure(error, fresh.name); });
    await this.flush(target);
    return { path: fresh.segments.join('/') };
  }

  async rename({ drive, name, path: entryPath }) {
    const { claimed, filesRoot, target } = await this.writableDrive(drive);
    const segments = parseRelativePath(entryPath);
    const refusal = changeRefusal(segments, claimed);
    if (refusal) throw filesError('FILES_PROTECTED', refusal);
    const entry = await resolveExisting(filesRoot, segments);
    const fresh = checkedName(name);
    const parent = segments.slice(0, -1);
    const destination = foldKey(fresh) === foldKey(segments.at(-1))
      ? path.join(path.dirname(entry.absolute), fresh)
      : (await resolveNew(filesRoot, parent, fresh)).absolute;
    await fsp.rename(entry.absolute, destination).catch((error) => { throw writeFailure(error); });
    await this.flush(target);
    return { path: [...parent, fresh].join('/') };
  }

  // Within one drive a move is a rename, so a whole library moves at once. Every
  // entry is checked before the first one moves.
  async move({ drive, paths, to }) {
    const { claimed, filesRoot, target } = await this.writableDrive(drive);
    const sources = assertPaths(paths);
    const destination = parseRelativePath(to);
    const refusal = addRefusal(destination);
    if (refusal) throw filesError('FILES_PROTECTED', refusal);
    const folder = await resolveExisting(filesRoot, destination);
    if (folder.kind !== 'folder') throw filesError('FILES_NOT_FOUND', 'That folder is no longer on the drive.', 404);
    const present = new Map((await fsp.readdir(folder.absolute)).map((name) => [foldKey(name), name]));
    const planned = [];
    for (const segments of sources) {
      const sourceRefusal = changeRefusal(segments, claimed);
      if (sourceRefusal) throw filesError('FILES_PROTECTED', sourceRefusal);
      const name = segments.at(-1);
      if (sameFolder(segments.slice(0, -1), destination)) throw filesError('FILES_ALREADY_THERE', `${name} is already in that folder.`);
      if (isWithin(destination, segments)) throw filesError('FILES_INTO_ITSELF', `${name} cannot go inside itself.`);
      if (present.has(foldKey(name))) throw filesError('FILES_NAME_TAKEN', `Something called ${present.get(foldKey(name))} is already in that folder.`);
      present.set(foldKey(name), name);
      planned.push({ from: (await resolveExisting(filesRoot, segments)).absolute, to: path.join(folder.absolute, name) });
    }
    for (const step of planned) await fsp.rename(step.from, step.to).catch((error) => { throw writeFailure(error); });
    await this.tidyLeftovers(filesRoot, claimed);
    await this.flush(target);
    return { moved: planned.length };
  }

  // Answers once everything is moved aside, so a 200 GB folder is gone from the
  // owner's view at once; the disk space comes back as it is erased behind that.
  async remove({ drive, paths }) {
    const { claimed, filesRoot, target } = await this.writableDrive(drive);
    const entries = [];
    for (const segments of assertPaths(paths)) {
      const refusal = deleteRefusal(segments, claimed);
      if (refusal) throw filesError('FILES_PROTECTED', refusal);
      entries.push(await resolveExisting(filesRoot, segments));
    }
    const bin = await this.ownFolder(filesRoot, DELETING_DIR);
    const doomed = [];
    for (const entry of entries) {
      const aside = path.join(bin, crypto.randomUUID());
      await fsp.rename(entry.absolute, aside).catch((error) => { throw writeFailure(error); });
      doomed.push(aside);
    }
    void this.erase(doomed, { claimed, filesRoot, target });
    return { deleted: entries.length };
  }

  async erase(doomed, { claimed = [], filesRoot, target }) {
    for (const aside of doomed) this.erasing.add(aside);
    for (const aside of doomed) {
      await fsp.rm(aside, { force: true, recursive: true }).catch((error) => process.stderr.write(`[mos-app-agent] ${aside} was not fully erased: ${error.message}\n`));
      this.erasing.delete(aside);
    }
    await this.tidyLeftovers(filesRoot, claimed).catch(() => {});
    await this.flush(target);
  }

  // The folder of an app no longer on the drive goes once nothing is left in it,
  // so the apps folder stops listing it once its last folder is deleted.
  async tidyLeftovers(filesRoot, claimed) {
    const apps = await resolveExisting(filesRoot, [APPS_DIR]).catch(() => null);
    if (!apps) return;
    for (const app of await fsp.readdir(apps.absolute)) {
      if (claimed.includes(app)) continue;
      const folder = await resolveExisting(filesRoot, [APPS_DIR, app]).catch(() => null);
      if (folder?.kind === 'folder' && !(await fsp.readdir(folder.absolute)).length) await fsp.rmdir(folder.absolute).catch(() => {});
    }
  }

  // MOS's working folder inside MOS-files, made on first use.
  async ownFolder(filesRoot, name) {
    const existing = await resolveExisting(filesRoot, [name], { reserved: true }).catch((error) => (error.code === 'FILES_NOT_FOUND' ? null : Promise.reject(error)));
    if (existing) return existing.absolute;
    const created = path.join((await openRoot(filesRoot)).real, name);
    await fsp.mkdir(created).catch((error) => { if (error.code !== 'EEXIST') throw writeFailure(error); });
    return (await resolveExisting(filesRoot, [name], { reserved: true })).absolute;
  }

  async partialOf(filesRoot, uploadId) {
    return path.join(await this.ownFolder(filesRoot, UPLOADS_DIR), assertUploadId(uploadId));
  }

  // Where an upload stands. Bytes past what Suite Manager last confirmed are cut
  // off, because a write cut short by a pulled cable is not known to be whole.
  async uploadOffset({ acknowledged, drive, uploadId }) {
    const { filesRoot } = await this.writableDrive(drive);
    const partial = await this.partialOf(filesRoot, uploadId);
    const handle = await fsp.open(partial, fs.constants.O_RDWR | fs.constants.O_CREAT | NO_FOLLOW, 0o644).catch((error) => { throw writeFailure(error); });
    try {
      const { size } = await handle.stat();
      const confirmed = Number.isSafeInteger(acknowledged) && acknowledged >= 0 ? acknowledged : 0;
      if (size > confirmed) await handle.truncate(confirmed);
      return { offset: Math.min(size, confirmed) };
    } finally {
      await handle.close();
    }
  }

  // The chunk Suite Manager staged, opened so that nothing it planted there can
  // stand in for it: no link, no second name for another file, only its own.
  async openStagedChunk(uploadId) {
    const root = path.resolve(this.stagingRoot);
    if (await fsp.realpath(root) !== root) throw filesError('FILES_UPLOAD_INVALID', 'The upload staging folder is not where MOS expects it.', 500);
    const owner = (await fsp.stat(root)).uid;
    const handle = await fsp.open(path.join(root, `${uploadId}.chunk`), fs.constants.O_RDONLY | NO_FOLLOW).catch(() => null);
    if (!handle) throw filesError('FILES_UPLOAD_INVALID', 'That part of the upload did not arrive.', 400);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner || stat.size > MAX_UPLOAD_CHUNK_BYTES) {
      await handle.close();
      throw filesError('FILES_UPLOAD_INVALID', 'That part of the upload is not valid.', 400);
    }
    return { handle, size: stat.size };
  }

  async uploadAppend({ drive, offset, uploadId }) {
    assertUploadId(uploadId);
    const { filesRoot } = await this.writableDrive(drive);
    const partialPath = await this.partialOf(filesRoot, uploadId);
    const chunk = await this.openStagedChunk(uploadId);
    let partial = null;
    try {
      partial = await fsp.open(partialPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | NO_FOLLOW).catch((error) => {
        throw error.code === 'ENOENT' ? filesError('FILES_UPLOAD_GONE', 'MOS lost track of this upload, so it starts again.', 410) : writeFailure(error);
      });
      const { size } = await partial.stat();
      if (size !== offset) throw filesError('FILES_UPLOAD_OFFSET', 'The upload continues from where the drive has it.', 409, [String(size)]);
      try {
        await copyAll(chunk.handle, partial);
        await partial.datasync();
      } catch (error) {
        if (error.code === 'ENOSPC') {
          await partial.close();
          partial = null;
          await fsp.rm(partialPath, { force: true });
        }
        throw writeFailure(error);
      }
      return { offset: size + chunk.size };
    } finally {
      await chunk.handle.close();
      await partial?.close();
      await fsp.rm(path.join(this.stagingRoot, `${uploadId}.chunk`), { force: true });
    }
  }

  async uploadFinish({ drive, name, path: parentPath, size, uploadId }) {
    const { filesRoot, target } = await this.writableDrive(drive);
    const parent = parseRelativePath(parentPath);
    const refusal = addRefusal(parent);
    if (refusal) throw filesError('FILES_PROTECTED', refusal);
    const partial = await this.partialOf(filesRoot, uploadId);
    const stat = await fsp.lstat(partial).catch(() => null);
    if (!stat?.isFile()) throw filesError('FILES_UPLOAD_GONE', 'MOS lost track of this upload, so it starts again.', 410);
    if (stat.size !== size) throw filesError('FILES_UPLOAD_INCOMPLETE', 'Not all of the file has arrived yet.', 409, [String(stat.size)]);
    let fresh;
    try {
      fresh = await resolveNew(filesRoot, parent, name);
    } catch (error) {
      if (error.code === 'FILES_NAME_TAKEN') await fsp.rm(partial, { force: true });
      throw error;
    }
    await fsp.rename(partial, fresh.absolute).catch((error) => { throw writeFailure(error, fresh.name); });
    await this.flush(target);
    return { path: fresh.segments.join('/') };
  }

  // Best effort: a drive that left or turned read-only keeps the partial until
  // the next sweep after it is back.
  async uploadCancel({ drive, uploadId }) {
    assertUploadId(uploadId);
    await fsp.rm(path.join(this.stagingRoot, `${uploadId}.chunk`), { force: true });
    const opened = await this.writableDrive(drive).catch(() => null);
    if (opened) await fsp.rm(await this.partialOf(opened.filesRoot, uploadId), { force: true });
    return { cancelled: true };
  }

  sweepSoon(drive) {
    const at = this.now();
    if (at - (this.sweptAt.get(drive.driveId) || 0) < SWEEP_EVERY_MS) return;
    this.sweptAt.set(drive.driveId, at);
    void this.sweepDrive(drive).catch(() => {});
  }

  // What a restart or a pulled drive left: deletions that never finished, and
  // uploads nobody has added to for a day.
  async sweepDrive(drive) {
    const { filesRoot } = drive;
    const bin = await resolveExisting(filesRoot, [DELETING_DIR], { reserved: true }).catch(() => null);
    if (bin) {
      const doomed = (await fsp.readdir(bin.absolute)).map((name) => path.join(bin.absolute, name)).filter((aside) => !this.erasing.has(aside));
      if (doomed.length) await this.erase(doomed, drive);
    }
    const uploads = await resolveExisting(filesRoot, [UPLOADS_DIR], { reserved: true }).catch(() => null);
    if (!uploads) return;
    for (const name of await fsp.readdir(uploads.absolute)) {
      const partial = path.join(uploads.absolute, name);
      const stat = await fsp.lstat(partial).catch(() => null);
      if (stat && this.now() - stat.mtimeMs > ABANDONED_UPLOAD_MS) await fsp.rm(partial, { force: true, recursive: true });
    }
  }

  // At start, every drive mounted read-write that has MOS-files; a read-only one
  // is swept on its first change after its check.
  async sweepAll() {
    for (const driveId of await fsp.readdir(this.mountRoot).catch(() => [])) {
      const drive = await this.openDrive(driveId).catch(() => null);
      if (!drive?.rooted) continue;
      this.sweptAt.set(driveId, this.now());
      await this.sweepDrive(drive).catch(() => {});
    }
  }
}

const FIELD_CHECKS = {
  acknowledged: Number.isSafeInteger,
  drive: (value) => /^[A-Za-z0-9-]{4,64}$/u.test(String(value)),
  name: (value) => typeof value === 'string',
  offset: (value) => Number.isSafeInteger(value) && value >= 0,
  path: (value) => typeof value === 'string',
  paths: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
  size: (value) => Number.isSafeInteger(value) && value >= 0,
  to: (value) => typeof value === 'string',
  uploadId: (value) => UPLOAD_ID_PATTERN.test(String(value)),
};

// Exactly the fields each request names, each of the right type, or a refusal.
function request(input, fields) {
  const keys = Object.keys(input && typeof input === 'object' && !Array.isArray(input) ? input : {});
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field) && FIELD_CHECKS[field](input[field]))) {
    throw filesError('FILES_REQUEST_INVALID', 'That file request is not valid.', 400);
  }
  return input;
}

function filesRoutes(files) {
  return {
    'POST /v1/files/folder': async (body) => files.createFolder(request(body, ['drive', 'name', 'path'])),
    'POST /v1/files/rename': async (body) => files.rename(request(body, ['drive', 'name', 'path'])),
    'POST /v1/files/move': async (body) => files.move(request(body, ['drive', 'paths', 'to'])),
    'POST /v1/files/delete': async (body) => files.remove(request(body, ['drive', 'paths'])),
    'POST /v1/files/upload/offset': async (body) => files.uploadOffset(request(body, ['acknowledged', 'drive', 'uploadId'])),
    'POST /v1/files/upload/append': async (body) => files.uploadAppend(request(body, ['drive', 'offset', 'uploadId'])),
    'POST /v1/files/upload/finish': async (body) => files.uploadFinish(request(body, ['drive', 'name', 'path', 'size', 'uploadId'])),
    'POST /v1/files/upload/cancel': async (body) => files.uploadCancel(request(body, ['drive', 'uploadId'])),
  };
}

module.exports = { DriveFiles, MAX_PATHS_PER_REQUEST, READ_ONLY_SENTENCE, UPLOAD_ID_PATTERN, UPLOAD_STAGING_ROOT, filesRoutes };
