// How an app source the owner added is named wherever it appears.
//
// The host is not an identity. An owner can add several repositories from the
// same one, and a heading reading "github.com" over each of their sections says
// nothing about which source is which — or, worse, reads as though they were one
// source. The owner/repository path is what tells them apart, and it is already
// what the Settings row shows, so the Apps screen names a source the same way.
export function appSourceLabel(repository: string) {
  try {
    const url = new URL(repository);
    const path = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
    return path || url.hostname;
  } catch {
    return repository;
  }
}

// Shared so the Settings row and the app card cannot round the same instant apart.
export function sourceCheckedLabel(at: string | null | undefined) {
  if (!at) return 'never';
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return 'never';
  const minutes = Math.round((Date.now() - parsed) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

// What MOS last learned from a source, and when it may ask again.
export type SourceCatalog = {
  checkedAt: string | null;
  error: { at: string | null; code: string; failures: number; message: string; retryAt: string | null } | null;
  fetchedAt: string | null;
  nextCheckAt: string | null;
  packageCount: number | null;
  revision: string | null;
};

export type AppSource = {
  addedAt: string;
  catalog: SourceCatalog;
  catalogPath: string;
  id: string;
  kind: string;
  mosReviewed: false;
  official: false;
  publisher: string | null;
  repository: string;
  revision: string | null;
  signed: boolean;
  status: 'active' | 'unavailable' | 'compromised' | 'removed';
  statusReason: string | null;
  trust: string;
  updatedAt: string;
};

// Plain language for what the git host actually answered, because the answers need
// opposite responses from the owner. A repository that has gone private is theirs to
// look at; a rate limit resolves on its own. MOS never claims the repository was
// deleted: the host returns the same answer whether it was deleted, renamed, or made
// private, so saying which would be a guess.
export function sourceFailureCopy(error: NonNullable<SourceCatalog['error']>): { detail: string; title: string } {
  if (error.code === 'SOURCE_NOT_VISIBLE') {
    return {
      detail: 'GitHub will not show this repository to an anonymous request. It may have been deleted, renamed, or made private. Open it to see which, then refresh.',
      title: 'This repository no longer answers',
    };
  }
  if (error.code === 'SOURCE_RATE_LIMITED') {
    return {
      detail: 'GitHub is limiting how often this server may ask without an account. MOS waits and tries again on its own; nothing is wrong with the source.',
      title: 'GitHub asked MOS to slow down',
    };
  }
  return { detail: error.message, title: 'MOS could not check this source' };
}

export function fetchTime(at: string | null | undefined) {
  return at && !Number.isNaN(Date.parse(at)) ? new Date(at).toLocaleString() : 'never';
}

// One line for a source's last check and its next one, for the technical panels.
export function sourceFetchSummary(catalog: SourceCatalog) {
  const next = `next check ${catalog.nextCheckAt ? fetchTime(catalog.nextCheckAt) : 'now'}`;
  if (catalog.error) {
    const run = catalog.error.failures > 1 ? ` (${catalog.error.failures} in a row)` : '';
    return `failed ${fetchTime(catalog.error.at)}${run} · ${sourceFailureCopy(catalog.error).title} · ${next}`;
  }
  const count = catalog.packageCount;
  const apps = count === null ? 'no apps read yet' : `${count} ${count === 1 ? 'app' : 'apps'}`;
  return `checked ${fetchTime(catalog.checkedAt)} · ${apps} · ${next}`;
}
