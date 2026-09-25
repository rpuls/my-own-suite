import { useCallback, useEffect, useState } from 'react';

import { AuthStage } from '../../components/AuthStage';
import { RecoveryKeySecret } from '../../components/RecoveryKeySecret';
import { Checkbox, Notice, SecretText, Spinner } from '../../components/ui';
import { fetchConsoleLogin, markConsoleLoginSaved, type ConsoleLogin } from '../../lib/console-login';
import { fetchRecoveryKey, markRecoveryKeySaved, type RevealedRecoveryKey } from '../../lib/recovery-key';
import { readVaultView, startupOf, type VaultView } from '../../lib/vault';
import type { HandoverState, Owner } from './types';

type Secrets = { key: RevealedRecoveryKey | null; login: ConsoleLogin | null; vault: VaultView };

type HandoverGateScreenProps = {
  handover: HandoverState;
  onLogout: () => Promise<void>;
  // Re-reads the setup status: what brings the page down once everything is
  // confirmed, and what "Try again" asks for when a read failed.
  onRefresh: () => Promise<void>;
  owner: Owner;
};

// The page between the terms and Suite Manager. A machine hands its owner two
// secrets of its own making — the server login and, when the disk is
// encrypted, the recovery key — and there is exactly one moment when someone is
// sitting in front of a new install ready to write something down. A card on
// Home could be scrolled past, and a key that was never saved is a disk and a
// backup nobody can open; so nothing else is reachable until both are
// confirmed. Their lifecycles are opposite, and the page says so in both
// places: the login exists only here and is deleted the moment it is
// confirmed, the key stays on the machine for good.
export function HandoverGateScreen({ handover, onLogout, onRefresh, owner }: HandoverGateScreenProps) {
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [loadError, setLoadError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstName = owner.name.trim().split(/\s+/)[0] || owner.name;

  const loginPending = handover.login === 'pending';
  const keyPending = handover.recoveryKey === 'pending';
  // What could not be read holds the page, whatever else is on it: the owner
  // cannot confirm they have saved a secret MOS could not show them.
  const held = handover.login === 'unreadable' || handover.recoveryKey === 'unknown';

  const load = useCallback(async () => {
    setLoadError('');
    setSecrets(null);
    try {
      const [vault, login, key] = await Promise.all([
        readVaultView(),
        loginPending ? fetchConsoleLogin() : Promise.resolve(null),
        keyPending ? fetchRecoveryKey() : Promise.resolve(null),
      ]);
      setSecrets({ key, login, vault });
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : 'Unable to read what this machine has to hand you.');
    }
  }, [keyPending, loginPending]);

  useEffect(() => { void load(); }, [load]);

  async function refresh() {
    setBusy(true);
    setError('');
    try {
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Suite Manager could not be reached. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  async function saveAndContinue() {
    if (!secrets) return;
    setBusy(true);
    setError('');
    try {
      // The recovery key first. Acknowledging it only records that it was
      // shown, while acknowledging the server login deletes the only copy of
      // it — so if one of the two is going to fail, it must be the reversible
      // one, and the owner must still be looking at the password when it does.
      if (secrets.key) await markRecoveryKeySaved();
      if (secrets.login) await markConsoleLoginSaved();
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your confirmation was not recorded.');
    } finally {
      setBusy(false);
    }
  }

  const title = loginPending && keyPending
    ? 'Save your server login and recovery key'
    : (keyPending ? 'Save your recovery key' : (loginPending ? 'Save your server login' : 'Suite Manager cannot open yet'));
  const lead = loginPending && keyPending
    ? 'This machine made two secrets of its own the first time it booted: the login for the server itself, and the recovery key that opens its encrypted disk and your backups. Suite Manager opens once you have put both somewhere safe.'
    : (keyPending
      ? 'The data on this server is encrypted. The recovery key that opens it, and your backups, was made on this machine and nobody else has a copy. Suite Manager opens once you have put it somewhere safe.'
      : (loginPending
        ? 'This machine generated its own login the first time it booted. It is the way back in if My Own Suite ever stops responding, and Suite Manager opens once you have put it somewhere safe.'
        : 'This machine has something to hand you before Suite Manager opens, and right now it cannot be read.'));
  const unencrypted = secrets && !keyPending && secrets.vault.vault.state === 'unsupported';
  const canConfirm = !held && secrets !== null && (secrets.login !== null || secrets.key !== null);
  const confirmLabel = secrets?.login && secrets.key
    ? 'I have saved both somewhere safe, and the recovery key somewhere I can still reach if this server is gone.'
    : (secrets?.key
      ? 'I have saved this recovery key somewhere I can still reach if this server is gone.'
      : 'I have saved this password somewhere safe.');

  return (
    <AuthStage className="suite-handover-stage">
      <div className="suite-auth-copy">
        <h1 className="mos-page-title">{title}</h1>
        <p className="suite-lead mos-body-lg">{firstName}, {lead.charAt(0).toLowerCase()}{lead.slice(1)}</p>
      </div>

      {handover.recoveryKey === 'unknown' ? <Notice title="Your recovery key cannot be shown yet" variant="warning">
        <p>
          MOS could not read whether this server&rsquo;s disk is encrypted, or which key opens it: the service it
          asks is not answering. It will not open Suite Manager on a guess, because a key skipped here is one you
          were never shown. Try again in a moment; if this keeps happening, restart the server.
        </p>
        <div className="suite-hero-actions">
          <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={() => void refresh()} type="button">Try again</button>
        </div>
      </Notice> : null}

      {handover.login === 'unreadable' ? <Notice title="This server login cannot be shown" variant="warning">
        <p>
          This machine generated its own login the first time it booted, but My Own Suite is not allowed to read
          the file it was stored in. The login itself still works and is on the screen attached to your server;
          it just cannot be handed over here. See <a href="https://myownsuite.org/docs/install/own-hardware/">the
          install guide</a> for how to recover it.
        </p>
      </Notice> : null}

      {loadError ? <Notice title="Could not read what this machine has to hand you" variant="error">
        <p>{loadError}</p>
        <div className="suite-hero-actions">
          <button className="mos-btn mos-btn-secondary" onClick={() => void load()} type="button">Try again</button>
        </div>
      </Notice> : null}

      {!secrets && !loadError && (loginPending || keyPending)
        ? <p className="suite-meta suite-handover-loading"><Spinner />Reading what this machine has to hand you...</p>
        : null}

      {secrets?.login ? <section className="mos-panel suite-card suite-handover-card">
        <h2 className="mos-card-title">{secrets.key ? '1 · Server login' : 'Server login'}</h2>
        <p className="suite-meta">
          This is the login for the server machine itself — its console and SSH. It is <strong>not</strong> your
          My Own Suite account, and you will rarely need it. Put it in your password manager now.
        </p>
        <dl className="suite-handover-login">
          <dt>Username</dt>
          <dd><code>{secrets.login.username}</code></dd>
          <dt>Password</dt>
          <dd><SecretText label="server password" masked value={secrets.login.password} /></dd>
        </dl>
        <Notice title="This is the only copy" variant="warning">
          <p>
            Nobody else has it — not the project, not the installer, not the download you flashed. When you
            confirm below, My Own Suite deletes <strong>this password</strong> from the machine and clears it
            from the screen attached to your server. If you lose it after that, you can still reset it from
            the server&rsquo;s own keyboard through Ubuntu recovery mode.
          </p>
        </Notice>
      </section> : null}

      {secrets?.key ? <section className="mos-panel suite-card suite-handover-card">
        <h2 className="mos-card-title">{secrets.login ? '2 · Recovery key' : 'Recovery key'}</h2>
        <RecoveryKeySecret masked revealed={secrets.key} startup={startupOf(secrets.vault)} />
        <Notice title="This one MOS keeps a copy of" variant="info">
          <p>
            Unlike the server login, the recovery key stays on this server — it has to, so your backups can run
            on their own and the disk can open after a restart. What you are saving is a second copy, for the
            day this machine cannot be asked: a security chip that refuses after a firmware change, or a server
            that is gone and a backup drive that is all that is left. Until you confirm below, a copy also sits
            on the unencrypted part of the disk so this server can always open; confirming removes it, and from
            then on the encryption is protecting your data.
          </p>
        </Notice>
      </section> : null}

      {unencrypted ? <Notice title="This server's app data is not encrypted" variant="info">
        <p>{secrets.vault.vault.sentence || 'MOS could not encrypt this machine\'s disk, so app data is stored unencrypted. Settings → Disk encryption says why.'}</p>
      </Notice> : null}

      <section className="mos-panel suite-card suite-handover-card">
        {canConfirm ? <Checkbox checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.currentTarget.checked)}>
          {confirmLabel}
        </Checkbox> : null}
        {error ? <Notice title="That did not work" variant="error"><p>{error}</p></Notice> : null}
        <div className="suite-hero-actions">
          {canConfirm ? <button className="mos-btn mos-btn-primary" disabled={!confirmed || busy} onClick={() => void saveAndContinue()} type="button">
            {busy ? <><Spinner />Saving...</> : 'Save and continue'}
          </button> : null}
          <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={() => void onLogout()} type="button">
            Sign out
          </button>
        </div>
      </section>
    </AuthStage>
  );
}
