'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { REBOOT_REQUIRED_PATH, healthStatePath, readEnablementState } = require('../../infrastructure/host-patching.cjs');
const { parseAptConfigDump, parseRebootPackages, parseUnattendedLog, parseUpgradableSimulation } = require('./host-patches.cjs');

const DOCKER_BINARY = process.env.MOS_DOCKER_BINARY || '/usr/bin/docker';
const JOURNALCTL_BINARY = process.env.MOS_JOURNALCTL_BINARY || '/usr/bin/journalctl';
const SYSTEMCTL_BINARY = process.env.MOS_SYSTEMCTL_BINARY || '/usr/bin/systemctl';
const APT_GET_BINARY = process.env.MOS_APT_GET_BINARY || '/usr/bin/apt-get';
const APT_CONFIG_BINARY = process.env.MOS_APT_CONFIG_BINARY || '/usr/bin/apt-config';
const REBOOT_REQUIRED_PKGS_PATH = `${REBOOT_REQUIRED_PATH}.pkgs`;
const UNATTENDED_LOG_PATH = '/var/log/unattended-upgrades/unattended-upgrades.log';
// Touched by apt's own daily script after a successful list refresh. The
// similarly named update-success-stamp beside it belongs to update-notifier,
// which not every install carries.
const APT_UPDATE_STAMP_PATH = '/var/lib/apt/periodic/update-stamp';
const COMMAND_TIMEOUT_MS = 20_000;
// Docker caps a container's logs at 30 MB and journald at its own retention, so
// a single `docker logs --tail 400` can legitimately return tens of megabytes if
// the lines are large. Collecting several of those into memory at once, on a
// machine that is already short of it, is how a diagnostic makes things worse.
// A rolling tail rather than a head cut: the newest output is the point.
const MAX_CAPTURE_BYTES = 512 * 1024;

// A read that ran out of time. It carries whatever arrived, because for a log
// tail a partial answer is still an answer; for a state read it is not.
class CaptureTimeoutError extends Error {
  constructor(output) {
    super(`collection timed out after ${COMMAND_TIMEOUT_MS / 1000}s`);
    this.name = 'CaptureTimeoutError';
    this.output = output;
  }
}

// Merges stderr into stdout and resolves whatever the command produced, even on
// a non-zero exit. Every other MOS agent rejects on a failed command because it
// is about to change the system and must not proceed; this one is only reading,
// and a command that fails has usually just explained the problem the bundle
// exists to capture. `journalctl` on a unit that was never installed and
// `docker logs` on a container that never started are both answers.
//
// Arguments are never captured anywhere: every command here is a fixed literal
// with a unit or container name appended, but the rule holds regardless, because
// app containers are started with materialized secrets on their argv.
function capture(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let output = '';
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new CaptureTimeoutError(output));
    }, COMMAND_TIMEOUT_MS);
    const append = (chunk) => {
      output += chunk;
      if (output.length > MAX_CAPTURE_BYTES) output = output.slice(-MAX_CAPTURE_BYTES);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => finish(reject, error));
    child.on('close', () => finish(resolve, output)); // never `exit`: it beats the pipe read carrying the output
  });
}

// journalctl reads are run one at a time, never concurrently. Several
// `journalctl -u` invocations in flight at once make journald hand some of them
// an empty result — exit 0, nothing on stderr, just no lines — for a different
// unit on each run, which silently drops that unit's logs from the bundle.
// Reproduced on systemd 255: six concurrent reads lose two units per pass; one
// at a time never does. This serialises only journalctl; systemctl and docker
// reads stay concurrent, so the collection is still bounded by a single slow
// journal rather than by all of them in series.
let journalQueue = Promise.resolve();
function serializeJournal(task) {
  const run = journalQueue.then(task, task);
  journalQueue = run.then(() => undefined, () => undefined);
  return run;
}

