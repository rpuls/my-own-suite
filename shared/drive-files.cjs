'use strict';

// Paths from a browser into a drive that may have been prepared on Windows, checked
// step by step against the disk itself, for Suite Manager's reads and the agent's
// writes. Only MOS writes to a mounted drive, so nothing changes behind a check.

const fsp = require('node:fs/promises');
const path = require('node:path');

const { CodedError } = require('./coded-error.cjs');
const { FILES_DIR } = require('./storage-contract.cjs');

// MOS's own working names inside MOS-files, never listed and never given to the owner.
const RESERVED_PREFIX = '.mos-';
const UPLOADS_DIR = '.mos-uploads';
const DELETING_DIR = '.mos-deleting';
const APPS_DIR = 'apps';
const READ_ONLY_SENTENCE = 'This drive needs a check, so it opened read-only. Adding, moving and deleting are paused until Check drive in Settings → Storage puts it right.';
const MAX_NAME_BYTES = 255;
const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENTS = 64;
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/iu;

function invalid(message) {
  return new CodedError('FILES_PATH_INVALID', message, { statusCode: 400 });
}

function refused(message = 'MOS does not follow links on a drive, so this cannot be opened here.') {
  return new CodedError('FILES_PATH_REFUSED', message, { statusCode: 403 });
}

function notFound() {
  return new CodedError('FILES_NOT_FOUND', 'That is no longer on the drive.', { statusCode: 404 });
}

function isReserved(name) {
  return name.toLowerCase().startsWith(RESERVED_PREFIX);
}

function tooLong(name) {
  return Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES || name.length > MAX_NAME_BYTES;
}

// A name that already exists on the drive, as a step in a path. Lenient about
// what Windows would refuse, since the owner's laptop may have made it.
function segmentProblem(segment) {
  if (typeof segment !== 'string' || !segment) return 'A folder name in that path is empty.';
  if (segment === '.' || segment === '..') return 'That path goes outside the drive.';
  if (/[/\\\u0000]/u.test(segment) || tooLong(segment)) return 'That path is not valid.';
  if (isReserved(segment)) return 'That is part of MOS, not one of your files.';
  return null;
}

// A name MOS is about to give something: one that every computer the drive is
// plugged into can open, and that no other entry already answers to.
function nameProblem(name) {
  if (typeof name !== 'string' || !name.trim()) return 'Give it a name.';
  if (name === '.' || name === '..') return 'That name is not allowed.';
  if (WINDOWS_FORBIDDEN.test(name)) return 'A name cannot contain any of these: \\ / : * ? " < > |';
  if (/[. ]$/u.test(name)) return 'A name cannot end with a dot or a space, because Windows could not open it.';
  if (WINDOWS_DEVICE.test(name)) return 'Windows keeps that name for itself, so choose another.';
  if (tooLong(name)) return 'That name is too long.';
  if (isReserved(name)) return `Names starting with ${RESERVED_PREFIX} are MOS's own.`;
  return null;
}

function checkedName(name) {
  const problem = nameProblem(name);
  if (problem) throw invalid(problem);
  return name.normalize('NFC');
}

// The drives MOS writes to treat two names as one when Windows would, so a new
// name is compared by this, never byte for byte.
function foldKey(name) {
  return name.normalize('NFC').toUpperCase();
}

// "" is the top of MOS-files; anything else is names joined by "/".
function parseRelativePath(relative) {
  if (relative === undefined || relative === null || relative === '') return [];
  if (typeof relative !== 'string' || relative.length > MAX_PATH_LENGTH) throw invalid('That path is not valid.');
  if (relative.startsWith('/') || /^[A-Za-z]:/u.test(relative)) throw invalid('That path goes outside the drive.');
  const segments = relative.split('/');
  if (segments.length > MAX_SEGMENTS) throw invalid('That path is too deep.');
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) throw invalid(problem);
  }
  return segments;
}

function filesRootOf(mountPath) {
  return path.posix.join(mountPath, FILES_DIR);
}

