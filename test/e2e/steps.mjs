// What every step token means, how long it may take, and the named paths built
// from them. Pure on purpose: the CLI lists and resolves paths with no browser,
// and the unit tests hold it to naming no app.

export const STEPS = {
  reset: { arg: 'none', budgetMinutes: 5, describe: 'Reset the lab to first-run setup: apps, owner, settings and the domain go; backups stay.' },
  owner: { arg: 'none', budgetMinutes: 4, describe: 'Create the owner, or sign in, and answer the terms and handover gates.' },
  homepage: { arg: 'none', budgetMinutes: 6, describe: 'Add a website and a home-network app to Homepage, to look for after a restore.' },
  'homepage-check': { arg: 'none', budgetMinutes: 4, describe: 'The Homepage entries `homepage` added are still there.' },
  drive: { arg: 'filesystem', budgetMinutes: 2, describe: 'Give the lab a drive for apps that keep files on one, unless it has one already: a FAT32 disk image on a loop device, or NTFS for `drive:ntfs`.' },
  'drive-pull': { arg: 'none', budgetMinutes: 8, describe: "Pull the apps' drive out without ejecting it and plug it back in; an NTFS drive must come back read-only with its apps running on it." },
  'drive-check': { arg: 'none', budgetMinutes: 15, describe: 'Check the read-only drive from Settings, and wait until it works read-write with its apps running.' },
  'drive-eject': { arg: 'none', budgetMinutes: 10, describe: 'Eject the drive from Settings, unplug it and plug it back in; it must come back working with no check.' },
  'power-cut': { arg: 'none', budgetMinutes: 15, describe: 'Reset the lab on the spot with the drive mounted, as a power cut would; an NTFS drive must come back read-only with its apps running.' },
  'drive-files': { arg: 'none', budgetMinutes: 30, describe: "In the files screen of the apps' drive: make a folder, add a multi-GB file while the connection is cut twice, download it back byte for byte, rename it, move it, and delete the lot." },
  'drive-files-read-only': { arg: 'none', budgetMinutes: 5, describe: "The apps' drive needs a check: its files can be browsed and downloaded, and every change is refused." },
  'drive-files-live': { arg: 'none', budgetMinutes: 10, describe: "Eject the apps' drive under an open files screen, which closes, then plug it back in, and the screen opens again without a reload." },
  'drive-files-leftovers': { arg: 'none', budgetMinutes: 5, describe: 'The folder an uninstalled app left on a drive is listed last and greyed in the apps folder, and deleting it whole from its row gives the space back.' },
  reboot: { arg: 'none', budgetMinutes: 15, describe: "Restart the lab; every drive open before is open again, with the same app folders, uninstalled apps' included." },
  dns01: { arg: 'none', budgetMinutes: 10, describe: 'Move the suite to the DNS-01 domain in test/e2e/.env; later steps use its https address.' },
  install: { arg: 'app', budgetMinutes: 25, describe: 'Install the app from the Apps screen with its Homepage tile, and wait until it runs.' },
  app: { arg: 'app', budgetMinutes: 20, describe: "Open the app from its Homepage tile and run the app's own journey." },
  verify: { arg: 'app', budgetMinutes: 12, describe: "Run the app's own check that what its journey made is still there." },
  update: { arg: 'app', budgetMinutes: 30, describe: 'Review and apply the update the app is offered, and wait until the new version runs.' },
  lifecycle: { arg: 'app', budgetMinutes: 15, describe: 'Stop the app, start it again, and wait until it runs.' },
  tiles: { arg: 'none', budgetMinutes: 6, describe: 'Every installed app tile on Homepage leads to that app on the current address.' },
  routes: { arg: 'none', budgetMinutes: 8, describe: 'Every installed app answers on its address without a server error.' },
  connect: { arg: 'none', budgetMinutes: 5, describe: 'Connect every installed app to the installed providers it can use.' },
  installed: { arg: 'apps', budgetMinutes: 1, describe: 'Exactly these apps are installed (comma-separated; `installed:` alone means none).' },
  absent: { arg: 'app', budgetMinutes: 1, describe: 'The app is not installed.' },
  uninstall: { arg: 'app', budgetMinutes: 3, describe: 'Uninstall the app; folders it kept on a drive stay there.' },
  backup: { arg: 'destination', budgetMinutes: 25, describe: 'Back up now, to the backup disk (`backup`) or to a new folder in the lab bucket (`backup:bucket`).' },
  restore: { arg: 'destination', budgetMinutes: 30, describe: "Restore this run's latest backup. `restore:bucket` first disconnects and reconnects the bucket, and opens it with the saved recovery key if it is locked." },
  takeover: { arg: 'none', budgetMinutes: 35, describe: "Find this run's latest disk backup beside a copy only another server's key opens: listed apart and locked, opened with that key but not changeable, and restoring from it makes this server that one, with its key and the drive." },
  'platform-update': { arg: 'wait', budgetMinutes: 50, describe: 'Apply the platform update the lab track offers. `platform-update:wait` waits up to 40 minutes for the track to move first.' },
  diagnostics: { arg: 'none', budgetMinutes: 8, describe: 'Export the diagnostics file and check it for leaked secrets, crashes and missing sections.' },
  marketing: { arg: 'none', budgetMinutes: 10, describe: 'Refresh the public site screenshots from the installed suite.' },
  compare: { arg: 'none', budgetMinutes: 5, describe: 'Pair every app screenshot taken earlier with the same one taken later; writes compare.html and compare.png.' },
  network: { arg: 'none', budgetMinutes: 2, describe: 'Check every host each app contacted, from the lab or in the browser, against the outbound list in its privacy review. The capture runs from the first step.' },
  cleanup: { arg: 'none', budgetMinutes: 10, describe: 'Delete the restore points and bucket folder this run made.' },
};

