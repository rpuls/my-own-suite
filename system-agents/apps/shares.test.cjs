const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AppStorage } = require('./storage.cjs');
const { mountFailure, parseCredentials, parseShareAddress } = require('./shares.cjs');

const FORM = { address: '\\\\nas\\backups', folder: 'home-server', label: 'NAS backups', password: 'pa,ss=word', username: 'mos-backup' };

test('an address is read the way Windows, a NAS and a URL write it', () => {
  assert.deepEqual(parseShareAddress('\\\\nas\\backups\\home'), { folder: 'home', server: 'nas', share: 'backups' });
  assert.deepEqual(parseShareAddress('smb://192.168.1.20/backups', 'a/b'), { folder: 'a/b', server: '192.168.1.20', share: 'backups' });
  assert.deepEqual(parseShareAddress('//truenas.local/mos'), { folder: '', server: 'truenas.local', share: 'mos' });
  assert.throws(() => parseShareAddress('nas'), /\\\\server\\shared-folder/u);
  assert.throws(() => parseShareAddress('\\\\nas\\backups', '../etc'), /cannot be part of a folder name/u);
  assert.throws(() => parseShareAddress('\\\\-nas\\backups'), /not a server name/u);
});

test('a Windows domain user is split into its domain and name', () => {
  assert.deepEqual(parseCredentials('HOME\\rasmus', 'x'), { domain: 'HOME', password: 'x', username: 'rasmus' });
  assert.deepEqual(parseCredentials('rasmus', 'x'), { domain: '', password: 'x', username: 'rasmus' });
  assert.throws(() => parseCredentials('', 'x'), /username/u);
  assert.throws(() => parseCredentials('rasmus', 'line\nbreak'), /password/u);
});

test('mount.cifs refusals become one sentence each, and only a wrong place or password stops the retries', () => {
  const connection = { folder: 'home', server: 'nas', share: 'backups' };
  const said = (output) => mountFailure({ output }, connection);
  assert.match(said('mount error(13): Permission denied').reason, /refused that username and password/u);
  assert.equal(said('mount error(13): Permission denied').retry, false);
  assert.match(said('mount error(2): No such file or directory').reason, /no shared folder at nas\/backups\/home/u);
  assert.match(said('mount error(95): Operation not supported').reason, /old, unsafe version of SMB/u);
  assert.equal(said('mount error(112): Host is down').retry, true);
  assert.match(said('something new').reason, /could not open nas\/backups\/home/u);
});

function fakeNas({ answering = true, refuse = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-shares-'));
  const mounts = new Map();
  const calls = [];
  const credentials = [];
  const state = { answering, refuse };
  const executeCapture = async (file, args) => {
    if (file === 'findmnt') {
      const mount = mounts.get(args.at(-1));
      if (!mount) throw new Error('not mounted');
      return `${mount} rw,noexec\n`;
    }
    if (file === 'docker') return '';
    throw new Error(`unexpected ${file}`);
  };
  const execute = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'mount') {
      const options = args[args.indexOf('-o') + 1];
      credentials.push(fs.readFileSync(options.split('credentials=')[1], 'utf8'));
      if (state.refuse) throw Object.assign(new Error('mount failed'), { output: state.refuse });
      mounts.set(args[3], args[2]);
    }
    if (file === 'umount') mounts.delete(args[0]);
    return { stdout: '' };
  };
  const storage = new AppStorage({ execute, executeCapture, mountRoot: path.join(root, 'media'), probe: async () => state.answering, registryPath: path.join(root, 'storage.json') });
  return { calls, credentials, mounts, root, state, storage };
}

async function connectedShare(nas) {
  const id = await nas.storage.saveShare(FORM);
  await nas.storage.attach(id);
  return id;
}