function entryKind(stat) {
  if (stat.isDirectory()) return 'folder';
  if (stat.isFile()) return 'file';
  return null;
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// MOS-files itself, which a hostile drive could have made a junction to anywhere.
async function openRoot(filesRoot) {
  const stat = await lstatOrNull(filesRoot);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused();
  const real = await fsp.realpath(filesRoot);
  if (real !== path.join(await fsp.realpath(path.dirname(filesRoot)), path.basename(filesRoot))) throw refused();
  return { dev: stat.dev, real, stat };
}

// The entry `segments` names, proven to be inside MOS-files by what is on disk:
// each step exists under exactly that name, is no link, and is on the same
// filesystem. `reserved` lets the agent reach its own working folders.
async function resolveExisting(filesRoot, segments, { reserved = false } = {}) {
  const root = await openRoot(filesRoot);
  if (!root) throw notFound();
  let current = root.real;
  let stat = root.stat;
  for (const [index, segment] of segments.entries()) {
    if (!reserved || index > 0 || !isReserved(segment)) {
      const problem = segmentProblem(segment);
      if (problem) throw invalid(problem);
    }
    if (!stat.isDirectory()) throw notFound();
    // A case-insensitive drive opens "APPS" as "apps"; only the name as written counts.
    if (!(await fsp.readdir(current)).includes(segment)) throw notFound();
    current = path.join(current, segment);
    stat = await lstatOrNull(current);
    if (!stat) throw notFound();
    if (stat.isSymbolicLink()) throw refused();
    if (stat.dev !== root.dev) throw refused('That is on another drive, so it cannot be opened here.');
  }
  if (await fsp.realpath(current) !== current) throw refused();
  if (!entryKind(stat)) throw refused('That is not a file or a folder.');
  return { absolute: current, kind: entryKind(stat), root: root.real, segments, stat };
}

// Where a new entry called `name` would go inside the folder `parentSegments`.
async function resolveNew(filesRoot, parentSegments, name) {
  const fresh = checkedName(name);
  const parent = await resolveExisting(filesRoot, parentSegments);
  if (parent.kind !== 'folder') throw notFound();
  const taken = (await fsp.readdir(parent.absolute)).find((existing) => foldKey(existing) === foldKey(fresh));
  if (taken) throw new CodedError('FILES_NAME_TAKEN', `Something called ${taken} is already here.`, { statusCode: 409 });
  return { absolute: path.join(parent.absolute, fresh), name: fresh, parent, segments: [...parentSegments, fresh] };
}

function isWithin(segments, ancestor) {
  return ancestor.length <= segments.length && ancestor.every((segment, index) => segments[index] === segment);
}

// MOS's own folder tree for apps: `apps`, one folder per app, and inside that
// the folders an app reads, which stay put while the app is on the drive.
// `claimedApps` are the package ids that mount folders from this drive.
function changeRefusal(segments, claimedApps = []) {
  if (!segments.length) return 'The top of the drive stays where it is.';
  if (segments[0] !== APPS_DIR) return null;
  if (segments.length <= 2) return 'MOS keeps your apps\' folders here, so this stays where it is.';
  if (segments.length === 3 && claimedApps.includes(segments[1])) return 'An app reads this folder, so it stays where it is. Move what is inside it instead.';
  return null;
}

function addRefusal(parentSegments) {
  if (parentSegments[0] === APPS_DIR && parentSegments.length <= 2) return 'Add files inside one of the app\'s folders, not beside them.';
  return null;
}

module.exports = {
  APPS_DIR,
  DELETING_DIR,
  READ_ONLY_SENTENCE,
  RESERVED_PREFIX,
  UPLOADS_DIR,
  addRefusal,
  changeRefusal,
  checkedName,
  entryKind,
  filesRootOf,
  foldKey,
  isReserved,
  isWithin,
  nameProblem,
  openRoot,
  parseRelativePath,
  resolveExisting,
  resolveNew,
};