const DESTINATIONS = new Set(['local', 'bucket']);
const FILESYSTEMS = new Set(['ntfs']);

const feeds = (provider, consumer) => (provider.provides || []).some((type) => (consumer.accepts || []).includes(type));

// The app and the catalog apps it works with, read from their manifests so no path names
// a pair. Providers come first, so a consumer's journey finds them installed and running.
export function appGroup(app, catalog = []) {
  const self = catalog.find((item) => item.id === app);
  if (!self) return [app];
  const group = [self, ...catalog.filter((item) => item !== self && item.hasModule && (feeds(item, self) || feeds(self, item)))];
  const feedsGroup = (item) => group.some((other) => other !== item && feeds(item, other));
  return [...group.filter(feedsGroup), ...group.filter((item) => !feedsGroup(item))].map((item) => item.id);
}

const each = (step, apps) => apps.map((id) => `${step}:${id}`);

function installTogether(group) {
  return [...each('install', group), ...(group.length > 1 ? ['connect'] : []), ...each('app', group)];
}

export const NAMED_PATHS = {
  smoke: {
    describe: 'Reset the lab and create the owner.',
    build: () => ['reset', 'owner'],
  },
  'app-cycle': {
    app: true,
    describe: 'One app on a clean lab: back up, install, use it, restore, and prove the restore removed it.',
    build: (app) => ['reset', 'owner', 'homepage', 'backup', `install:${app}`, `app:${app}`, 'tiles', 'routes', 'restore', 'homepage-check', `absent:${app}`, 'network', 'cleanup'],
  },
  'app-dr': {
    app: true,
    describe: "Disaster recovery: the app's data survives a bucket backup, a wiped lab and a restore from the bucket, with the apps it works with installed and connected.",
    build: (app, catalog) => {
      const group = appGroup(app, catalog);
      return ['reset', 'owner', ...installTogether(group), 'backup:bucket', 'reset', 'owner', 'restore:bucket', ...each('verify', group), 'routes', 'network', 'cleanup'];
    },
  },
  'drive-drills': {
    app: true,
    describe: "The app on an NTFS drive through what real life does to one: pulled without ejecting, checked, ejected, a power cut, and a restart after it is uninstalled, its files still there after each.",
    build: (app) => [
      'reset', 'owner', 'drive:ntfs', `install:${app}`, `app:${app}`,
      'drive-pull', `verify:${app}`, 'drive-check', `verify:${app}`,
      'drive-eject', `verify:${app}`,
      'power-cut', `verify:${app}`, 'drive-check',
      `uninstall:${app}`, 'reboot',
    ],
  },
  'drive-files': {
    app: true,
    describe: "The files screen on the app's NTFS drive: browse, add, download, rename, move and delete, then read-only, ejected and replugged under an open screen, and the folders it leaves when uninstalled.",
    build: (app) => [
      'reset', 'owner', 'drive:ntfs', `install:${app}`, `app:${app}`,
      'drive-files', 'drive-pull', 'drive-files-read-only', 'drive-check', 'drive-files-live',
      `uninstall:${app}`, 'drive-files-leftovers',
    ],
  },
  'drive-dr': {
    app: true,
    describe: "The storage story: the app's files on an NTFS drive and its data in a disk backup, a reset lab restored from that backup finds its files on the drive again, and a copy of that backup only another server's key opens is taken over.",
    build: (app) => ['reset', 'owner', 'drive:ntfs', `install:${app}`, `app:${app}`, 'backup', 'reset', 'owner', 'restore', `verify:${app}`, 'takeover', 'routes', 'network', 'cleanup'],
  },
  update: {
    app: true,
    describe: 'Update insurance: the journeys, the platform update, the app update, the checks, and before/after screenshot and network reports, with the apps it works with installed and connected.',
    build: (app, catalog) => {
      const group = appGroup(app, catalog);
      return ['reset', 'owner', ...installTogether(group), 'platform-update:wait', `update:${app}`, ...each('verify', group), 'routes', 'compare', 'network'];
    },
  },
  full: {
    apps: true,
    describe: 'The whole platform with every catalog app (or the listed ones): what e2e:full ran, for all apps.',
    build: (apps, catalog) => {
      const byId = new Map(catalog.map((item) => [item.id, item]));
      const plain = apps.filter((id) => !byId.get(id)?.needsHttps);
      const secure = apps.filter((id) => byId.get(id)?.needsHttps);
      const [first, ...rest] = plain;
      if (!first) throw new Error('@full needs at least one app that works without HTTPS, so the backup it restores holds an app.');
      return [
        'reset', 'owner', 'homepage',
        `install:${first}`, 'backup',
        ...rest.map((id) => `install:${id}`),
        // Connected before the journeys, so apps that work together are used together.
        'connect', 'tiles', 'routes',
        ...plain.map((id) => `app:${id}`),
        'dns01',
        ...secure.map((id) => `install:${id}`),
        'connect', 'marketing',
        ...plain.map((id) => `verify:${id}`),
        ...secure.map((id) => `app:${id}`),
        'tiles', 'routes', 'diagnostics',
        'restore', 'homepage-check', `installed:${first}`, 'cleanup',
      ];
    },
  },
};

