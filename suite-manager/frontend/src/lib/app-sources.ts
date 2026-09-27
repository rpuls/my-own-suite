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
