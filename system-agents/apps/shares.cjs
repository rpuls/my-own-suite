const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { StorageError } = require('./storage-error.cjs');

// Shared folders on the network, reached over SMB and mounted where a drive would
// be. How to reach one lives here; everything above sees a drive.

const SHARE_ID_PATTERN = /^share-[0-9a-f]{12}$/u;
const SERVER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const NAME_PATTERN = /^[^/\\:*?"<>|\u0000-\u001f]{1,80}$/u;
const SECRET_PATTERN = /^[^\r\n\u0000]{0,256}$/u;
const SMB_PORT = 445;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_TTL_MS = 5_000;
// SMB 3 or later only. Soft, with a short echo, so a NAS that goes away turns
// into errors within seconds rather than a process stuck on it. Files read as
// a drive's do: readable by any container user, written only by MOS.
const SHARE_MOUNT_OPTIONS = 'vers=3,soft,echo_interval=10,uid=0,gid=0,file_mode=0644,dir_mode=0755,nodev,nosuid,noexec';
const MOUNT_TIMEOUT_MS = 30_000;

function shareMountPath(id, root) {
  return path.posix.join(root, id);
}

function isShareId(id) {
  return SHARE_ID_PATTERN.test(String(id));
}

function newShareId() {
  return `share-${crypto.randomBytes(6).toString('hex')}`;
}

function refuse(message) {
  throw new StorageError(message);
}

function folderSegments(value) {
  const segments = String(value || '').replace(/\\/gu, '/').split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !NAME_PATTERN.test(segment)) refuse(`“${segment}” cannot be part of a folder name.`);
  }
  return segments;
}

// `\\nas\backups\home`, `//nas/backups`, `smb://192.168.1.20/backups` or
// `nas/backups`: the server, the shared folder, and any folder below it.
function parseShareAddress(address, folder = '') {
  const [server = '', share = '', ...rest] = String(address || '').trim().replace(/^smb:/iu, '').replace(/\\/gu, '/').split('/').filter(Boolean);
  if (!server || !share) refuse('Write the address as \\\\server\\shared-folder, for example \\\\nas\\backups.');
  if (!SERVER_PATTERN.test(server)) refuse(`“${server}” is not a server name or address MOS can use.`);
  if (!NAME_PATTERN.test(share)) refuse(`“${share}” is not a shared folder name MOS can use.`);
  return { folder: [...folderSegments(rest.join('/')), ...folderSegments(folder)].join('/'), server, share };
}

// `DOMAIN\user` signs in to a Windows domain; anything else is the user alone.
function parseCredentials(username, password) {
  const text = String(username || '').trim();
  if (!text || !SECRET_PATTERN.test(text)) refuse('Give the username MOS signs in with.');
  if (!SECRET_PATTERN.test(String(password ?? ''))) refuse('That password cannot be used.');
  const slash = text.indexOf('\\');
  return slash > 0 ? { domain: text.slice(0, slash), password: String(password), username: text.slice(slash + 1) } : { domain: '', password: String(password), username: text };
}

function shareSource({ folder, server, share }) {
  return `//${server}/${share}${folder ? `/${folder}` : ''}`;
}

function shareAddress({ server, share }) {
  return `\\\\${server}\\${share}`;
}

// What leaves the agent about a share: never its password.
function publicShare(record) {
  return { address: shareAddress(record), folder: record.folder || '', server: record.server, share: record.share, username: record.domain ? `${record.domain}\\${record.username}` : record.username };
}

function plainName({ folder, server, share }) {
  return `${server}/${share}${folder ? `/${folder}` : ''}`;
}

function unreachableReason(server) {
  return `Nothing answered at ${server}. Check that it is switched on and on the same network as this server; an address such as 192.168.1.20 works too.`;
}

// mount.cifs says what went wrong as a kernel error number. A wrong password is
// never retried by itself: a NAS can lock an account that keeps failing.
function mountFailure(error, connection) {
  const said = `${error?.output || ''} ${error?.message || ''}`;
  if (/error\(13\)|Permission denied/u.test(said)) return { reason: `${connection.server} refused that username and password. Check them against the user you made on the NAS.`, retry: false };
  if (/error\(2\)|No such file or directory/u.test(said)) {
    return { reason: `MOS signed in to ${connection.server}, but found no shared folder at ${plainName(connection)}. Check the spelling in the NAS's sharing settings.`, retry: false };
  }
  if (/error\(95\)|Operation not supported|error\(22\)/u.test(said)) {
    return { reason: `${connection.server} only speaks an old, unsafe version of SMB. MOS connects with SMB 3 only: turn it on in the NAS's sharing settings.`, retry: false };
  }
  if (/error\((?:111|112|113|115|110)\)|could not resolve|Host is down|No route to host|timed out/u.test(said)) return { reason: unreachableReason(connection.server), retry: true };
  if (/cifs filesystem not supported|unknown filesystem type|not installed|ENOENT/u.test(said)) {
    return { reason: 'This server is missing what it needs to open shared folders. Updating MOS installs it.', retry: false };
  }
  return { reason: `MOS could not open ${plainName(connection)}.`, retry: true };
}