const STEPS_NEEDING_HTTPS = new Set(['install', 'app', 'verify', 'update', 'lifecycle']);
const STEPS_WITH_DESTINATION = new Set(['backup', 'restore']);

// A plain backup or restore goes where the lab keeps its backups: the bucket, on a lab with no backup disk.
function toLabDestination(step, backupTo) {
  if (!backupTo || step.arg !== null || !STEPS_WITH_DESTINATION.has(step.name)) return step;
  return { arg: backupTo, name: step.name, token: `${step.name}:${backupTo}` };
}

export function parseToken(text) {
  const separator = text.indexOf(':');
  if (separator === -1) return { arg: null, name: text };
  return { arg: text.slice(separator + 1), name: text.slice(0, separator) };
}

function checkStep(step, catalogIds) {
  const definition = STEPS[step.name];
  if (!definition) return `Unknown step "${step.name}". Run with --list to see them.`;
  const { arg } = step;
  switch (definition.arg) {
    case 'none':
      return arg === null ? null : `${step.name} takes no argument.`;
    case 'app':
      if (!arg) return `${step.name} needs an app: ${step.name}:<app>.`;
      return catalogIds.has(arg) ? null : `${step.name}:${arg} names no catalog app (${[...catalogIds].join(', ')}).`;
    case 'apps': {
      const unknown = String(arg || '').split(',').filter(Boolean).filter((id) => !catalogIds.has(id));
      return unknown.length ? `${step.name} names unknown apps: ${unknown.join(', ')}.` : null;
    }
    case 'destination':
      return arg === null || DESTINATIONS.has(arg) ? null : `${step.name}:${arg} is not a destination (local or bucket).`;
    case 'wait':
      return arg === null || arg === 'wait' ? null : `${step.name} takes only :wait.`;
    case 'filesystem':
      return arg === null || FILESYSTEMS.has(arg) ? null : `${step.name} takes only :ntfs.`;
    default:
      return null;
  }
}

