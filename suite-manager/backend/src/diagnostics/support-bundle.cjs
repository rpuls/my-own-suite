'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { APP_AGENT_CONTRACT_VERSION, appAgentContractVersionOf } = require('../../../../shared/app-agent-contract.cjs');
const { redactValuesWithReport } = require('../redaction.cjs');

const RULE = '─'.repeat(74);

// Every value MOS could leak into a log, gathered for redaction by exact value.
//
// This is the `secretProvider` the logger deliberately left unwired: enumerating
// every secret on the machine is affordable once per export and unaffordable per
// log line. A walk of the secret directory rather than a join across config and
// env rows, because the directory is the thing that is actually on disk — it
// still holds secrets belonging to an instance whose rows were deleted, and
// those are exactly the ones a stale log line would carry.
function collectRedactionSecrets({ httpsSecretPath = '/etc/mos/secrets/caddy-cloudflare.env', secretDir } = {}) {
  const secrets = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith('.secret')) {
        try { secrets.push(fs.readFileSync(target, 'utf8').trim()); } catch { /* unreadable is not fatal */ }
      }
    }
  };
  if (secretDir) walk(secretDir);

  // Suite Manager is unprivileged and usually cannot read this. When it can, the
  // Cloudflare token is the highest-value secret on the machine and the one most
  // likely to appear in a Caddy log line.
  try {
    for (const line of fs.readFileSync(httpsSecretPath, 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) secrets.push(line.slice(at + 1).trim().replace(/^["']|["']$/gu, ''));
    }
  } catch { /* expected: the file is root-owned */ }

  return secrets.filter(Boolean);
}

// Disk pressure is the single most common cause of an app that will not start,
// and the one thing an owner never thinks to check.
function fullFilesystems(dfOutput) {
  const full = [];
  for (const line of String(dfOutput || '').split('\n').slice(1)) {
    const percent = line.split(/\s+/u).find((token) => /^\d{1,3}%$/u.test(token));
    if (percent && Number.parseInt(percent, 10) >= 90) full.push(line.trim());
  }
  return full;
}

// The section that leads the file. Everything below it is evidence; this is the
// part a helper — or the AI they paste it into — reads first, and the reason the
// bundle is worth more than a folder of raw logs.
const DRIVE_TROUBLE = {
  away: 'is not connected.',
  failed: 'is connected but could not be opened; its apps read nothing from it.',
  'read-only': 'was opened read-only because it was not ejected cleanly; it needs Check drive.',
};

// A detail either finishes the text ("and did not start again.") or is a sentence of its own.
function issueSentence({ detail, text }) {
  if (!detail) return text;
  return /^[A-Z]/u.test(detail) ? `${text}. ${detail}` : `${text} ${detail}`;
}

function summarizeTrouble({ ai = null, apps = [], attention = [], catalog = null, collection = {}, drives = null, platform = {} }) {
  const trouble = attention.filter((issue) => issue.inDiagnostics).map(issueSentence);
  trouble.push(...aiTrouble(ai));
  if (platform.lastCheck?.reason) trouble.push(`The last update check failed: ${platform.lastCheck.reason}`);
  // A catalog that will not refresh is quiet by design — the app list and its
  // update offers fall back to the packages this MOS version shipped with — so
  // it is invisible on every screen and has to be named here or nowhere.
  if (catalog?.error) trouble.push(`The app catalog could not be read (${catalog.error.code}): ${catalog.error.message} Apps still update from the packages this MOS version shipped with, so nothing is broken, but app versions published since are not known.`);
  else if (catalog?.freshness === 'unavailable') trouble.push('The app catalog has never been fetched successfully, so no app version published since this MOS version is known.');
  else if (catalog?.freshness === 'stale') trouble.push(`The app catalog was last fetched at ${catalog.fetchedAt || 'an unknown time'} and is out of date.`);
  // Only on its own account: advisories are fetched after the catalog, so a
  // catalog error already explains their absence and saying it twice would read
  // as two problems.
  if (!catalog?.error && catalog?.advisories?.error) trouble.push(`Privacy advisories could not be read (${catalog.advisories.error.code}): ${catalog.advisories.error.message}`);
  if (platform.lastUpdate?.status === 'failed') trouble.push(`The last platform update failed at ${platform.lastUpdate.at || 'an unknown time'}: ${platform.lastUpdate.error || 'no reason was recorded.'}`);
  // Suite Manager and the app agent ship together, so a disagreement here means
  // the last update applied one and not the other. Nothing else on the server
  // says so: apps keep running, and only installing, updating or removing one
  // reports it.
  if (platform.appAgentContractVersion !== undefined && platform.appAgentContractVersion !== APP_AGENT_CONTRACT_VERSION) {
    trouble.push(platform.appAgentContractVersion === null
      ? 'The app runtime agent could not be reached, so no app can be installed, updated or removed.'
      : `The app runtime agent reports contract version ${platform.appAgentContractVersion} but this MOS needs ${APP_AGENT_CONTRACT_VERSION}, so its last update did not fully apply. Installed apps keep running; installing, updating or removing one is refused until MOS is updated again.`);
  }
  if (platform.lastHttpsApply?.status === 'failed') trouble.push(`The last HTTPS apply failed: ${platform.lastHttpsApply.errorCode || 'unknown error'} at ${platform.lastHttpsApply.at || 'an unknown time'}.`);
  // MOS cannot learn from the fleet that an Ubuntu patch is breaking servers —
  // it has no telemetry, by promise — so one person's file has to be enough to
  // act on. These three lines are what makes it so.
  const hostPatches = collection.hostPatches;
  if (hostPatches?.managedBy === 'none') trouble.push('Ubuntu security updates are not being applied automatically on this server.');
  if (hostPatches?.health?.ok === false) {
    trouble.push(`The suite did not come back cleanly after the last host patch or restart (${hostPatches.health.at || 'an unknown time'}): ${(hostPatches.health.failures || []).map((failure) => `${failure.name} is ${failure.active}`).join(', ') || 'no units were named.'}`);
  }
  if (hostPatches?.rebootRequired) trouble.push(`Ubuntu asked for a restart to finish installing ${(hostPatches.rebootPackages || []).join(', ') || 'a patch'}; the server has not been restarted since.`);
  for (const unit of collection.units || []) {
    if (unit.unread) trouble.push(`The state of ${unit.name} could not be read; it may or may not be running.`);
    else if (unit.active !== 'active') trouble.push(`Service ${unit.name} is ${unit.active}${unit.sub && unit.sub !== unit.active ? ` (${unit.sub})` : ''}.`);
  }
  for (const container of collection.containers || []) {
    if (container.troubled) trouble.push(`Container ${container.name} is ${container.status || container.state || 'in an unexpected state'}.`);
  }
  for (const app of apps) {
    if (app.lastFailure) trouble.push(`App ${app.displayName} last failed: ${app.lastFailure.errorCode} at ${app.lastFailure.completedAt || app.lastFailure.startedAt}.`);
  }
  for (const drive of drives || []) {
    if (drive.apps?.length && DRIVE_TROUBLE[drive.state]) trouble.push(`Drive ${drive.label} (used by ${drive.apps.join(', ')}) ${DRIVE_TROUBLE[drive.state]}`);
  }
  for (const line of fullFilesystems(collection.host?.disk)) trouble.push(`Filesystem is nearly full: ${line}`);
  if (collection.incomplete?.length) trouble.push(`Some information could not be collected: ${collection.incomplete.join(', ')}.`);
  return trouble;
}

// Both numbers, always, so the reader never has to know which release changed
// the contract to see that the two ends disagree.
function appAgentLine(reported) {
  if (reported === undefined) return 'not collected';
  return `contract ${reported === null ? 'unreachable' : reported}, MOS needs ${APP_AGENT_CONTRACT_VERSION}`;
}

function section(title, body) {
  const content = String(body ?? '').trimEnd();
  return `${RULE}\n${title}\n${RULE}\n${content || '(nothing recorded)'}\n\n`;
}

function indent(text, depth = 2) {
  return String(text).split('\n').map((line) => `${' '.repeat(depth)}${line}`).join('\n');
}

// The last time the update agent asked its origin what is new. When that
// failed, what the agent found out about why goes under it: the origin's own
// answer to a plain request, and the login sources git on the server could
// have used.
function lastCheckLines(check) {
  if (!check?.at) return ['Update check       not available'];
  if (!check.reason) return [`Update check       ok at ${check.at}`];
  return [`Update check       failed at ${check.at}`, indent(check.diagnostics || check.reason)];
}

// The latest platform update, as one line, with the reason and the failing
// step's last output under it when it failed.
function lastUpdateLines(job) {
  if (!job?.status) return ['Last update        none recorded'];
  const lines = [`Last update        ${job.status}${job.stage && job.stage !== job.status ? ` (${job.stage})` : ''} at ${job.at || 'an unknown time'}`];
  if (job.status === 'failed') {
    lines.push(indent(job.error || 'No reason was recorded.'));
    if (job.output) lines.push(indent(job.output, 4));
  }
  return lines;
}

// Where the app list and its update offers came from. Parallel to the update
// check above: the other conversation this server has with GitHub, and the first
// thing to look at when an app update the owner expected is not being offered.
function catalogLines(catalog) {
  if (!catalog) return ['App catalog        not collected'];
  const lines = [
    `App catalog        ${catalog.freshness}${catalog.ref ? ` on ${catalog.ref}` : ''}${catalog.revision ? ` at ${catalog.revision.slice(0, 12)}` : ''}${catalog.fetchedAt ? `, fetched ${catalog.fetchedAt}` : ''}`,
    `Catalog source     ${catalog.repository || 'unknown'}`,
  ];
  if (catalog.checkedAt) {
    const outcome = catalog.error ? `failed${catalog.error.failures > 1 ? `, ${catalog.error.failures} in a row` : ''}` : 'succeeded';
    lines.push(`Catalog check      ${outcome} at ${catalog.checkedAt}${catalog.nextCheckAt ? `, next ${catalog.nextCheckAt}` : ''}`);
  }
  if (catalog.error) {
    lines.push(`Catalog error      ${catalog.error.code}${catalog.error.step ? ` while ${catalog.error.step}` : ''}`, indent(catalog.error.message, 19));
  }
  if (catalog.advisories) {
    lines.push(`Advisories         ${catalog.advisories.freshness}${typeof catalog.advisories.count === 'number' ? `, ${catalog.advisories.count} published` : ''}`);
    if (catalog.advisories.error) lines.push(`Advisory error     ${catalog.advisories.error.code}`, indent(catalog.advisories.error.message, 19));
  }
  return lines;
}

// Ubuntu's own patch state, beside the MOS update check above it: the same
// question about the layer underneath. `managedBy` leads because every number
// under it means something different depending on who is applying the patches.
function hostPatchLines(patches) {
  if (!patches) return ['Host patching      not collected'];
  if (!patches.available) return ['Host patching      could not be read on this server'];
  const lines = [
    `Host patching      ${patches.managedBy === 'mos' ? 'MOS applies Ubuntu security updates'
      : patches.managedBy === 'owner' ? 'owner-managed; MOS changed nothing'
        : patches.managedBy === 'none' ? 'not applied automatically' : 'unknown'}`,
  ];
  if (patches.managedReason) lines.push(indent(patches.managedReason, 19));
  lines.push(
    `Allowed origins    ${(patches.allowedOrigins || []).join(', ') || 'none'}`,
    `Automatic reboot   ${patches.automaticReboot === null || patches.automaticReboot === undefined ? 'unknown' : patches.automaticReboot}`,
    `Package lists      ${patches.lastListedAt || 'never refreshed by the timer'}`,
    `Last unattended    ${patches.lastRunAt || 'no run recorded'}`,
    `Last installed     ${patches.lastInstallAt ? `${patches.lastInstallAt}: ${(patches.lastInstalledPackages || []).join(' ') || 'packages not recorded'}` : 'nothing recorded'}`,
    `Security waiting   ${(patches.security || []).length}${(patches.security || []).length ? `: ${patches.security.join(' ')}` : ''}`,
    `Other upgradable   ${(patches.other || []).length}`,
    `Restart needed     ${patches.rebootRequired ? `yes: ${(patches.rebootPackages || []).join(' ') || 'package not recorded'}` : 'no'}`,
  );
  if ((patches.heldPackages || []).length) lines.push(`Held back          ${patches.heldPackages.join(' ')}`);
  if (patches.health) {
    lines.push(`Post-patch check   ${patches.health.ok === true ? 'the suite came back' : patches.health.ok === false ? 'the suite did not come back' : 'could not run'} at ${patches.health.at || 'an unknown time'}`);
    for (const failure of patches.health.failures || []) lines.push(indent(`${failure.name} is ${failure.active}${failure.sub && failure.sub !== failure.active ? ` (${failure.sub})` : ''}`, 19));
    if (patches.health.reason) lines.push(indent(patches.health.reason, 19));
  }
  return lines;
}

function lastHttpsApplyLines(apply) {
  if (!apply?.status) return ['Last HTTPS apply   never'];
  const lines = [`Last HTTPS apply   ${apply.status}${apply.errorCode ? ` (${apply.errorCode})` : ''} at ${apply.at || 'an unknown time'}`];
  if (apply.status === 'failed' && apply.diagnostics) lines.push(indent(apply.diagnostics));
  return lines;
}

function appLines(apps) {
  if (!apps.length) return 'No apps are installed.';
  return apps.map((app) => {
    const lines = [
      `${app.displayName} (${app.packageId})`,
      `  version ${app.packageVersion}  ·  status ${app.status}  ·  installed ${app.installedAt || 'unknown'}`,
    ];
    if (app.lastFailure) {
      lines.push(`  LAST FAILURE  ${app.lastFailure.errorCode}  ·  ${app.lastFailure.kind}  ·  ${app.lastFailure.completedAt || app.lastFailure.startedAt}`);
      if (app.lastFailure.diagnostics) lines.push(indent(app.lastFailure.diagnostics, 4));
    }
    return lines.join('\n');
  }).join('\n\n');
}

function unitLines(units) {
  return (units || []).map((unit) => [
    `${unit.name}  ·  ${unit.active}${unit.sub && unit.sub !== unit.active ? `/${unit.sub}` : ''}  ·  ${unit.enabled}`,
    unit.log ? indent(unit.log) : '  (no log lines)',
  ].join('\n')).join('\n\n');
}

// The web server's configuration, whole and in the order it is imported. This
// is where "my app returns 502" and "that address answers nothing" are told
// apart: one has a route pointing somewhere wrong, the other has no route. The
// DNS credential appears in it as `{env.CLOUDFLARE_API_TOKEN}` — a reference,
// never the value — so nothing here is a secret before redaction even runs.
function webServerLines(files) {
  if (!files?.length) return 'The web server configuration could not be read.';
  return files.map((file) => [
    `${file.path}`,
    file.content === null
      ? `  (${file.unreadable ? `could not be read: ${file.unreadable}` : 'not present — this machine has no routes of that kind'})`
      : indent(file.content),
  ].join('\n')).join('\n\n');
}

// The network map. Two packages on one network is a connection the owner made,
// and a MOS app container on the default `bridge` network is an app that has not
// been restarted onto its own network yet — neither is visible anywhere else in
// this bundle, and both decide whether "app A cannot reach app B" is a
// misconfiguration or exactly what the machine is set up to do.
function networkLines(networks) {
  if (!networks?.length) return 'The Docker networks could not be listed.';
  return networks.map((network) => [
    `${network.name}  ·  ${network.driver}`,
    network.containers?.length ? network.containers.map((name) => `  ${name}`).join('\n') : '  (nothing attached)',
  ].join('\n')).join('\n\n');
}

// The drives apps keep folders on, as the app agent sees them, then the two logs
// that explain a drive that would not open: the attach unit's runs and the kernel's.
function storageLines(drives, storage) {
  const listed = drives === null
    ? ['The app agent could not list the drives.']
    : drives.filter((drive) => drive.state !== 'available').map((drive) => [
      `${drive.label}  ·  ${drive.state}  ·  ${drive.fileSystem || 'unknown filesystem'}  ·  ${drive.id}`,
      `  used by ${drive.apps?.length ? drive.apps.join(', ') : 'no installed app'}`,
      drive.reason ? indent(drive.reason) : null,
      drive.detail ? indent(drive.detail) : null,
    ].filter(Boolean).join('\n'));
  return [
    ...(listed.length ? listed : ['No app keeps files on a drive.']),
    '',
    'Drive events (plug-ins, Eject, Check drive):',
    storage?.attach ? indent(storage.attach) : '  (not collected)',
    '',
    'Kernel lines about drives:',
    storage?.kernel ? indent(storage.kernel) : '  (none)',
  ].join('\n');
}

function containerLines(containers) {
  if (!containers?.length) return 'No MOS containers are present.';
  return containers.map((container) => [
    `${container.name}  ·  ${container.status || container.state}`,
    `  image ${container.image}`,
    container.labels?.['mos.package'] ? `  package ${container.labels['mos.package']} ${container.labels['mos.package-version'] || ''}`.trimEnd() : null,
    container.log ? indent(container.log) : '  (no log lines)',
  ].filter(Boolean).join('\n')).join('\n\n');
}

// One text file rather than an archive, on purpose. The fragile step in the
// support flow is an owner who cannot describe their problem attaching this to a
// message; a single .txt survives every channel that mangles or blocks archives,
// and the person reading it — increasingly an AI agent — needs no unpacking step.
// The tunnel and missing app tokens already reach the summary as attention issues.
function aiTrouble(ai) {
  if (!ai) return [];
  const trouble = [];
  for (const service of ai.services?.services || []) {
    const askers = (ai.services.apps || []).filter((app) => app.serviceId === service.id).map((app) => app.name);
    if (service.test.error && askers.length) trouble.push(`AI service ${service.name}, which ${askers.join(', ')} ${askers.length === 1 ? 'asks' : 'ask'}, did not answer its last test at ${service.test.at}: ${service.test.error}`);
  }
  const allowed = (source) => (ai.connections?.clients || []).some((client) => client.enabled && (client.levels[source.id] || client.defaultLevel) !== 'off');
  for (const source of ai.connections?.sources || []) {
    if (source.error && source.running && allowed(source)) trouble.push(`Assistants may use ${source.name}, but ${source.error}`);
  }
  if (ai.unread?.length) trouble.push(`Some AI information could not be read: ${ai.unread.join(', ')}.`);
  return trouble;
}

function aiServiceLines(services) {
  if (!services) return ['  not read'];
  if (!services.services.length) return ['  none added'];
  return services.services.flatMap((service) => {
    const askers = services.apps.filter((app) => app.serviceId === service.id).map((app) => `${app.name}${app.running ? '' : ' (stopped)'}`);
    const test = !service.test.at ? 'never tested' : `${service.test.at} ${service.test.error ? `did not answer: ${service.test.error}` : 'answered'}`;
    return [
      `  ${service.name}  ${service.baseUrl}  (${service.place})`,
      `    model ${service.model} · search model ${service.embeddingModel || 'none'} · API key ${service.keyConfigured ? 'saved' : 'none'}`,
      `    last test ${test}`,
      `    asked by ${askers.join(', ') || 'no app'}`,
    ];
  });
}

function aiLines(ai) {
  if (!ai) return 'not collected';
  const { connections, services, tunnel } = ai;
  const off = (services?.apps || []).filter((app) => !app.serviceId).map((app) => app.name);
  const clients = connections?.clients || [];
  const levelsOf = (client) => Object.entries(client.levels).map(([id, level]) => `${id} ${level}`).join(', ') || 'none';
  return [
    'AI services apps ask:',
    ...aiServiceLines(services),
    `Apps with AI features left off: ${off.join(', ') || 'none'}`,
    '',
    `Assistants (MCP address ${connections?.mcpUrl || 'none, the suite has no HTTPS address'}):`,
    ...(!connections ? ['  not read'] : clients.length ? clients.map((client) => `  ${client.name}  ${client.route} · ${client.enabled ? 'on' : 'off'} · last used ${client.lastUsedAt || 'never'} · default ${client.defaultLevel} · levels ${levelsOf(client)}${tunnel?.clientId === client.id ? ` · tunnel ${tunnel.state}` : ''}`) : ['  none connected']),
    '',
    'Apps assistants can use:',
    ...(connections?.sources || []).map((source) => `  ${source.name}  ${source.running ? 'running' : 'stopped'} · ${source.tools.length} tools${source.token ? ` · token ${source.token.configured ? 'given' : 'missing'}` : ''}${source.error ? ` · ${source.error}` : ''}`),
  ].join('\n');
}

function troubleText({ trouble }) {
  return trouble.length
    ? trouble.map((line) => `  • ${line}`).join('\n')
    : '  Nothing obviously wrong was detected. The detail below is the evidence\n  for that, and the problem may still be in it.';
}

function platformText({ catalog, collection, homeHost, platform }) {
  return [
    `MOS version        ${platform.version || 'unknown'}`,
    `Update track       ${platform.updateTrack || 'unknown'}`,
    `Install shape      ${platform.frontDoor || 'unknown'}`,
    `HTTPS mode         ${platform.tlsMode || 'unknown'}`,
    `App agent          ${appAgentLine(platform.appAgentContractVersion)}`,
    `Home host          ${homeHost || 'unknown'}`,
    ...(collection ? [`Collected at       ${collection.collectedAt || 'not collected'}`] : []),
    ...lastCheckLines(platform.lastCheck),
    ...lastUpdateLines(platform.lastUpdate),
    ...lastHttpsApplyLines(platform.lastHttpsApply),
    ...catalogLines(catalog),
  ].join('\n');
}

function hostText({ collection }) {
  const host = collection?.host;
  return [
    host?.kernel && `Kernel:\n${host.kernel}`,
    host?.node && `Node.js:\n${host.node}`,
    host?.uptime && `Uptime:\n${host.uptime}`,
    host?.memory && `Memory:\n${host.memory}`,
    host?.disk && `Disk:\n${host.disk}`,
    host?.dockerDisk && `Docker disk:\n${host.dockerDisk}`,
  ].filter(Boolean).join('\n');
}

// Every part of the diagnostics, in the order the file prints them. The file and
// the AI tool mos_diagnostics both read this list, so a new part of MOS becomes
// one entry here: its section in the file, a topic for an AI, and the agent
// collectors (by name, from the agent's own fixed list) it needs.
const TOPICS = {
  summary: {
    agent: 'all',
    render: troubleText,
    says: 'What looks wrong right now, one line per finding. The place to start.',
    title: 'WHAT LOOKS WRONG',
  },
  platform: {
    agent: [],
    render: platformText,
    says: 'MOS version, update track, install shape and HTTPS, with the last update, update check and app catalog refresh.',
    title: 'PLATFORM',
  },
  host: {
    agent: ['host'],
    render: hostText,
    says: 'Kernel, Node.js, uptime, memory, disk and Docker disk use.',
    title: 'HOST',
  },
  'host-patches': {
    agent: ['host-patches'],
    render: ({ collection }) => hostPatchLines(collection?.hostPatches).join('\n'),
    says: 'Ubuntu security updates: who applies them, what is waiting, and whether a restart is needed.',
    title: 'HOST PATCHES',
  },
  'web-server': {
    agent: ['web-server'],
    render: ({ collection }) => webServerLines(collection?.webServer),
    says: 'The web server configuration: every address the suite answers on and where it points.',
    title: 'WEB SERVER',
  },
  apps: {
    agent: [],
    render: ({ apps }) => appLines(apps),
    says: 'Installed apps with version, status and their last failed install, update or removal. With app, only that app.',
    title: 'APPS',
  },
  storage: {
    agent: ['storage'],
    render: ({ collection, drives }) => storageLines(drives, collection?.storage),
    says: 'Drives apps keep files on that are not simply available, with recent drive and kernel messages about them.',
    title: 'STORAGE DRIVES',
  },
  services: {
    agent: ['units'],
    render: ({ collection }) => unitLines(collection?.units),
    says: "My Own Suite's own system services, their state and recent logs.",
    title: 'SERVICES',
  },
  networks: {
    agent: ['networks'],
    render: ({ collection }) => networkLines(collection?.networks),
    says: 'Docker networks and which containers are on each one.',
    title: 'NETWORKS',
  },
  containers: {
    agent: ['containers'],
    render: ({ collection }) => containerLines(collection?.containers),
    says: 'My Own Suite containers with their state and recent logs. With app, only that app\'s containers.',
    title: 'CONTAINERS',
  },
  ai: {
    agent: [],
    render: ({ ai }) => aiLines(ai),
    says: 'AI services apps ask, with their last test and which apps ask them; connected assistants with their levels and ChatGPT tunnel; and the apps assistants can use, with any error reading their tools.',
    title: 'AI',
  },
};

function buildSupportBundle({
  ai = null,
  apps = [],
  attention = [],
  catalog = null,
  collection = {},
  drives = null,
  homeHost = '',
  now = () => new Date(),
  platform = {},
  secrets = [],
} = {}) {
  const createdAt = now().toISOString();
  const trouble = summarizeTrouble({ ai, apps, attention, catalog, collection, drives, platform });
  const facts = { ai, apps, catalog, collection, drives, homeHost, platform, trouble };

  const body = [
`MY OWN SUITE — DIAGNOSTICS
Created ${createdAt}
MOS version ${platform.version || 'unknown'}  ·  server ${homeHost || 'unknown'}

This file describes one My Own Suite server: what it is running, what has failed
recently, and why. Start with WHAT LOOKS WRONG below — everything after it is
the evidence behind it.

Passwords, tokens and app secrets have been replaced with [redacted]. Server and
app names, and local network addresses, are kept: they are not secret, and an
address that stopped working cannot be diagnosed without them.

Logs are shortened newest-first, so this stays small enough to read in full.

`,
    ...Object.values(TOPICS).map((topic) => section(topic.title, topic.render(facts))),
  ].join('');

  // Redaction runs once, over the finished text. Safe here in a way it is not in
  // the logger — this file is plain text, so no value has been escaped or
  // re-encoded on its way in, and an exact-value match still matches.
  const { candidateCount, maskedCount, text } = redactValuesWithReport(body, secrets);
  const footer = section('COLLECTION NOTES', [
    `Known secrets checked for   ${candidateCount}`,
    `Values masked in this file  ${maskedCount}`,
    collection.incomplete?.length ? `Could not collect           ${collection.incomplete.join(', ')}` : 'Could not collect           nothing — every source answered',
    collection.budgetApplied
      ? 'Logs were shortened         yes — the most recent lines were kept, and the sections that look wrong kept the most'
      : 'Logs were shortened         no — every section is here in full',
    '',
    candidateCount === 0
      ? 'WARNING: no secrets were known to this export, so nothing could be masked.\nTreat this file as unredacted and review it before sending it.'
      : 'Masking replaces known secret values wherever they appear. It cannot mask a\nsecret MOS does not hold, such as one typed into an app directly.',
  ].join('\n'));

  return {
    filename: `mos-diagnostics-${createdAt.slice(0, 19).replace(/[:T]/gu, '-')}.txt`,
    text: `${text}${footer}`,
  };
}

// Gathers both halves — what the privileged agent can see and what only Suite
// Manager knows. `collectors` are agent collector names (null reads them all, an
// empty list none); `app` narrows the apps and their containers to one package.
async function gatherFacts({
  agent,
  aiFacts = null,
  app = null,
  attention = [],
  appAgent = null,
  catalogStatus = null,
  collectors = null,
  frontDoor = 'unknown',
  homeHost = '',
  platformVersion = 'unknown',
  store,
  suiteAddress = null,
  updateStatus = null,
}) {
  // An unreachable diagnostics agent is not a failed export. It is the most
  // useful thing the file could say, so it becomes a finding rather than a 500:
  // an owner whose agent is down is exactly the owner asking for help.
  const collection = collectors?.length === 0 ? null : await Promise.resolve()
    .then(() => agent.collect({ app, only: collectors }))
    .catch((error) => ({ containers: [], host: {}, hostPatches: null, incomplete: [`diagnostics agent unreachable (${error.code || 'unknown'})`], units: [] }));

  const addressChange = (() => {
    try { return store.getAddressChange() || {}; } catch { return {}; }
  })();
  const appAgentStatus = await Promise.resolve(appAgent?.status?.()).catch(() => null);
  const drives = await Promise.resolve(appAgent?.storageInventory?.()).then((answer) => answer?.drives || null, () => null);
  const apps = store.getAppInstances().filter((instance) => app === null || instance.packageId === app).map((instance) => ({
    displayName: instance.displayNameSnapshot || instance.packageId,
    installedAt: instance.installedAt,
    lastFailure: (() => {
      try { return store.latestFailedAppOperation(instance.id); } catch { return null; }
    })(),
    packageId: instance.packageId,
    packageVersion: instance.packageVersion,
    status: instance.status,
  }));

  return {
    ai: await Promise.resolve().then(() => aiFacts?.()).catch(() => ({ unread: ['AI settings'] })) ?? null,
    apps,
    attention,
    catalog: catalogStatus,
    collection,
    drives,
    homeHost,
    platform: {
      appAgentContractVersion: appAgentContractVersionOf(appAgentStatus),
      frontDoor,
      lastHttpsApply: {
        at: addressChange.finishedAt || addressChange.startedAt || null,
        diagnostics: addressChange.diagnostics || null,
        errorCode: addressChange.errorCode || null,
        status: addressChange.status && addressChange.status !== 'never' ? addressChange.status : null,
      },
      lastCheck: updateStatus?.serviceAvailable ? {
        at: updateStatus.checkedAt || null,
        diagnostics: updateStatus.checkFailure?.diagnostics || null,
        reason: updateStatus.checkFailure?.reason || null,
      } : null,
      lastUpdate: updateStatus?.currentJob ? {
        at: updateStatus.currentJob.completedAt || updateStatus.currentJob.updatedAt || null,
        error: updateStatus.currentJob.error || null,
        output: updateStatus.currentJob.output || null,
        stage: updateStatus.currentJob.stage || null,
        status: updateStatus.currentJob.status || null,
      } : null,
      tlsMode: suiteAddress?.scheme === 'https' ? `https (${suiteAddress.kind})` : suiteAddress?.kind || 'unknown',
      updateTrack: updateStatus?.track?.label || 'unknown',
      version: platformVersion,
    },
  };
}

async function assembleSupportBundle({ now = () => new Date(), secretDir, ...context }) {
  return buildSupportBundle({ ...(await gatherFacts(context)), now, secrets: collectRedactionSecrets({ secretDir }) });
}

// One topic for an AI: the same section the file prints, gathered from only the
// collectors it needs, and masked with the same secrets.
async function readTopic(topicId, { aiFacts = null, app = null, secretDir, ...context }) {
  const topic = TOPICS[topicId];
  if (!topic) throw Object.assign(new Error(`No diagnostics topic is called "${String(topicId).slice(0, 40)}". Topics: ${Object.keys(TOPICS).join(', ')}.`), { code: 'DIAGNOSTICS_UNKNOWN_TOPIC' });
  // Reading assistants' tools asks each app, so only the topics that print AI wait for it.
  const needsAi = topicId === 'ai' || topicId === 'summary';
  const facts = await gatherFacts({ ...context, aiFacts: needsAi ? aiFacts : null, app, collectors: topic.agent === 'all' ? null : topic.agent });
  const text = section(topic.title, topic.render({ ...facts, trouble: summarizeTrouble({ ...facts, collection: facts.collection ?? {} }) }));
  return redactValuesWithReport(text, collectRedactionSecrets({ secretDir })).text;
}

// The one way in for both readers of diagnostics: the download button and the AI
// tool. Everything is read when asked, so neither ever sees a stale answer.
// Each AI part answers on its own, so one that fails leaves the others readable.
async function readAiFacts({ aiConnections, aiServices, chatGptTunnel }) {
  const unread = [];
  const read = (name, value) => Promise.resolve().then(value).catch(() => { unread.push(name); return null; });
  const [services, connections, tunnel] = await Promise.all([
    read('AI services', () => aiServices?.status()),
    read('assistants', () => aiConnections?.status()),
    read('ChatGPT tunnel', () => chatGptTunnel?.status()),
  ]);
  return { connections, services, tunnel, unread };
}

function createDiagnostics({ aiConnections, aiServices, appAgent, appPackages, attention, catalogService, chatGptTunnel, diagnosticsAgent, frontDoor, homeHost, setup, suiteAddress, updates }) {
  const context = async () => ({
    agent: diagnosticsAgent,
    aiFacts: () => readAiFacts({ aiConnections, aiServices, chatGptTunnel }),
    appAgent,
    attention: await Promise.resolve().then(() => attention?.issues() ?? []).catch(() => []),
    catalogStatus: catalogService.status(),
    frontDoor,
    homeHost: suiteAddress.readOrNull()?.host || homeHost,
    platformVersion: catalogService.platformVersion,
    secretDir: appPackages.secretDir,
    store: setup.store,
    suiteAddress: suiteAddress.readOrNull(),
    updateStatus: await updates.status().catch(() => null),
  });
  return {
    file: async () => assembleSupportBundle(await context()),
    read: async (topic, { app = null } = {}) => readTopic(topic, { ...(await context()), app }),
  };
}

module.exports = {
  TOPICS,
  assembleSupportBundle,
  buildSupportBundle,
  createDiagnostics,
  readTopic,
  collectRedactionSecrets,
  fullFilesystems,
  section,
  summarizeTrouble,
};
