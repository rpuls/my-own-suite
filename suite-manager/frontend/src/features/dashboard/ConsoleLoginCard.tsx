import { useEffect, useState } from 'react';

import { Checkbox, Dialog, Icon, Notice, Spinner } from '../../components/ui';

type ConsoleLoginStatus = { acknowledged: boolean; pending: boolean; unreadable?: boolean; username: string };
type ConsoleLoginSecret = { password: string; username: string };

async function readStatus(): Promise<ConsoleLoginStatus> {
  const response = await fetch('/suite-manager/api/settings/console-login');
  if (!response.ok) throw new Error('Unable to read the server login state.');
  return await response.json() as ConsoleLoginStatus;
}

async function revealSecret(): Promise<ConsoleLoginSecret> {
  const response = await fetch('/suite-manager/api/settings/console-login/reveal', { method: 'POST' });
  if (!response.ok) throw new Error('Unable to show the server login.');
  return await response.json() as ConsoleLoginSecret;
}

async function acknowledge(): Promise<void> {
  const response = await fetch('/suite-manager/api/settings/console-login/acknowledge', { method: 'POST' });
  if (!response.ok) throw new Error('Your confirmation was not recorded.');
}

// The password exists in exactly one place — this machine — and MOS deletes its
// copy the moment the owner says they have it. That makes this the only chance
// to save it, so the panel is deliberately hard to dismiss by accident: the
// confirmation is explicit, and the tile stays on the dashboard until it is given.
export function ConsoleLoginCard() {
  const [status, setStatus] = useState<ConsoleLoginStatus | null>(null);
  const [secret, setSecret] = useState<ConsoleLoginSecret | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void readStatus()
      .then((next) => { if (!cancelled) setStatus(next); })
      // A card that cannot read its own state stays away rather than claiming
      // there is nothing to save.
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, []);

  async function openPanel() {
    setBusy(true);
    setError('');
    try {
      setSecret(await revealSecret());
    } catch (openError) {
      setError((openError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function closePanel() {
    setSecret(null);
    setConfirmed(false);
    setCopied(false);
    setRevealed(false);
    setError('');
  }

  async function saveAndRemove() {
    setBusy(true);
    setError('');
    try {
      await acknowledge();
      setStatus({ acknowledged: true, pending: false, username: '' });
      closePanel();
    } catch (saveError) {
      setError((saveError as Error).message);
      setBusy(false);
    }
  }

  // An own-hardware install serves plain HTTP until the owner sets up a domain,
  // and the clipboard API does not exist outside a secure context. The button
  // says so instead of doing nothing, and reveals the password so the fallback
  // it suggests is actually available — the shown password is select-all.
  async function copyPassword() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setRevealed(true);
      setError('This browser will not copy from an insecure page. Select the password above and copy it by hand.');
    }
  }

  // A handover that exists but cannot be opened has no panel to offer, and
  // saying nothing would present a stranded password as a finished one. The
  // owner cannot fix this from here, so it points at the one thing that can.
  if (status?.unreadable) {
    return <section className="mos-panel suite-card suite-console-login-card">
      <h2 className="mos-card-title">Save your server login</h2>
      <p className="suite-meta mos-meta">One-time handover</p>
      <Notice title="This server login cannot be shown" variant="warning">
        <p>
          This machine generated its own login the first time it booted, but My Own Suite is not
          allowed to read the file it was stored in. The login itself still works &mdash; it just
          cannot be handed over here. See <a href="https://myownsuite.org/docs/install/own-hardware/">
          the install guide</a> for how to recover it.
        </p>
      </Notice>
    </section>;
  }

  if (!status?.pending) return null;

  return <>
    <section className="mos-panel suite-card suite-console-login-card">
      <h2 className="mos-card-title">Save your server login</h2>
      <p className="suite-meta mos-meta">One-time handover</p>
      <p>
        This machine generated its own login the first time it booted. It is the way back in if
        My Own Suite ever stops responding — and it is stored here, on this machine, until you tell
        us you have saved it.
      </p>
      <div className="suite-hero-actions">
        <button className="mos-btn mos-btn-primary" disabled={busy} onClick={() => void openPanel()} type="button">
          {busy && !secret ? 'Opening...' : 'Show server login'}
        </button>
      </div>
      {error && !secret ? <Notice title="Could not show the server login" variant="error"><p>{error}</p></Notice> : null}
    </section>

    {secret ? <Dialog
      footer={<>
        <button className="mos-btn mos-btn-primary" disabled={!confirmed || busy} onClick={() => void saveAndRemove()} type="button">
          {busy ? <><Spinner />Removing...</> : 'Save and remove'}
        </button>
        <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={closePanel} type="button">
          Not yet
        </button>
      </>}
      onClose={closePanel}
      title="Your server login"
    >
      <p className="suite-meta">
        This is the login for the server machine itself — its console and SSH. It is <strong>not</strong> your
        My Own Suite account, and you will rarely need it. Put it in your password manager now.
      </p>

      {/* Masked until asked for. Opening this dialog should not put the password
          on a screen someone else in the room can read, and copying it to the
          password manager never needs it visible at all. */}
      <dl className="suite-console-login-secret">
        <dt>Username</dt>
        <dd>{secret.username}</dd>
        <dt>Password</dt>
        <dd className={revealed ? undefined : 'suite-console-login-masked'}>
          {revealed ? secret.password : '•'.repeat(secret.password.length)}
        </dd>
      </dl>

      <div className="suite-hero-actions">
        <button className="mos-btn mos-btn-secondary" onClick={() => void copyPassword()} type="button">
          {copied ? <><Icon name="check" />Copied</> : 'Copy password'}
        </button>
        <button
          aria-pressed={revealed}
          className="mos-btn mos-btn-secondary"
          onClick={() => setRevealed((current) => !current)}
          type="button"
        >
          <Icon name={revealed ? 'eye-off' : 'eye'} />{revealed ? 'Hide' : 'Show'}
        </button>
      </div>

      <Notice title="This is the only copy" variant="warning">
        <p>
          Nobody else has it — not the project, not the installer, not the download you flashed. When you
          confirm below, My Own Suite deletes it from this machine and clears it from the screen attached
          to your server. If you lose it after that, you can still reset it from the server's own keyboard
          through Ubuntu recovery mode.
        </p>
      </Notice>

      <Checkbox checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.currentTarget.checked)}>
        I have saved this password somewhere safe.
      </Checkbox>

      {error ? <Notice title="That did not work" variant="error"><p>{error}</p></Notice> : null}
    </Dialog> : null}
  </>;
}
