'use strict';

// What the diagnostics agent may read, as data.
//
// The caller names nothing. `collect()` takes no arguments at all, which is the
// whole security argument for this agent: a collector list a request could
// extend would be an arbitrary-file-read primitive reachable from an
// unprivileged web app, and that is the one thing a root agent must never be.
// Adding a source means editing this file and shipping it, where it is reviewed.

const MOS_UNITS = [
  'mos-suite-manager.service',
  'mos-app-agent.service',
  'mos-https-agent.service',
  'mos-homepage-agent.service',
  'mos-backup-agent.service',
  'mos-update-agent.service',
  'mos-homepage.service',
  'caddy.service',
  'docker.service',
];

// Suite Manager orchestrates every other unit, so its journal explains failures
// that surface elsewhere. It gets the full budget whether or not it looks sick.
const PRIMARY_UNIT = 'mos-suite-manager.service';

// Only containers MOS created. Everything under this prefix is ours by
// construction: the app agent names app containers `mos-app-<package>` and the
// platform's own containers `mos-<name>`.
const MOS_CONTAINER_PREFIX = 'mos-';

// Sized for a reader with a context window rather than for completeness.
// Something healthy contributes a status line and a short tail; something that
// looks wrong gets the long one. A bundle from a working machine is therefore
// small, and a bundle from a broken one spends its budget on the broken part.
const LIMITS = {
  // Two commands per unit plus one per container is forty-odd processes. Run
  // flat out, that is a spike of child processes on a machine that is already
  // short of memory or disk — a diagnostic must not be the thing that finishes
  // off the box it was called to explain. Six at a time still finishes in a
  // couple of seconds.
  concurrency: 6,
  containers: 24,
  healthyLines: 40,
  sectionChars: 24_000,
  troubledLines: 400,
};

// Bounded-concurrency map, preserving input order in the result.
async function mapWithLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Keeps the end of a log, not the start. Anything worth reading in a failure is
// the last thing that happened, and a bundle that truncated forwards would cut
// off exactly the lines the owner asked for help about.
function boundText(text, maxChars = LIMITS.sectionChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  const kept = value.slice(value.length - maxChars);
  const newlineAt = kept.indexOf('\n');
  const aligned = newlineAt >= 0 && newlineAt < 400 ? kept.slice(newlineAt + 1) : kept;
  return `[... ${value.length - aligned.length} earlier characters dropped ...]\n${aligned}`;
}

// A unit is interesting when it is not simply up. `activating` counts: a unit
// stuck there is one of the failure shapes an owner cannot see for themselves.
function unitLooksTroubled(state) {
  return state.active !== 'active';
}

function containerLooksTroubled(container) {
  if (container.state && container.state !== 'running') return true;
  return /unhealthy|restarting/iu.test(container.status || '');
}

class DiagnosticsAgentCore {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async status() {
    return { collectors: await this.adapter.availableCollectors(), ok: true };
  }

  // Every collector is best-effort and independent. This runs when something is
  // already broken, so a collector that throws is an expected outcome, not an
  // exceptional one — losing the rest of the bundle to it would defeat the
  // feature at exactly the moment it exists for. What failed is reported in
  // `incomplete` so the reader knows the difference between "nothing there" and
  // "could not look".
  async collect() {
    const incomplete = [];
    const attempt = async (name, task, fallback) => {
      try {
        return await task();
      } catch {
        incomplete.push(name);
        return fallback;
      }
    };

    // Concurrent because an owner is watching a button, but bounded because the
    // machine is by definition not well. Serialising forty reads behind a
    // twenty-second timeout each is how a diagnostic becomes a hang; running
    // them all at once is how it becomes the last straw.
    const [host, units, containers] = await Promise.all([
      attempt('host', () => this.adapter.hostFacts(), {}),
      mapWithLimit(MOS_UNITS, LIMITS.concurrency, async (name) => {
        const state = await attempt(`unit:${name}`, () => this.adapter.unitState(name), { active: 'unknown', enabled: 'unknown' });
        const troubled = name === PRIMARY_UNIT || unitLooksTroubled(state);
        const log = await attempt(`journal:${name}`, () => this.adapter.journal(name, troubled ? LIMITS.troubledLines : LIMITS.healthyLines), '');
        return { active: state.active, enabled: state.enabled, log: boundText(log), name, sub: state.sub, troubled };
      }),
      attempt('containers', () => this.adapter.containers(), []).then((discovered) => mapWithLimit(
        discovered
          .filter((entry) => String(entry.name || '').startsWith(MOS_CONTAINER_PREFIX))
          .slice(0, LIMITS.containers),
        LIMITS.concurrency,
        async (container) => {
          const troubled = containerLooksTroubled(container);
          const log = await attempt(`container:${container.name}`, () => this.adapter.containerLog(container.name, troubled ? LIMITS.troubledLines : LIMITS.healthyLines), '');
          return { ...container, log: boundText(log), troubled };
        },
      )),
    ]);

    return { collectedAt: new Date().toISOString(), containers, host, incomplete, units };
  }
}

module.exports = {
  DiagnosticsAgentCore,
  LIMITS,
  MOS_CONTAINER_PREFIX,
  MOS_UNITS,
  PRIMARY_UNIT,
  boundText,
  containerLooksTroubled,
  mapWithLimit,
  unitLooksTroubled,
};
