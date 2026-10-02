// A single-page app never asks for its own document twice: once it is loaded,
// navigation is client-side and nothing re-requests index.html. So a MOS update
// leaves the tab running the bundle from before it, against a backend that has
// moved on — which is not only a stale-looking page, it is old code calling
// endpoints that may have changed shape. Nothing but loading the document again
// fixes that, and the Updates screen does exactly that when the update it is
// watching finishes.
//
// The server stamps the build it served into the document and answers with the
// build it serves now. Comparing the two is the honest test: it is the bundle's
// identity rather than the update job's, so a restart that shipped no new
// frontend has nothing to reload for.

// Read once, from the document as it was delivered — this is the build this tab
// is actually running, not whatever is on disk by the time it is read.
const loadedBuildId = document.querySelector<HTMLMetaElement>('meta[name="mos-build"]')?.content || '';

export async function servedBuildId(): Promise<string> {
  const response = await fetch('/suite-manager/api/build', { cache: 'no-store' });
  if (!response.ok) return '';
  const body = await response.json() as { id?: unknown };
  return typeof body.id === 'string' ? body.id : '';
}

// An empty id on either side means there is nothing to compare rather than a
// mismatch: the dev server stamps no meta tag, and a backend that predates the
// endpoint answers with nothing. Neither is a reason to reload.
export function buildChanged(served: string) {
  return Boolean(loadedBuildId && served && served !== loadedBuildId);
}
