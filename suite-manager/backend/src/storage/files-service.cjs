const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { CodedError } = require('../../../../shared/coded-error.cjs');
const {
  ABANDONED_UPLOAD_MS,
  APPS_DIR,
  MAX_UPLOAD_CHUNK_BYTES,
  NOT_MANAGED_SENTENCE,
  READ_ONLY_SENTENCE,
  addRefusal,
  changeRefusal,
  deleteRefusal,
  entryKind,
  filesRootOf,
  foldKey,
  isHousekeeping,
  isReserved,
  nameProblem,
  parseRelativePath,
  placeOnDrive,
  resolveExisting,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_ID_PATTERN,
  uploadStagingRoot,
} = require('../../../../shared/drive-files.cjs');
const { BACKUPS_DIR, FILES_DIR } = require('../../../../shared/storage-contract.cjs');

// The files screen in Suite Manager: it reads drives itself and stages uploads a
// chunk at a time for the app agent, the only writer. Each chunk is one request of
// a few seconds, so no proxy timeout can cut a film-sized upload.

const MAX_OPEN_UPLOADS = 32;
const MAX_CHUNKS_IN_FLIGHT = 3;
const CHUNK_IDLE_MS = 60_000;
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
// Folder sizes are walked for a listing until this many entries have been seen;
// past it a folder shows how many items it holds but not their size.
const SIZE_WALK_BUDGET = 20_000;
// What one agent request carries, under the agent's 64 KiB body limit.
const BATCH_PATHS = 200;
const BATCH_BYTES = 48 * 1024;
const MAX_SELECTION = 5_000;

function filesError(code, message, statusCode, extra = {}) {
  return new CodedError(code, message, { statusCode, ...extra });
}

const UPLOAD_LOST = () => filesError('FILES_UPLOAD_GONE', 'MOS lost track of this upload, so it starts again.', 410);
const TOP_ADD_REFUSAL = 'Open MOS-files to add files.';
const MOS_FILES_LOCKED = 'MOS keeps your files here, so this stays where it is.';
const BACKUPS_LOCKED = 'Your backups are opened in Backups.';

function refusedAlways(sentence) {
  return { change: sentence, delete: sentence };
}

// The path inside MOS-files that a path from the top of the drive names, for a
// change; anything outside MOS-files is only ever read.
function managedPath(relative) {
  const { inner } = placeOnDrive(parseRelativePath(relative));
  if (!inner) throw filesError('FILES_NOT_MANAGED', NOT_MANAGED_SENTENCE, 409);
  return inner.join('/');
}

function withPrefix(inner) {
  return [FILES_DIR, ...inner].join('/');
}

// Why a drive's files cannot be opened, in the owner's words.
function closedReason(drive) {
  if (!drive.capabilities.holdsAppFolders) return 'Files can only be browsed on drives formatted as exFAT, NTFS or FAT32.';
  if (drive.state === 'away') return 'Plug the drive in to browse its files.';
  if (drive.state === 'ejected') return 'This drive was ejected. Use it again in Settings → Storage to browse its files.';
  return drive.reason || 'MOS could not open this drive.';
}

function byName(left, right) {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}

// RFC 6266: an ASCII stand-in for old browsers, then the real name.
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// One `bytes=` range, or null for the whole file; false when it cannot be served.
function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { end, start } : false;
}

function batchesOf(paths) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const item of paths) {
    const size = Buffer.byteLength(item) + 4;
    if (current.length && (current.length >= BATCH_PATHS || bytes + size > BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function selection(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SELECTION || !paths.every((item) => typeof item === 'string')) {
    throw filesError('FILES_PATH_INVALID', 'Choose what to change.', 400);
  }
  paths.forEach(parseRelativePath);
  return paths;
}

// Counts what a request body carries and stops it at `limit`.
function limitTo(limit) {
  let seen = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(filesError('FILES_CHUNK_TOO_LARGE', 'That part of the upload is larger than MOS accepts.', 413));
      else callback(null, chunk);
    },
  });
  return { counter, received: () => seen };
}