function parseShowOutput(text) {
  const values = {};
  for (const line of String(text || '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return values;
}

// `docker ps` prints one JSON object per line. With the daemon down it prints
// an error instead, and capture() hands that back as text like any other
// answer — so an output with lines but no container in it is a failed read,
// and rejecting is what lands it in the bundle's collection notes rather than
// as "no MOS containers are present" stated as fact. An empty output is the
// honest answer from a machine with no containers.
function parseContainerList(raw) {
  const containers = [];
  let unreadable = 0;
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    if (!line.trim().startsWith('{')) { unreadable += 1; continue; }
    try {
      const entry = JSON.parse(line);
      containers.push({
        image: entry.Image || '',
        labels: parseLabels(entry.Labels),
        name: (entry.Names || '').split(',')[0],
        state: entry.State || '',
        status: entry.Status || '',
      });
    } catch { unreadable += 1; }
  }
  if (containers.length === 0 && unreadable > 0) {
    throw new Error(`docker did not list containers: ${raw.trim().split('\n')[0].slice(0, 200)}`);
  }
  return containers;
}

// The end of a file, for the sections of the patch state that exist to be read
// by a person rather than counted. agent-core.cjs bounds logs the same way and
// for the same reason: what matters in a long file is the last thing in it.
function boundedTail(text, maxChars) {
  const value = String(text || '');
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

// A log that timed out keeps what it got, marked; every other failure stays one.
function keepPartialLog(error) {
  if (!(error instanceof CaptureTimeoutError)) throw error;
  return `${error.output}\n[... ${error.message} ...]`;
}

// Labels arrive as a single comma-separated `key=value` string rather than a map.
function parseLabels(raw) {
  const labels = {};
  for (const pair of String(raw || '').split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) labels[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return labels;
}

class SystemDiagnosticsAdapter {
  async availableCollectors() {
    const present = async (file) => {
      try {
        await capture(file, ['--version']);
        return true;
      } catch {
        return false;
      }
    };
    return { docker: await present(DOCKER_BINARY), journal: await present(JOURNALCTL_BINARY) };
  }

  // Each fact independently, so a binary that is missing or moved costs that one
  // line rather than the whole section. Disk pressure is the most valuable thing
  // in here and it must not be lost because `docker system df` was unavailable.
  async hostFacts() {
    const facts = {};
    await Promise.all(Object.entries({
      disk: ['/usr/bin/df', ['-h', '/', '/var/lib/docker']],
      dockerDisk: [DOCKER_BINARY, ['system', 'df']],
      kernel: ['/usr/bin/uname', ['-a']],
      memory: ['/usr/bin/free', ['-m']],
      uptime: ['/usr/bin/uptime', []],
    }).map(async ([name, [file, args]]) => {
      try { facts[name] = await capture(file, args); } catch { /* one fact, not the section */ }
    }));
    return facts;
  }

  // Host patch state, as a fixed source like every other one here. The
  // simulation is read-only and touches no network: `--just-print` decides
  // against the package lists already on disk, and NoLocking keeps it from
  // contending with an unattended run that may be happening right now.
  async hostPatches() {
    const at = new Date().toISOString();
    const text = async (file, args) => {
      try { return await capture(file, args); } catch { return ''; }
    };
    const file = (filePath) => {
      try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
    };
    const json = (filePath) => {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
    };
    const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
    const [simulation, configDump] = await Promise.all([
      text(APT_GET_BINARY, ['--just-print', '--quiet', '-o', 'Debug::NoLocking=1', 'dist-upgrade']),
      text(APT_CONFIG_BINARY, ['dump']),
    ]);
    const upgradable = parseUpgradableSimulation(simulation);
    const config = parseAptConfigDump(configDump);
    const unattendedLog = file(UNATTENDED_LOG_PATH);
    const enablement = readEnablementState(stateRoot);
    let lastListedAt = null;
    try { lastListedAt = fs.statSync(APT_UPDATE_STAMP_PATH).mtime.toISOString(); } catch {}

    return {
      ...parseUnattendedLog(unattendedLog),
      ...config,
      at,
      // The simulation is the evidence behind the count, and the count is the
      // only thing the primary UI says. Bounded because it is a package list on
      // a machine that may be a very long way behind.
      available: Boolean(configDump),
      health: json(healthStatePath(stateRoot)),
      lastListedAt,
      managedBy: enablement?.managedBy || 'unknown',
      managedReason: enablement?.reason || null,
      other: upgradable.other,
      rebootPackages: parseRebootPackages(file(REBOOT_REQUIRED_PKGS_PATH)),
      rebootRequired: fs.existsSync(REBOOT_REQUIRED_PATH),
      security: upgradable.security,
      simulation: boundedTail(simulation, 8_000),
      unattendedLog: boundedTail(unattendedLog, 8_000),
    };
  }

  async unitState(unit) {
    const values = parseShowOutput(await capture(SYSTEMCTL_BINARY, ['show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState']));
    return {
      active: values.ActiveState || 'unknown',
      enabled: values.UnitFileState || 'unknown',
      sub: values.SubState || 'unknown',
    };
  }

  // `--no-hostname` and message-only-plus-timestamp keep the per-line overhead
  // low enough that the line budget buys log rather than prefix.
  journal(unit, lines) {
    return serializeJournal(() => capture(JOURNALCTL_BINARY, ['-u', unit, '-n', String(lines), '--no-pager', '--no-hostname', '-o', 'short-iso']).catch(keepPartialLog));
  }

  async containers() {
    return parseContainerList(await capture(DOCKER_BINARY, ['ps', '-a', '--no-trunc', '--format', '{{json .}}']));
  }

  containerLog(name, lines) {
    return capture(DOCKER_BINARY, ['logs', '--tail', String(lines), '--timestamps', name]).catch(keepPartialLog);
  }
}

module.exports = { CaptureTimeoutError, MAX_CAPTURE_BYTES, SystemDiagnosticsAdapter, boundedTail, capture, keepPartialLog, parseContainerList, parseLabels, parseShowOutput, serializeJournal };