test('a shared folder is tested, kept and opened like a drive, and its password never leaves the agent', async () => {
  const nas = fakeNas();
  const id = await connectedShare(nas);
  const share = (await nas.storage.drives()).find((drive) => drive.id === id);
  assert.equal(share.kind, 'share');
  assert.equal(share.state, 'ready');
  assert.equal(share.mountPath, path.posix.join(path.join(nas.root, 'media'), id));
  assert.deepEqual(share.share, { address: '\\\\nas\\backups', folder: 'home-server', server: 'nas', share: 'backups', username: 'mos-backup' });
  assert.deepEqual([share.holdsAppFoldersFormat, share.holdsBackupsFormat], [true, true]);
  assert.ok(!JSON.stringify(await nas.storage.inventory()).includes('pa,ss=word'));
  assert.ok(nas.calls.every((call) => !call.join(' ').includes('pa,ss=word')));
  assert.match(nas.credentials.at(-1), /^username=mos-backup\npassword=pa,ss=word\n$/u);
  assert.ok(nas.calls.some((call) => call.includes('//nas/backups/home-server') && call.some((arg) => arg.startsWith('vers=3,soft'))));
  const lastOptions = nas.calls.filter(([file]) => file === 'mount').at(-1).at(-1);
  assert.ok(!fs.existsSync(lastOptions.split('credentials=')[1]));
});

test('a share that does not answer is listed as such and never looked into', async () => {
  const nas = fakeNas();
  const id = await connectedShare(nas);
  nas.state.answering = false;
  nas.storage.shares.probes.clear();
  const share = (await nas.storage.drives()).find((drive) => drive.id === id);
  assert.deepEqual([share.state, share.mountPath, share.availableBytes], ['unreachable', null, null]);
  assert.match(share.reason, /Nothing answered at nas/u);
  assert.deepEqual((await nas.storage.usage()).backups, []);
});

test('the reconnect loop opens a share that should be open, and leaves one the NAS refused', async () => {
  const nas = fakeNas();
  const id = await connectedShare(nas);
  nas.mounts.clear();
  assert.deepEqual(await nas.storage.sharesWaiting(), [id]);
  nas.state.refuse = 'mount error(13): Permission denied';
  await assert.rejects(nas.storage.attach(id), /refused that username and password/u);
  assert.deepEqual(await nas.storage.sharesWaiting(), []);
  const share = (await nas.storage.drives()).find((drive) => drive.id === id);
  assert.equal(share.state, 'failed');
  nas.state.refuse = null;
  await nas.storage.attach(id);
  assert.equal(nas.storage.registry.drive(id).problem, undefined);
});

test('disconnecting keeps the share listed and out of the loop; forgetting needs it closed and unclaimed', async () => {
  const nas = fakeNas();
  const id = await connectedShare(nas);
  await assert.rejects(nas.storage.forget(id), /Disconnect this shared folder before forgetting it/u);
  await nas.storage.eject(id);
  assert.equal((await nas.storage.drives()).find((drive) => drive.id === id).state, 'ejected');
  assert.deepEqual(await nas.storage.sharesWaiting(), []);
  nas.storage.claim(id, 'jellyfin', null);
  await assert.rejects(nas.storage.forget(id), /An app keeps its files/u);
  nas.storage.release('jellyfin');
  await nas.storage.forget(id);
  assert.equal((await nas.storage.drives()).some((drive) => drive.id === id), false);
});

test('an app folder on a share is claimed in the share record', async () => {
  const nas = fakeNas();
  const id = await connectedShare(nas);
  const binds = await nas.storage.prepareFolders('jellyfin', [{ drive: id, name: 'Movies', path: '/media/movies' }]);
  assert.equal(binds[0].source, path.posix.join(path.join(nas.root, 'media'), id, 'MOS-files', 'apps', 'jellyfin', 'Movies'));
  assert.deepEqual(nas.storage.registry.read().shares[id].apps, ['jellyfin']);
  assert.deepEqual(nas.storage.registry.read().drives, {});
});

test('a test that cannot save, or a server that does not answer, keeps nothing', async () => {
  const nas = fakeNas({ answering: false });
  assert.match((await nas.storage.testShare(FORM)).message, /Nothing answered at nas/u);
  await assert.rejects(nas.storage.saveShare(FORM), /Nothing answered/u);
  assert.deepEqual(nas.storage.registry.read().shares, {});
});