class FilesService {
  constructor({ appAgent, now = () => Date.now(), stateDir, storage }) {
    this.appAgent = appAgent;
    this.now = now;
    this.storage = storage;
    this.stagingRoot = uploadStagingRoot(stateDir);
    this.inFlight = new Map();
  }

  async openDrive(driveId) {
    let drive = await this.storage.drive(driveId);
    if (drive?.capabilities.browsable && !drive.mountPath) {
      await this.appAgent.openDrive({ drive: driveId });
      drive = await this.storage.drive(driveId);
    }
    if (!drive) throw filesError('FILES_DRIVE_NOT_FOUND', 'That drive is not connected.', 404);
    if (!drive.capabilities.browsable || !drive.mountPath) throw filesError('FILES_NOT_BROWSABLE', closedReason(drive), 409);
    return drive;
  }

  async writableDrive(driveId) {
    const drive = await this.openDrive(driveId);
    if (!drive.capabilities.writable) throw filesError('FILES_DRIVE_READ_ONLY', READ_ONLY_SENTENCE, 409);
    return drive;
  }

  appNamed(id) {
    return this.storage.names().get(id)?.name || id;
  }

  // The size under a folder, walked until the budget runs out; null past it.
  async folderFacts(dir, budget) {
    const top = (await fsp.readdir(dir).catch(() => [])).filter((name) => !isReserved(name));
    let bytes = 0;
    const pending = [dir];
    while (pending.length) {
      const current = pending.pop();
      for (const name of await fsp.readdir(current).catch(() => [])) {
        if (current === dir && isReserved(name)) continue;
        if (--budget.left < 0) return { bytes: null, items: top.length };
        const stat = await fsp.lstat(path.join(current, name)).catch(() => null);
        if (stat?.isDirectory()) pending.push(path.join(current, name));
        else if (stat?.isFile()) bytes += stat.size;
      }
    }
    return { bytes, items: top.length };
  }

  // Files and folders only: links, MOS's own working folders and anything else
  // a drive can hold are left out, because none of them can be acted on here.
  async entriesOf(dir, budget, { skip = () => false } = {}) {
    const entries = [];
    for (const name of await fsp.readdir(dir)) {
      if (isReserved(name) || skip(name)) continue;
      const stat = await fsp.lstat(path.join(dir, name)).catch(() => null);
      const kind = stat && !stat.isSymbolicLink() ? entryKind(stat) : null;
      if (!kind) continue;
      const facts = kind === 'folder' ? await this.folderFacts(path.join(dir, name), budget) : { bytes: stat.size, items: null };
      entries.push({ ...facts, kind, modifiedAt: stat.mtime.toISOString(), name });
    }
    return entries.sort(byName);
  }

  // Whether the app an app folder is named after reads this drive: null when it
  // does, else why its folder is only left here.
  appState(name, drive) {
    if (drive.apps.includes(name)) return null;
    return this.storage.names().get(name)?.installed === true ? 'elsewhere' : 'not-installed';
  }

  // In the apps folder, a folder whose app does not read this drive is told apart
  // and listed after the ones in use.
  withAppStates(entries, drive) {
    const marked = entries.map((entry) => {
      const appState = entry.kind === 'folder' ? this.appState(entry.name, drive) : null;
      return { ...entry, appName: appState ? this.appNamed(entry.name) : null, appState };
    });
    return [...marked.filter((entry) => !entry.appState), ...marked.filter((entry) => entry.appState)];
  }

