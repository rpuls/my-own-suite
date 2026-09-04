'use strict';

const { spawn } = require('node:child_process');

const DOCKER_BINARY = process.env.MOS_DOCKER_BINARY || '/usr/bin/docker';
const JOURNALCTL_BINARY = process.env.MOS_JOURNALCTL_BINARY || '/usr/bin/journalctl';
const SYSTEMCTL_BINARY = process.env.MOS_SYSTEMCTL_BINARY || '/usr/bin/systemctl';
const COMMAND_TIMEOUT_MS = 20_000;
// Docker caps a container's logs at 30 MB and journald at its own retention, so
// a single `docker logs --tail 400` can legitimately return tens of megabytes if
// the lines are large. Collecting several of those into memory at once, on a
// machine that is already short of it, is how a diagnostic makes things worse.
// A rolling tail rather than a head cut: the newest output is the point.
const MAX_CAPTURE_BYTES = 512 * 1024;

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
      finish(resolve, `${output}\n[... collection timed out after ${COMMAND_TIMEOUT_MS / 1000}s ...]`);
    }, COMMAND_TIMEOUT_MS);
    const append = (chunk) => {
      output += chunk;
      if (output.length > MAX_CAPTURE_BYTES) output = output.slice(-MAX_CAPTURE_BYTES);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => finish(reject, error));
    child.on('exit', () => finish(resolve, output));
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

// `docker ps` prints one JSON object per line. Labels arrive as a single
// comma-separated `key=value` string rather than a map.
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
    return serializeJournal(() => capture(JOURNALCTL_BINARY, ['-u', unit, '-n', String(lines), '--no-pager', '--no-hostname', '-o', 'short-iso']));
  }

  async containers() {
    const raw = await capture(DOCKER_BINARY, ['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
    const containers = [];
    for (const line of raw.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const entry = JSON.parse(line);
        containers.push({
          image: entry.Image || '',
          labels: parseLabels(entry.Labels),
          name: (entry.Names || '').split(',')[0],
          state: entry.State || '',
          status: entry.Status || '',
        });
      } catch { /* a line docker did not write as JSON is not a container */ }
    }
    return containers;
  }

  containerLog(name, lines) {
    return capture(DOCKER_BINARY, ['logs', '--tail', String(lines), '--timestamps', name]);
  }
}

module.exports = { MAX_CAPTURE_BYTES, SystemDiagnosticsAdapter, capture, parseLabels, parseShowOutput, serializeJournal };