function probeSmb(server, { port = SMB_PORT, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: server, port, timeout: timeoutMs });
    const done = (answered) => { socket.destroy(); resolve(answered); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function spaceOf(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return { availableBytes: stat.bavail * stat.bsize, sizeBytes: stat.blocks * stat.bsize };
  } catch {
    return null;
  }
}

class NetworkShares {
  constructor({ execute, holdsArchive, mountOn, mountRoot, now = () => new Date(), probe = probeSmb, registry }) {
    this.execute = execute;
    this.holdsArchive = holdsArchive;
    this.mountOn = mountOn;
    this.mountRoot = mountRoot;
    this.now = now;
    this.probe = probe;
    this.registry = registry;
    this.probes = new Map();
    this.attaching = new Map();
  }

  records() {
    return Object.values(this.registry.read().shares);
  }

  record(id) {
    return this.registry.read().shares[id] || refuse('MOS does not know that shared folder.');
  }

  // Asked often while a page is open, so an answer is kept for a few seconds.
  async reachable(server, { fresh = false } = {}) {
    const known = this.probes.get(server);
    if (!fresh && known && this.now() - known.at < PROBE_TTL_MS) return known.answered;
    const answered = await this.probe(server);
    this.probes.set(server, { answered, at: this.now() });
    return answered;
  }

  async mounted(record) {
    const found = await this.mountOn(shareMountPath(record.id, this.mountRoot));
    return found && found.source.toLowerCase() === shareSource(record).toLowerCase() ? found : null;
  }