  // The top of the drive: MOS's two folders first, then whatever else is on it,
  // without what the computers it was used with keep there for themselves.
  async topEntries(drive, budget) {
    const found = (await this.entriesOf(drive.mountPath, budget, { skip: (name) => isHousekeeping(name) || name === BACKUPS_DIR }))
      .map((entry) => ({ ...entry, managed: entry.name === FILES_DIR, refusals: refusedAlways(entry.name === FILES_DIR ? MOS_FILES_LOCKED : NOT_MANAGED_SENTENCE) }));
    const mosFiles = found.find((entry) => entry.name === FILES_DIR && entry.kind === 'folder')
      || { bytes: 0, items: 0, kind: 'folder', managed: true, modifiedAt: new Date(this.now()).toISOString(), name: FILES_DIR, refusals: refusedAlways(MOS_FILES_LOCKED) };
    const backups = await resolveExisting(drive.mountPath, [BACKUPS_DIR]).catch(() => null);
    const backupsEntry = backups?.kind === 'folder'
      ? [{ bytes: null, items: null, kind: 'folder', managed: true, modifiedAt: backups.stat.mtime.toISOString(), name: BACKUPS_DIR, refusals: refusedAlways(BACKUPS_LOCKED), special: 'backups' }]
      : [];
    return [mosFiles, ...backupsEntry, ...found.filter((entry) => entry.name !== FILES_DIR)];
  }

  async managedListing(drive, inner, budget) {
    const folder = await resolveExisting(filesRootOf(drive.mountPath), inner).catch((error) => {
      if (error.code === 'FILES_NOT_FOUND' && !inner.length) return null;
      throw error;
    });
    if (folder && folder.kind !== 'folder') throw filesError('FILES_NOT_A_FOLDER', 'That is a file, not a folder.', 400);
    const listed = folder ? await this.entriesOf(folder.absolute, budget) : [];
    const entries = inner.length === 1 && inner[0] === APPS_DIR ? this.withAppStates(listed, drive) : listed;
    const appId = inner[0] === APPS_DIR ? inner[1] : undefined;
    return {
      addRefusal: addRefusal(inner),
      app: appId ? { id: appId, name: this.appNamed(appId), readsDrive: drive.apps.includes(appId), state: this.appState(appId, drive) } : null,
      entries: entries.map((entry) => {
        const segments = [...inner, entry.name];
        return { ...entry, managed: true, refusals: { change: changeRefusal(segments, drive.apps), delete: deleteRefusal(segments, drive.apps) } };
      }),
    };
  }

  // A path is named from the top of the drive. MOS-files is MOS's and can be
  // changed; everything else on the drive is listed to look at and download.
  async list(driveId, relative) {
    const drive = await this.openDrive(driveId);
    const segments = parseRelativePath(relative);
    const { inner } = placeOnDrive(segments);
    const budget = { left: SIZE_WALK_BUDGET };
    let shown;
    if (inner) shown = await this.managedListing(drive, inner, budget);
    else if (!segments.length) shown = { addRefusal: TOP_ADD_REFUSAL, app: null, entries: await this.topEntries(drive, budget) };
    else {
      const folder = await resolveExisting(drive.mountPath, segments);
      if (folder.kind !== 'folder') throw filesError('FILES_NOT_A_FOLDER', 'That is a file, not a folder.', 400);
      shown = { addRefusal: NOT_MANAGED_SENTENCE, app: null, entries: (await this.entriesOf(folder.absolute, budget)).map((entry) => ({ ...entry, managed: false, refusals: refusedAlways(NOT_MANAGED_SENTENCE) })) };
    }
    const entries = shown.entries.map((entry) => ({ appName: null, appState: null, special: null, ...entry }));
    return {
      addRefusal: shown.addRefusal,
      app: shown.app,
      drive: { availableBytes: drive.availableBytes, id: drive.id, name: drive.name, state: drive.state, writable: drive.capabilities.writable },
      entries,
      managed: Boolean(inner),
      path: segments.join('/'),
      segments,
      totals: { bytes: entries.some((entry) => entry.bytes === null) ? null : entries.reduce((sum, entry) => sum + entry.bytes, 0), items: entries.length },
    };
  }

