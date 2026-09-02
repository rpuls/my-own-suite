'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
function summarizeTrouble({ apps = [], collection = {}, platform = {} }) {
  const trouble = [];
  if (platform.lastUpdate?.status === 'failed') trouble.push(`The last platform update failed at ${platform.lastUpdate.at || 'an unknown time'}: ${platform.lastUpdate.error || 'no reason was recorded.'}`);
  if (platform.lastHttpsApply?.status === 'failed') trouble.push(`The last HTTPS apply failed: ${platform.lastHttpsApply.errorCode || 'unknown error'} at ${platform.lastHttpsApply.at || 'an unknown time'}.`);
  for (const unit of collection.units || []) {
    if (unit.active !== 'active') trouble.push(`Service ${unit.name} is ${unit.active}${unit.sub && unit.sub !== unit.active ? ` (${unit.sub})` : ''}.`);
  }
  for (const container of collection.containers || []) {
    if (container.troubled) trouble.push(`Container ${container.name} is ${container.status || container.state || 'in an unexpected state'}.`);
  }
  for (const app of apps) {
    if (app.lastFailure) trouble.push(`App ${app.displayName} last failed: ${app.lastFailure.errorCode} at ${app.lastFailure.completedAt || app.lastFailure.startedAt}.`);
  }
  for (const line of fullFilesystems(collection.host?.disk)) trouble.push(`Filesystem is nearly full: ${line}`);
  if (collection.incomplete?.length) trouble.push(`Some information could not be collected: ${collection.incomplete.join(', ')}.`);
  return trouble;
}

function section(title, body) {
  const content = String(body ?? '').trimEnd();
  return `${RULE}\n${title}\n${RULE}\n${content || '(nothing recorded)'}\n\n`;
}

function indent(text, depth = 2) {
  return String(text).split('\n').map((line) => `${' '.repeat(depth)}${line}`).join('\n');
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
function buildSupportBundle({
  apps = [],
  collection = {},
  homeHost = '',
  now = () => new Date(),
  platform = {},
  secrets = [],
} = {}) {
  const createdAt = now().toISOString();
  const trouble = summarizeTrouble({ apps, collection, platform });

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
    section('WHAT LOOKS WRONG', trouble.length
      ? trouble.map((line) => `  • ${line}`).join('\n')
      : '  Nothing obviously wrong was detected. The detail below is the evidence\n  for that, and the problem may still be in it.'),
    section('PLATFORM', [
      `MOS version        ${platform.version || 'unknown'}`,
      `Update track       ${platform.updateTrack || 'unknown'}`,
      `Install shape      ${platform.frontDoor || 'unknown'}`,
      `HTTPS mode         ${platform.tlsMode || 'unknown'}`,
      `Home host          ${homeHost || 'unknown'}`,
      `Collected at       ${collection.collectedAt || 'not collected'}`,
      ...lastUpdateLines(platform.lastUpdate),
      ...lastHttpsApplyLines(platform.lastHttpsApply),
    ].join('\n')),
    section('HOST', [
      collection.host?.kernel && `Kernel:\n${collection.host.kernel}`,
      collection.host?.uptime && `Uptime:\n${collection.host.uptime}`,
      collection.host?.memory && `Memory:\n${collection.host.memory}`,
      collection.host?.disk && `Disk:\n${collection.host.disk}`,
      collection.host?.dockerDisk && `Docker disk:\n${collection.host.dockerDisk}`,
    ].filter(Boolean).join('\n')),
    section('APPS', appLines(apps)),
    section('SERVICES', unitLines(collection.units)),
    section('CONTAINERS', containerLines(collection.containers)),
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
// Manager knows — and renders the file. Split from buildSupportBundle so the
// rendering is testable against fixtures with no store, agent or disk.
async function assembleSupportBundle({
  agent,
  frontDoor = 'unknown',
  homeHost = '',
  now = () => new Date(),
  platformVersion = 'unknown',
  secretDir,
  store,
  updateStatus = null,
}) {
  // An unreachable diagnostics agent is not a failed export. It is the most
  // useful thing the file could say, so it becomes a finding rather than a 500:
  // an owner whose agent is down is exactly the owner asking for help.
  const collection = await Promise.resolve()
    .then(() => agent.collect())
    .catch((error) => ({ containers: [], host: {}, incomplete: [`diagnostics agent unreachable (${error.code || 'unknown'})`], units: [] }));

  const https = (() => {
    try { return store.getHttpsSettings() || {}; } catch { return {}; }
  })();
  const apps = store.getAppInstances().map((instance) => ({
    displayName: instance.displayNameSnapshot || instance.packageId,
    installedAt: instance.installedAt,
    lastFailure: (() => {
      try { return store.latestFailedAppOperation(instance.id); } catch { return null; }
    })(),
    packageId: instance.packageId,
    packageVersion: instance.packageVersion,
    status: instance.status,
  }));

  return buildSupportBundle({
    apps,
    collection,
    homeHost,
    now,
    platform: {
      frontDoor,
      lastHttpsApply: {
        at: https.lastApplyAt || null,
        diagnostics: https.lastApplyDiagnostics || null,
        errorCode: https.lastApplyErrorCode || null,
        status: https.lastApplyStatus || null,
      },
      lastUpdate: updateStatus?.currentJob ? {
        at: updateStatus.currentJob.completedAt || updateStatus.currentJob.updatedAt || null,
        error: updateStatus.currentJob.error || null,
        output: updateStatus.currentJob.output || null,
        stage: updateStatus.currentJob.stage || null,
        status: updateStatus.currentJob.status || null,
      } : null,
      tlsMode: https.tlsMode || 'unknown',
      updateTrack: updateStatus?.track?.label || 'unknown',
      version: platformVersion,
    },
    secrets: collectRedactionSecrets({ secretDir }),
  });
}

module.exports = {
  assembleSupportBundle,
  buildSupportBundle,
  collectRedactionSecrets,
  fullFilesystems,
  summarizeTrouble,
};
