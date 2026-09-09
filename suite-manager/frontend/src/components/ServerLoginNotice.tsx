import { useEffect, useState } from 'react';

import { Notice } from './ui';

// The one notice a screen shows in place of its controls while this machine's
// console login is still waiting on the Home page to be saved. `what` names
// the thing that is waiting, in the plural the screen uses ("Backups and
// restores"), so every screen that has to wait says so in the same words.
export function ServerLoginNotice({ what }: { what: string }) {
  return <Notice title="Save your server login first" variant="warning">
    <p>This machine generated its own console and SSH login the first time it booted, and it is still waiting on the Home page for you to save it. That login is part of what a backup carries and a restore replaces, so it has to be in your hands before it can be copied or overwritten. {what} open up as soon as you have saved it.</p>
    <a className="mos-btn mos-btn-primary" href="/suite-manager/">Go to Home</a>
  </Notice>;
}

// Whether a handover is still pending (or unreadable) on this machine, for a
// screen whose own status call does not already say. Null until known, so a
// screen can hold its controls back rather than flash them.
export function useServerLoginUnsaved() {
  const [unsaved, setUnsaved] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch('/suite-manager/api/settings/console-login')
      .then(async (response) => (response.ok ? await response.json() as { pending?: boolean; unreadable?: boolean } : {}))
      .then((status) => { if (!cancelled) setUnsaved(status.pending === true || status.unreadable === true); })
      .catch(() => { if (!cancelled) setUnsaved(false); });
    return () => { cancelled = true; };
  }, []);
  return unsaved;
}
