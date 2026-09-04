// A single-page app never asks for its own document twice: once it is loaded,
// navigation is client-side and nothing re-requests index.html. So a MOS update
// leaves every open tab running the bundle from before it, against a backend
// that has moved on — which is not only a stale-looking page, it is old code
// calling endpoints that may have changed shape. Nothing but loading the
// document again fixes that, so this is what works out when to.
//
// The server stamps the build it served into the document and answers with the
// build it serves now. Comparing the two is the honest test: it is the bundle's
// identity rather than the update job's, so a restart that shipped no new
// frontend says nothing, and an update applied from another tab or on a
// schedule is still noticed here.

import { useEffect, useState } from 'react';

const POLL_MS = 60_000;

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
// endpoint answers with nothing. Neither is a reason to tell someone to reload.
export function buildChanged(served: string) {
  return Boolean(loadedBuildId && served && served !== loadedBuildId);
}

// True once this tab is known to be running a bundle the server no longer
// serves. It only ever goes from false to true, and stops asking once it has.
export function useStaleFrontend() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!loadedBuildId || stale) return undefined;
    let cancelled = false;
    const check = () => {
      void servedBuildId()
        .then((served) => { if (!cancelled && buildChanged(served)) setStale(true); })
        .catch(() => undefined);
    };
    // Two triggers, for the two ways a tab misses an update it did not start:
    // left open and visible while the update ran elsewhere, or in the
    // background throughout and only looked at afterwards.
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') check(); };
    const timer = window.setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [stale]);
  return stale;
}
