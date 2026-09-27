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
