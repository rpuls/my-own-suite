import { useEffect, useState } from 'react';

import { ScreenHold, Spinner } from '../../components/ui';
import { HoldHead } from './UpdateHold';

const POLL_MS = 3_000;
const ANSWER_TIMEOUT_MS = 5_000;
const LONG_WAIT_MS = 10 * 60_000;

// 'busy' is Caddy's own page standing in for a Suite Manager that is not running,
// which is all a server waiting for its startup password can show.
type Answer = 'suite-manager' | 'busy' | 'nothing';

async function askServer(): Promise<Answer> {
  try {
    const response = await fetch('/suite-manager/api/build', { cache: 'no-store', signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    return response.ok ? 'suite-manager' : 'busy';
  } catch {
    return 'nothing';
  }
}

// Only a server seen gone has restarted; until then Suite Manager answering is the old boot.
function isBack(answer: Answer, serverWasGone: boolean, asksForPassword: boolean) {
  if (!serverWasGone) return false;
  return answer === 'suite-manager' || (asksForPassword && answer === 'busy');
}

export function HostRestartHold({ asksForPassword }: { asksForPassword: boolean }) {
  const [serverWasGone, setServerWasGone] = useState(false);
  const [longWait, setLongWait] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let gone = false;
    const look = async () => {
      const answer = await askServer();
      if (cancelled) return;
      if (answer === 'nothing') {
        gone = true;
        setServerWasGone(true);
      }
      if (isBack(answer, gone, asksForPassword)) window.location.reload();
    };
    const poll = window.setInterval(() => void look(), POLL_MS);
    const slow = window.setTimeout(() => setLongWait(true), LONG_WAIT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearTimeout(slow);
    };
  }, [asksForPassword]);

  return <ScreenHold label="The server is restarting">
    <HoldHead icon={<Spinner />} title="The server is restarting" />
    <div className="suite-hold-copy">
      <strong>{serverWasGone ? 'Starting up again' : 'Shutting down'}</strong>
      <p>Every app is offline for a few minutes. {asksForPassword
        ? 'Once the server is up, this page takes you to where you type your password to open your data.'
        : 'This page reloads by itself once the suite is back.'}</p>
    </div>
    {longWait ? <>
      <p className="suite-meta">This is taking longer than a restart usually does. If the server does not come back, check that it is switched on.</p>
      <div className="suite-hold-actions">
        <button className="mos-btn mos-btn-secondary" onClick={() => window.location.reload()} type="button">Reload page</button>
      </div>
    </> : null}
  </ScreenHold>;
}