// Expands named paths, checks every token, and puts `dns01` in front of the first
// step that needs HTTPS for an app that requires it, since a reset drops the domain.
// Likewise `drive` goes in front of the first install of an app that keeps files on
// a drive; a reset leaves the drive attached, so once is enough.
// A cloud server serves HTTPS from its first address, so `startsSecure` runs need no
// dns01, and a reset returns them to HTTPS rather than to plain HTTP.
export function resolvePath(items, catalog, { backupTo = null, eachApp = null, startsSecure = false } = {}) {
  const catalogIds = new Set(catalog.map((item) => item.id));
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const tokens = [];
  const errors = [];
  const names = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith('@')) {
      tokens.push(item);
      continue;
    }
    const pathName = item.slice(1);
    const named = NAMED_PATHS[pathName];
    if (!named) {
      errors.push(`Unknown path "${item}". Run with --list to see them.`);
      continue;
    }
    names.push(item);
    const next = items[index + 1];
    const nextIsApps = next && !next.startsWith('@') && !STEPS[parseToken(next).name] && next.split(',').every((id) => catalogIds.has(id));
    if (named.app) {
      const app = eachApp || (nextIsApps ? next : null);
      if (nextIsApps && !eachApp) index += 1;
      if (!app) {
        errors.push(`${item} needs an app, for example ${item} ${catalog[0]?.id || '<app>'}, or --each-app.`);
        continue;
      }
      if (!catalogIds.has(app)) {
        errors.push(`${item} ${app}: not a catalog app.`);
        continue;
      }
      tokens.push(...named.build(app, catalog));
    } else if (named.apps) {
      const apps = nextIsApps ? next.split(',') : catalog.filter((entry) => entry.hasModule).map((entry) => entry.id);
      if (nextIsApps) index += 1;
      try {
        tokens.push(...named.build(apps, catalog));
      } catch (error) {
        errors.push(error.message);
      }
    } else {
      tokens.push(...named.build());
    }
  }

  const steps = [];
  let secure = startsSecure;
  let drive = false;
  for (const token of tokens) {
    const step = toLabDestination({ ...parseToken(token), token }, backupTo);
    const problem = checkStep(step, catalogIds);
    if (problem) {
      errors.push(problem);
      continue;
    }
    if (step.name === 'reset') secure = startsSecure;
    if (step.name === 'dns01') secure = true;
    if (step.name === 'drive') drive = true;
    if (!drive && step.name === 'install' && byId.get(step.arg)?.keepsFilesOnDrive) {
      steps.push({ arg: null, auto: 'the app keeps its files on a drive', name: 'drive', token: 'drive' });
      drive = true;
    }
    if (!secure && STEPS_NEEDING_HTTPS.has(step.name) && byId.get(step.arg)?.needsHttps) {
      steps.push({ arg: null, auto: 'the app needs HTTPS', name: 'dns01', token: 'dns01' });
      secure = true;
    }
    steps.push(step);
  }

  const budgetMinutes = steps.reduce((total, step) => total + STEPS[step.name].budgetMinutes, 0);
  return { budgetMinutes, errors, names, steps };
}