  // The password reaches mount.cifs through a root-only file that lives only for
  // the mount, never through its arguments, which any process can read.
  async mount(connection, source, target) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-share-'));
    const credentials = path.join(folder, 'credentials');
    try {
      const lines = [`username=${connection.username}`, `password=${connection.password}`, ...(connection.domain ? [`domain=${connection.domain}`] : [])];
      fs.writeFileSync(credentials, `${lines.join('\n')}\n`, { mode: 0o600 });
      await this.execute('mount', ['-t', 'cifs', source, target, '-o', `${SHARE_MOUNT_OPTIONS},credentials=${credentials}`], { timeoutMs: MOUNT_TIMEOUT_MS });
    } finally {
      fs.rmSync(folder, { force: true, recursive: true });
    }
  }

  // What the storage module lists for a share. A share that does not answer is
  // never looked into, so a NAS that went away cannot stall the list.
  async describe(record) {
    const target = shareMountPath(record.id, this.mountRoot);
    const found = await this.mounted(record);
    const answering = !record.ejected && await this.reachable(record.server);
    const state = record.ejected ? 'ejected' : !answering ? 'unreachable' : found ? (found.readOnly ? 'read-only' : 'ready') : 'failed';
    const open = state === 'ready' || state === 'read-only';
    const space = open ? spaceOf(target) : null;
    const reasons = {
      ejected: 'You disconnected this shared folder. Connect it again to use it.',
      failed: record.problem?.reason || 'MOS has not opened this shared folder yet. It tries again every minute.',
      'read-only': 'Your apps can read this shared folder, but nothing can be saved to it.',
      unreachable: `${unreachableReason(record.server)} MOS keeps trying every minute.`,
    };
    return {
      apps: record.apps || [],
      availableBytes: space?.availableBytes ?? null,
      connected: true,
      detail: state === 'failed' ? record.problem?.detail || null : null,
      devicePath: null,
      fileSystem: 'cifs',
      holdsAppFoldersFormat: true,
      holdsBackups: open && this.holdsArchive([target]),
      holdsBackupsFormat: true,
      id: record.id,
      kind: 'share',
      label: record.label,
      model: null,
      mountPath: open ? target : null,
      name: record.label,
      reason: reasons[state] || null,
      removable: false,
      share: publicShare(record),
      sizeBytes: space?.sizeBytes ?? null,
      state,
      transport: 'network',
      usable: state === 'ready',
      usableForBackups: state === 'ready',
    };
  }

  // What drive operations need to know about a share, in a drive's shape.
  descriptor(record) {
    return { devicePath: null, fileSystem: 'cifs', holdsAppFoldersFormat: true, holdsBackupsFormat: true, id: record.id, label: record.label, model: null, mountpoints: [], reason: null, sizeBytes: null, transport: 'network' };
  }

  // The reconnect loop and an owner's "Try now" can ask at once; they share one mount.
  attach(id) {
    if (!this.attaching.has(id)) this.attaching.set(id, this.attachNow(id).finally(() => this.attaching.delete(id)));
    return this.attaching.get(id);
  }

  async attachNow(id) {
    const record = this.record(id);
    const target = shareMountPath(id, this.mountRoot);
    const current = await this.mountOn(target);
    if (current && current.source.toLowerCase() === shareSource(record).toLowerCase()) return { drive: this.descriptor(record), readOnly: current.readOnly, target };
    if (current) await this.execute('umount', [target], { timeoutMs: MOUNT_TIMEOUT_MS });
    if (!await this.reachable(record.server, { fresh: true })) refuse(unreachableReason(record.server));
    fs.mkdirSync(target, { recursive: true });
    try {
      await this.mount(record, shareSource(record), target);
    } catch (error) {
      const { reason, retry } = mountFailure(error, record);
      this.registry.recordDrive(id, { ejected: undefined, problem: { detail: String(error?.output || error?.message || ''), reason, retry } });
      refuse(reason);
    }
    const mounted = await this.mounted(record);
    if (!mounted) refuse(`MOS could not open ${plainName(record)}.`);
    this.registry.recordDrive(id, { ejected: undefined, problem: undefined });
    return { drive: this.descriptor(record), readOnly: mounted.readOnly, target };
  }

  async close(id) {
    const target = shareMountPath(id, this.mountRoot);
    if (!await this.mountOn(target)) return;
    try {
      await this.execute('umount', [target], { timeoutMs: 60_000 });
    } catch {
      refuse('Something on the server is still using this shared folder, so it was not disconnected. Try again in a minute.');
    }
  }

  // Shares the reconnect loop should try: not disconnected by the owner, not open,
  // answering, and not refused for a reason that trying again cannot fix.
  async waiting() {
    const ids = [];
    for (const record of this.records()) {
      if (record.ejected || record.problem?.retry === false || await this.mounted(record)) continue;
      if (await this.reachable(record.server, { fresh: true })) ids.push(record.id);
    }
    return ids;
  }

  // A connection from the form; an edit that leaves the password empty keeps the saved one.
  connectionFrom(input) {
    const saved = input.id ? this.record(input.id) : null;
    const address = parseShareAddress(input.address, input.folder);
    const credentials = parseCredentials(input.username, input.password || saved?.password || '');
    return { ...address, ...credentials };
  }

  // Signs in, makes the folder if it is missing, and saves and removes a file in
  // it, so a share that only reads is caught here rather than by the first backup.
  async test(input) {
    let connection;
    try {
      connection = this.connectionFrom(input);
    } catch (error) {
      return { message: error.message, ok: false };
    }
    if (!await this.reachable(connection.server, { fresh: true })) return { message: unreachableReason(connection.server), ok: false };
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-share-probe-'));
    try {
      try {
        await this.mount(connection, `//${connection.server}/${connection.share}`, probe);
      } catch (error) {
        return { message: mountFailure(error, connection).reason, ok: false };
      }
      try {
        const folder = path.join(probe, ...connection.folder.split('/').filter(Boolean));
        fs.mkdirSync(folder, { recursive: true });
        const testFile = path.join(folder, `.mos-test-${crypto.randomBytes(4).toString('hex')}`);
        fs.writeFileSync(testFile, 'MOS checks that it can save here.\n');
        fs.rmSync(testFile);
        const holdsBackups = this.holdsArchive([folder]);
        return {
          availableBytes: spaceOf(folder)?.availableBytes ?? null,
          holdsBackups,
          message: holdsBackups
            ? 'There are MOS backups in this shared folder already. Connect it, then find them under Backup & Restore.'
            : `MOS signed in to ${connection.server}, saved a test file in ${plainName(connection)} and removed it again.`,
          ok: true,
        };
      } catch {
        return { message: `MOS can open ${plainName(connection)} but cannot save to it. Give ${connection.username} permission to write there on the NAS, then test again.`, ok: false };
      } finally {
        await this.execute('umount', [probe], { timeoutMs: MOUNT_TIMEOUT_MS }).catch(() => {});
      }
    } finally {
      // Never recursive: if the unmount failed, this is still the NAS's folder.
      try { fs.rmdirSync(probe); } catch {}
    }
  }

  // Tested again before it is kept, so nothing the form did not prove is saved.
  // How an open share is reached is changed only after it is disconnected.
  async save(input) {
    const result = await this.test(input);
    if (!result.ok) refuse(result.message);
    const connection = this.connectionFrom(input);
    if (input.id && await this.mounted(this.record(input.id))) refuse('Disconnect this shared folder before changing how MOS reaches it.');
    const id = input.id || newShareId();
    const label = String(input.label || '').replace(/\s+/gu, ' ').trim().slice(0, 60) || `${connection.share} on ${connection.server}`;
    this.registry.update(({ shares }) => {
      const current = shares[id] || { apps: [], createdAt: this.now().toISOString() };
      shares[id] = { ...current, ...connection, id, label, problem: undefined };
    });
    return id;
  }

  async forget(id) {
    const record = this.record(id);
    if (await this.mounted(record)) refuse('Disconnect this shared folder before forgetting it.');
    if (!this.registry.forgetDrive(id)) refuse('An app keeps its files in this shared folder, so MOS keeps it.');
  }
}

module.exports = {
  NetworkShares,
  SHARE_MOUNT_OPTIONS,
  isShareId,
  mountFailure,
  parseCredentials,
  parseShareAddress,
  publicShare,
  shareSource,
};
