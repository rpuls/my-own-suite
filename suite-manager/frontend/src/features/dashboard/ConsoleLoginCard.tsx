import { useEffect, useState } from 'react';

import { RecoveryKeySecret, type RevealedRecoveryKey } from '../../components/RecoveryKeySecret';
import { Checkbox, Dialog, Icon, Notice, Spinner } from '../../components/ui';
import { readVaultView, startupOf, type VaultView } from '../../lib/vault';

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

async function revealRecoveryKey(): Promise<RevealedRecoveryKey> {
  const response = await fetch('/suite-manager/api/backups/recovery-key/reveal', {
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) throw new Error('Unable to show the recovery key.');
  return await response.json() as RevealedRecoveryKey;
}

async function acknowledge(): Promise<void> {
  const response = await fetch('/suite-manager/api/settings/console-login/acknowledge', { method: 'POST' });
  if (!response.ok) throw new Error('Your confirmation was not recorded.');
}

async function acknowledgeRecoveryKey(): Promise<void> {
  const response = await fetch('/suite-manager/api/backups/recovery-key/acknowledge', { method: 'POST' });
  if (!response.ok) throw new Error('Your confirmation was not recorded.');
}

// The two secrets a machine hands its owner, in one panel, because there is
// exactly one moment when someone is sitting in front of a new install ready to
// write something down. Splitting them across two screens meant the recovery
// key was first shown at the first backup — and once that key also opens the
// disk, an owner whose security chip refuses before they ever took a backup is
// locked out of data they never had a chance to protect.
//
// Their lifecycles are opposite, and the dialog says so in both places. The
// server login exists only here and is deleted the moment it is confirmed. The
// recovery key stays on the machine for good, because unattended backups and
// the disk itself need it — what the owner is keeping is a second copy, for the
// day the machine cannot speak for itself.
export function ConsoleLoginCard() {
  const [status, setStatus] = useState<ConsoleLoginStatus | null>(null);
  const [vault, setVault] = useState<VaultView | null>(null);
  const [secret, setSecret] = useState<ConsoleLoginSecret | null>(null);
  const [key, setKey] = useState<RevealedRecoveryKey | null>(null);
  const [open, setOpen] = useState(false);
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
    // Read separately, and a failure leaves the vault half out rather than
    // taking the panel down with it: the server login is the credential with
    // only one copy, and it must still be handed over on a machine whose vault
    // agent is not answering.
    void readVaultView()
      .then((next) => { if (!cancelled) setVault(next); })
      .catch(() => { if (!cancelled) setVault(null); });
    return () => { cancelled = true; };
  }, []);

  const encrypted = Boolean(vault?.encrypted);
  const keyPending = Boolean(encrypted && vault?.recoveryKey && !vault.recoveryKey.acknowledged);
  const loginPending = Boolean(status?.pending);

  async function openPanel() {
    setBusy(true);
    setError('');
    try {
      // Both are fetched before the dialog opens, so it never appears with one
      // secret missing and no explanation for which.
      const [nextSecret, nextKey] = await Promise.all([
        loginPending ? revealSecret() : Promise.resolve(null),
        keyPending ? revealRecoveryKey() : Promise.resolve(null),
      ]);
      setSecret(nextSecret);
      setKey(nextKey);
      setOpen(true);
    } catch (openError) {
      setError((openError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function closePanel() {
    setOpen(false);
    setSecret(null);
    setKey(null);
    setConfirmed(false);
    setCopied(false);
    setRevealed(false);
    setError('');
  }

  async function saveAndRemove() {
    setBusy(true);
    setError('');
    try {
      // The recovery key first. Acknowledging it only records that it was
      // shown, while acknowledging the server login deletes the only copy of
      // it — so if one of the two is going to fail, it must be the reversible
      // one, and the owner must still be looking at the password when it does.
      if (key) await acknowledgeRecoveryKey();
      if (secret) await acknowledge();
      setStatus(await readStatus().catch(() => null));
      setVault(await readVaultView().catch(() => null));
      closePanel();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  }

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

  if (!loginPending && !keyPending) return null;

  const title = loginPending && keyPending
    ? 'Save your server login and recovery key'
    : (keyPending ? 'Save your recovery key' : 'Save your server login');

  return <>
    <section className="mos-panel suite-card suite-console-login-card">
      <h2 className="mos-card-title">{title}</h2>
      <p className="suite-meta mos-meta">One-time handover</p>
      <p>
        {loginPending && keyPending
          ? 'This machine made two secrets of its own the first time it booted: the login for the server itself, and the recovery key that opens its encrypted disk and its backups. Keep both somewhere safe before you go any further.'
          : (keyPending
            ? 'The data on this server is encrypted. The recovery key that opens it, and your backups, was made on this machine and nobody else has a copy.'
            : 'This machine generated its own login the first time it booted. It is the way back in if My Own Suite ever stops responding — and it is stored here, on this machine, until you tell us you have saved it.')}
      </p>
      <div className="suite-hero-actions">
        <button className="mos-btn mos-btn-primary" disabled={busy} onClick={() => void openPanel()} type="button">
          {busy && !open ? 'Opening...' : (loginPending && keyPending ? 'Show both' : (keyPending ? 'Show recovery key' : 'Show server login'))}
        </button>
      </div>
      {error && !open ? <Notice title="Could not show this" variant="error"><p>{error}</p></Notice> : null}
    </section>

    {open ? <Dialog
      footer={<>
        <button className="mos-btn mos-btn-primary" disabled={!confirmed || busy} onClick={() => void saveAndRemove()} type="button">
          {busy ? <><Spinner />Saving...</> : 'Save and continue'}
        </button>
        <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={closePanel} type="button">
          Not yet
        </button>
      </>}
      onClose={closePanel}
      title={loginPending && keyPending ? 'Your server login and recovery key' : (keyPending ? 'Your recovery key' : 'Your server login')}
    >
      {secret ? <>
        {keyPending ? <p className="mos-eyebrow">1 &middot; Server login</p> : null}
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
            confirm below, My Own Suite deletes <strong>this password</strong> from the machine and clears it
            from the screen attached to your server. If you lose it after that, you can still reset it from
            the server's own keyboard through Ubuntu recovery mode.
          </p>
        </Notice>
      </> : null}

      {key ? <>
        {secret ? <p className="mos-eyebrow">2 &middot; Recovery key</p> : null}
        <RecoveryKeySecret revealed={key} startup={startupOf(vault)} />
        <Notice title="This one MOS keeps a copy of" variant="info">
          <p>
            Unlike the password above, the recovery key stays on this server — it has to, so your backups can
            run on their own and the disk can open after a restart. What you are saving is a second copy, for
            the day this machine cannot be asked: a security chip that refuses after a firmware change, or a
            server that is gone and a backup drive that is all that is left.
          </p>
        </Notice>
      </> : null}

      <Checkbox checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.currentTarget.checked)}>
        {secret && key
          ? 'I have saved both somewhere safe, and the recovery key somewhere I can still reach if this server is gone.'
          : (key
            ? 'I have saved this recovery key somewhere I can still reach if this server is gone.'
            : 'I have saved this password somewhere safe.')}
      </Checkbox>

      {error ? <Notice title="That did not work" variant="error"><p>{error}</p></Notice> : null}
    </Dialog> : null}
  </>;
}
