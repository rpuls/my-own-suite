const fs = require('node:fs');
const path = require('node:path');

// Working space for one package download. Both candidate sources write here: the
// official catalog materializes a reviewed package into it, and the external
// client extracts a pasted repository's `.mos/` folder into it. The app agent
// only accepts a snapshot source confined to this root, so it is the one place
// an unvalidated package may ever land.
//
// A directory here lives for exactly one operation and the caller removes it when
// that operation ends. Nothing else collects them: a Suite Manager that is killed
// mid-download leaves its directory behind forever, and the next download creates
// another one beside it. Unbounded, that quietly fills the disk the installed apps
// themselves need, so the root is swept back inside these bounds before every
// download rather than only at startup.
const DEFAULT_CANDIDATE_POLICY = Object.freeze({
  maxEntries: 8,
  staleAfterMs: 60 * 60 * 1_000,
});

// Directories an in-flight operation in this process owns. A sweep never touches
// these: the download that created one is still writing to it, or the app agent
// is still reading it to stage a build. After a restart the set is empty, which
// is correct — nothing left on disk can still be owned.
const activeCandidateDirs = new Set();

function candidateRoot(stateDir) {
  return path.join(stateDir, 'app-candidates');
}

function candidateEntries(root) {
  const entries = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) entries.push({ dir, modifiedAt: stat.mtimeMs });
    } catch {}
  }
  return entries.sort((left, right) => left.modifiedAt - right.modifiedAt);
}

// Reclaim abandoned candidate downloads. Stale directories go first, then the
// oldest, until the root is inside its limits. Best effort by design: a directory
// another process still owns, or one that disappears mid-sweep, must never fail
// the download this sweep is making room for.
function sweepCandidateRoot(stateDir, { now = () => Date.now(), policy = {} } = {}) {
  const limits = { ...DEFAULT_CANDIDATE_POLICY, ...policy };
  const root = candidateRoot(stateDir);
  const removed = [];
  let entries;
  try { entries = candidateEntries(root); } catch { return removed; }
  const collectable = entries.filter((entry) => !activeCandidateDirs.has(entry.dir));
  const at = now();
  const excess = Math.max(0, entries.length - limits.maxEntries);
  for (const [index, entry] of collectable.entries()) {
    const stale = at - entry.modifiedAt >= limits.staleAfterMs;
    if (!stale && index >= excess) continue;
    try {
      fs.rmSync(entry.dir, { force: true, recursive: true });
      removed.push(entry.dir);
    } catch {}
  }
  return removed;
}

function createCandidateDir(stateDir, prefix, options = {}) {
  const root = candidateRoot(stateDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  sweepCandidateRoot(stateDir, options);
  const dir = fs.mkdtempSync(path.join(root, prefix));
  activeCandidateDirs.add(dir);
  return dir;
}

// End one operation's ownership of its candidate directory. Callers run this from
// a `finally`, including after a failed download, so a rejected package never
// stays on disk waiting for a sweep.
function releaseCandidateDir(candidateDir) {
  activeCandidateDirs.delete(candidateDir);
  try { fs.rmSync(candidateDir, { force: true, recursive: true }); } catch {}
}

module.exports = {
  DEFAULT_CANDIDATE_POLICY,
  activeCandidateDirs,
  candidateRoot,
  createCandidateDir,
  releaseCandidateDir,
  sweepCandidateRoot,
};
