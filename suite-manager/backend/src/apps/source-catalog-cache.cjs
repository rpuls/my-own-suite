const fs = require('node:fs');
const path = require('node:path');

// What each added external source publishes, as MOS last saw it.
//
// This exists because an owner browsing the Apps page must not pay for it. A
// source's package list can only be learned by downloading the repository archive
// and reading the manifests inside it, so deriving the list per page view would
// mean one archive download per source per visit. Cached, the common path costs
// nothing: the Apps page renders what is already on disk, and the network is only
// touched when a source is actually due a check.
//
// The cache is also what makes a source usable at all with no route to the git
// host — the same reason the official catalog keeps one. A list that disappears
// when the network does is not a list, and an installed external app would lose
// its own catalog metadata along with it.
//
// Two timestamps, never one. `checkedAt` is the last cheap probe that asked the
// host which commit the source is at; `fetchedAt` is the last expensive archive
// download. The interval below gates the probe. The download happens only when a
// probe returns a commit that differs from the cached one, or when the owner asks
// for it directly — so a source that nobody has pushed to costs two API calls a
// day, not an archive.
const CACHE_VERSION = 1;
const DEFAULT_POLICY = Object.freeze({
  // How long a probed revision is trusted before the source is due again.
  checkIntervalMs: 6 * 60 * 60 * 1_000,
  // After a failure, wait this long, doubling per consecutive failure up to the
  // ceiling. The git host's unauthenticated budget is about 60 requests an hour
  // per address and the official catalog refresh already draws on it, so probing
  // a repository that has gone away at the normal cadence is the worst possible
  // use of what is left.
  failureBackoffMs: 30 * 60 * 1_000,
  failureBackoffCeilingMs: 24 * 60 * 60 * 1_000,
  // How many sources one sweep may probe. This is also what staggers them: a
  // sweep takes the most overdue sources first, so an owner with fifteen sources
  // works through them over several sweeps instead of spending half an hour's
  // budget the first time the Apps page loads.
  maxProbesPerSweep: 4,
});

function isoOrNull(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

// One source's cache entry, normalized. Anything unreadable degrades to "never
// checked" rather than throwing: a corrupt entry must cost at most one extra
// probe, never the Apps page.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    checkedAt: isoOrNull(raw.checkedAt),
    error: raw.error && typeof raw.error === 'object' ? {
      at: isoOrNull(raw.error.at),
      code: String(raw.error.code || 'SOURCE_FETCH_FAILED'),
      failures: Number.isInteger(raw.error.failures) && raw.error.failures > 0 ? raw.error.failures : 1,
      message: String(raw.error.message || 'The source could not be checked.'),
      retryAt: isoOrNull(raw.error.retryAt),
    } : null,
    fetchedAt: isoOrNull(raw.fetchedAt),
    packages: Array.isArray(raw.packages) ? raw.packages : [],
    revision: typeof raw.revision === 'string' && /^[a-f0-9]{40}$/u.test(raw.revision) ? raw.revision : null,
  };
}

class SourceCatalogCache {
  constructor({ now = () => new Date(), policy = {}, stateDir }) {
    this.cachePath = path.join(stateDir, 'external-app-sources.json');
    this.now = now;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.sources = this.read();
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (parsed?.version !== CACHE_VERSION || !parsed.sources || typeof parsed.sources !== 'object') return new Map();
      const entries = Object.entries(parsed.sources)
        .map(([id, raw]) => [id, normalizeEntry(raw)])
        .filter(([, entry]) => entry !== null);
      return new Map(entries);
    } catch {
      return new Map();
    }
  }

  write() {
    const payload = { sources: Object.fromEntries(this.sources), version: CACHE_VERSION };
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const temporary = `${this.cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.cachePath);
  }

  get(sourceId) {
    return this.sources.get(sourceId) || null;
  }

  // A successful archive download: the source is at `revision` and publishes
  // `packages`. Clears any recorded failure, which also resets the back-off.
  put(sourceId, { packages, revision }) {
    const at = this.now().toISOString();
    this.sources.set(sourceId, { checkedAt: at, error: null, fetchedAt: at, packages, revision });
    this.write();
    return this.get(sourceId);
  }

  // A probe that found the cached revision still current. The package list is
  // already right, so nothing was downloaded and only the clock moves.
  markUnchanged(sourceId) {
    const existing = this.get(sourceId);
    if (!existing) return null;
    this.sources.set(sourceId, { ...existing, checkedAt: this.now().toISOString(), error: null });
    this.write();
    return this.get(sourceId);
  }

  // A failed probe or download. The previously cached package list is kept and
  // keeps being served: a source MOS cannot reach right now has not stopped
  // publishing what it published yesterday.
  markFailed(sourceId, { code, message, retryAt = null }) {
    const existing = this.get(sourceId);
    const failures = (existing?.error?.failures || 0) + 1;
    const at = this.now().toISOString();
    this.sources.set(sourceId, {
      checkedAt: at,
      error: { at, code: String(code || 'SOURCE_FETCH_FAILED'), failures, message: String(message || 'The source could not be checked.'), retryAt: isoOrNull(retryAt) },
      fetchedAt: existing?.fetchedAt || null,
      packages: existing?.packages || [],
      revision: existing?.revision || null,
    });
    this.write();
    return this.get(sourceId);
  }

  forget(sourceId) {
    if (!this.sources.delete(sourceId)) return;
    this.write();
  }

  // When this source may next be probed. A never-checked source is due now; a
  // failing one waits out its doubling back-off, and a rate-limited host that told
  // MOS when the window resets is taken at its word when that is the longer wait.
  nextCheckAt(sourceId) {
    const entry = this.get(sourceId);
    if (!entry?.checkedAt) return null;
    const since = Date.parse(entry.checkedAt);
    if (!Number.isFinite(since)) return null;
    let waitMs = this.policy.checkIntervalMs;
    if (entry.error) {
      const doubled = this.policy.failureBackoffMs * (2 ** (entry.error.failures - 1));
      waitMs = Math.min(doubled, this.policy.failureBackoffCeilingMs);
    }
    const ready = since + waitMs;
    const retryAt = entry.error?.retryAt ? Date.parse(entry.error.retryAt) : NaN;
    return new Date(Number.isFinite(retryAt) ? Math.max(ready, retryAt) : ready).toISOString();
  }

  due(sourceId) {
    const next = this.nextCheckAt(sourceId);
    return next === null || Date.parse(next) <= this.now().getTime();
  }

  // Which of these sources a sweep should probe, most overdue first and capped.
  // The cap is the stagger: it is why fifteen sources do not all come due on the
  // same page load.
  dueSourceIds(sourceIds = []) {
    return sourceIds
      .filter((id) => this.due(id))
      .sort((left, right) => Date.parse(this.get(left)?.checkedAt || 0) - Date.parse(this.get(right)?.checkedAt || 0))
      .slice(0, this.policy.maxProbesPerSweep);
  }

  // Owner-facing freshness for one source. `packageCount` is reported separately
  // from the packages themselves so a Settings row can say what a source offers
  // without carrying every card.
  status(sourceId) {
    const entry = this.get(sourceId);
    if (!entry) return { checkedAt: null, error: null, fetchedAt: null, nextCheckAt: null, packageCount: null, revision: null };
    return {
      checkedAt: entry.checkedAt,
      error: entry.error,
      fetchedAt: entry.fetchedAt,
      nextCheckAt: this.nextCheckAt(sourceId),
      packageCount: entry.packages.length,
      revision: entry.revision,
    };
  }
}

module.exports = { CACHE_VERSION, DEFAULT_POLICY, SourceCatalogCache };