  // Where a move can take things on this drive: the top of MOS-files, the folders
  // there, and every app folder on it.
  async destinations(driveId) {
    const drive = await this.writableDrive(driveId);
    const filesRoot = filesRootOf(drive.mountPath);
    const top = await resolveExisting(filesRoot, []).catch(() => null);
    if (!top) return { destinations: [{ label: FILES_DIR, path: FILES_DIR }] };
    const folders = async (segments) => {
      const at = await resolveExisting(filesRoot, segments).catch(() => null);
      if (at?.kind !== 'folder') return [];
      const names = [];
      for (const name of (await fsp.readdir(at.absolute)).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))) {
        const stat = isReserved(name) ? null : await fsp.lstat(path.join(at.absolute, name)).catch(() => null);
        if (stat?.isDirectory()) names.push(name);
      }
      return names;
    };
    const destinations = [{ label: FILES_DIR, path: FILES_DIR }];
    for (const name of await folders([])) {
      if (name !== APPS_DIR) destinations.push({ label: name, path: withPrefix([name]) });
    }
    for (const app of await folders([APPS_DIR])) {
      for (const name of await folders([APPS_DIR, app])) destinations.push({ label: `${app} › ${name}`, path: withPrefix([APPS_DIR, app, name]) });
    }
    return { destinations };
  }

  async streamDownload(driveId, relative, request, response) {
    const drive = await this.openDrive(driveId);
    const segments = parseRelativePath(relative);
    const { inner } = placeOnDrive(segments);
    const entry = inner ? await resolveExisting(filesRootOf(drive.mountPath), inner) : await resolveExisting(drive.mountPath, segments);
    if (entry.kind !== 'file') throw filesError('FILES_NOT_A_FILE', 'Only files can be downloaded, one at a time.', 400);
    const handle = await fsp.open(entry.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const { size } = await handle.stat();
    const range = byteRange(request.headers.range, size);
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Disposition': contentDisposition(entry.segments.at(-1)),
      'Content-Type': 'application/octet-stream',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    };
    if (range === false) {
      await handle.close();
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    const { end, start } = range || { end: size - 1, start: 0 };
    response.writeHead(range ? 206 : 200, {
      ...headers,
      'Content-Length': String(Math.max(0, end - start + 1)),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (!size) {
      await handle.close();
      response.end();
      return;
    }
    await pipeline(handle.createReadStream({ end, start }), response).catch(() => {});
  }

  async createFolder(driveId, { name, path: parent }) {
    if (!parent) throw filesError('FILES_PROTECTED', TOP_ADD_REFUSAL, 409);
    const made = await this.appAgent.filesCreateFolder({ drive: driveId, name: String(name ?? ''), path: managedPath(String(parent)) });
    return { path: withPrefix(parseRelativePath(made.path)) };
  }

  async rename(driveId, { name, path: entry }) {
    const renamed = await this.appAgent.filesRename({ drive: driveId, name: String(name ?? ''), path: managedPath(String(entry ?? '')) });
    return { path: withPrefix(parseRelativePath(renamed.path)) };
  }

  async move(driveId, { paths, to }) {
    const inner = selection(paths).map(managedPath);
    const destination = managedPath(String(to ?? ''));
    let moved = 0;
    for (const batch of batchesOf(inner)) moved += (await this.appAgent.filesMove({ drive: driveId, paths: batch, to: destination })).moved;
    return { moved };
  }

  async remove(driveId, { confirmed, paths }) {
    if (confirmed !== true) throw filesError('CONFIRMATION_REQUIRED', 'Confirm that these are the only copies and may be deleted.', 400);
    const inner = selection(paths).map(managedPath);
    let deleted = 0;
    for (const batch of batchesOf(inner)) deleted += (await this.appAgent.filesDelete({ drive: driveId, paths: batch })).deleted;
    return { deleted };
  }

  sessionPath(uploadId) {
    return path.join(this.stagingRoot, `${uploadId}.json`);
  }

  chunkPath(uploadId) {
    return path.join(this.stagingRoot, `${uploadId}.chunk`);
  }

  async sessions() {
    const names = await fsp.readdir(this.stagingRoot).catch(() => []);
    const found = [];
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      try { found.push(JSON.parse(await fsp.readFile(path.join(this.stagingRoot, name), 'utf8'))); } catch {}
    }
    return found;
  }

  async session(driveId, uploadId) {
    if (!UPLOAD_ID_PATTERN.test(String(uploadId))) throw UPLOAD_LOST();
    const found = await fsp.readFile(this.sessionPath(uploadId), 'utf8').then(JSON.parse, () => null);
    if (found?.driveId !== driveId) throw UPLOAD_LOST();
    return found;
  }

  async saveSession(session) {
    await fsp.mkdir(this.stagingRoot, { mode: 0o700, recursive: true });
    const next = { ...session, updatedAt: this.now() };
    const temporary = `${this.sessionPath(session.id)}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await fsp.rename(temporary, this.sessionPath(session.id));
    return next;
  }

  async dropSession(uploadId) {
    await fsp.rm(this.sessionPath(uploadId), { force: true });
    await fsp.rm(this.chunkPath(uploadId), { force: true });
  }

  // Starts a file, or finds the one already under way for the same file into the
  // same folder, so a page reloaded mid-film carries on where the drive has it.
  async beginUpload(driveId, input) {
    const drive = await this.writableDrive(driveId);
    if (!input.path) throw filesError('FILES_PROTECTED', TOP_ADD_REFUSAL, 409);
    const segments = parseRelativePath(managedPath(String(input.path)));
    const refusal = addRefusal(segments);
    if (refusal) throw filesError('FILES_PROTECTED', refusal, 409);
    const problem = nameProblem(input.name);
    if (problem) throw filesError('FILES_PATH_INVALID', problem, 400);
    const { lastModified, size } = input;
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(lastModified)) throw filesError('FILES_UPLOAD_INVALID', 'That file cannot be added.', 400);
    const name = input.name.normalize('NFC');
    const folder = segments.join('/');
    const open = await this.sessions();
    const sameTarget = (session) => session.driveId === driveId && session.path === folder && foldKey(session.name) === foldKey(name);
    let session = open.find((item) => sameTarget(item) && item.size === size && item.lastModified === lastModified);
    if (!session) {
      if (open.some(sameTarget)) throw filesError('FILES_NAME_TAKEN', `${name} is already being added here.`, 409);
      const parent = await resolveExisting(filesRootOf(drive.mountPath), segments);
      if (parent.kind !== 'folder') throw filesError('FILES_NOT_A_FOLDER', 'That is a file, not a folder.', 400);
      const taken = (await fsp.readdir(parent.absolute)).find((existing) => foldKey(existing) === foldKey(name));
      if (taken) throw filesError('FILES_NAME_TAKEN', `Something called ${taken} is already here.`, 409);
      if (open.length >= MAX_OPEN_UPLOADS) throw filesError('FILES_BUSY', 'Too many files are being added at once. Let some finish first.', 429, { retryAfterSeconds: 30 });
      session = { acknowledged: 0, createdAt: this.now(), driveId, id: crypto.randomUUID(), lastModified, name, path: folder, size };
    }
    const missing = size - session.acknowledged;
    if (drive.availableBytes !== null && missing > drive.availableBytes - FREE_SPACE_MARGIN_BYTES) {
      throw filesError('FILES_DRIVE_FULL', `There is not room on ${drive.name} for ${name}.`, 507);
    }
    await this.takeOver(session.id);
    const { offset } = await this.appAgent.filesUploadOffset({ acknowledged: session.acknowledged, drive: driveId, uploadId: session.id });
    await this.saveSession({ ...session, acknowledged: offset });
    return { chunkBytes: UPLOAD_CHUNK_BYTES, offset, uploadId: session.id };
  }

  // One chunk: staged on the system disk, appended to the drive by the agent,
  // and only then counted, so a cut connection never leaves a gap or a repeat.
  async appendChunk(driveId, uploadId, offset, request) {
    const session = await this.session(driveId, uploadId);
    await this.takeOver(uploadId);
    if (offset !== session.acknowledged) throw filesError('FILES_UPLOAD_OFFSET', 'The upload continues from where the drive has it.', 409, { details: [String(session.acknowledged)] });
    if (this.inFlight.size >= MAX_CHUNKS_IN_FLIGHT) throw filesError('FILES_BUSY', 'MOS is busy adding other files. This one carries on in a moment.', 429, { retryAfterSeconds: 2 });
    let settle;
    const entry = { appending: false, done: new Promise((resolve) => { settle = resolve; }), request };
    this.inFlight.set(uploadId, entry);
    request.setTimeout(CHUNK_IDLE_MS, () => request.destroy(filesError('FILES_CHUNK_STALLED', 'That part of the upload stopped arriving.', 408)));
    try {
      const { counter, received } = limitTo(MAX_UPLOAD_CHUNK_BYTES);
      await fsp.mkdir(this.stagingRoot, { mode: 0o700, recursive: true });
      await pipeline(request, counter, fs.createWriteStream(this.chunkPath(uploadId), { mode: 0o600 }));
      if (!received() || offset + received() > session.size) throw filesError('FILES_UPLOAD_INVALID', 'That part of the upload does not fit the file.', 400);
      entry.appending = true;
      const answer = await this.appAgent.filesUploadAppend({ drive: driveId, offset, uploadId });
      await this.saveSession({ ...session, acknowledged: answer.offset });
      return { offset: answer.offset };
    } catch (error) {
      await fsp.rm(this.chunkPath(uploadId), { force: true });
      if (error.code === 'FILES_DRIVE_FULL' || error.code === 'FILES_UPLOAD_GONE') await this.dropSession(uploadId);
      throw error;
    } finally {
      if (this.inFlight.get(uploadId) === entry) this.inFlight.delete(uploadId);
      settle();
    }
  }

  // Chunks come one at a time, so a new request for an upload means the last one
  // was cut on its way: one still arriving is dropped, one being written waited out.
  async takeOver(uploadId) {
    const stale = this.inFlight.get(uploadId);
    if (!stale) return;
    if (stale.appending) throw filesError('FILES_BUSY', 'The last part is still being written to the drive.', 429, { retryAfterSeconds: 2 });
    stale.request.destroy();
    await stale.done;
  }

  async finishUpload(driveId, uploadId) {
    const session = await this.session(driveId, uploadId);
    if (session.acknowledged !== session.size) throw filesError('FILES_UPLOAD_INCOMPLETE', 'Not all of the file has arrived yet.', 409, { details: [String(session.acknowledged)] });
    try {
      const answer = await this.appAgent.filesUploadFinish({ drive: driveId, name: session.name, path: session.path, size: session.size, uploadId });
      await this.dropSession(uploadId);
      return { ...answer, path: withPrefix(parseRelativePath(answer.path)) };
    } catch (error) {
      if (['FILES_NAME_TAKEN', 'FILES_UPLOAD_GONE', 'FILES_NOT_FOUND'].includes(error.code)) await this.dropSession(uploadId);
      throw error;
    }
  }

  async cancelUpload(driveId, uploadId) {
    const session = await this.session(driveId, uploadId);
    await this.appAgent.filesUploadCancel({ drive: driveId, uploadId: session.id }).catch(() => {});
    await this.dropSession(uploadId);
    return { cancelled: true };
  }

  // At start nothing is mid-chunk, and an upload nobody touched for a day is over;
  // the agent drops its half on the drive by the same clock.
  async sweep() {
    await fsp.mkdir(this.stagingRoot, { mode: 0o700, recursive: true });
    for (const name of await fsp.readdir(this.stagingRoot)) {
      const file = path.join(this.stagingRoot, name);
      if (!name.endsWith('.json')) {
        await fsp.rm(file, { force: true, recursive: true });
        continue;
      }
      const session = await fsp.readFile(file, 'utf8').then(JSON.parse, () => null);
      if (!session || this.now() - (session.updatedAt || 0) > ABANDONED_UPLOAD_MS) await fsp.rm(file, { force: true });
    }
  }
}

module.exports = { FilesService, batchesOf, byteRange, contentDisposition };
