import { useEffect, useState, type FormEvent } from 'react';

import { Dialog, Icon, Notice, Panel, PanelBand, PanelHead, PanelItem, PanelList, Switch, TextInput } from '../../components/ui';
import { postJson } from '../../lib/api';
import { readVaultView, type VaultView } from '../../lib/vault';

// Turning startup protection on or off is confirmed with the owner password
// rather than a checkbox, because the password is not only the confirmation —
// it is the secret being enrolled. This dialog is the one moment MOS holds it
// for that purpose outside a password change and a sign-in.
function StartupProtectionDialog({ enabling, onClose, onDone }: {
  enabling: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || saving) return;
    setSaving(true);
    setError('');
    try {
      await postJson('/suite-manager/api/settings/vault/startup-password', { enabled: enabling, password }, 'How this server starts could not be changed.');
      setPassword('');
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'How this server starts could not be changed.');
    } finally {
      setSaving(false);
    }
  }

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" disabled={!password || saving} form="startup-protection" type="submit">
        {saving ? 'Saving...' : enabling ? 'Ask for my password' : 'Open by itself'}
      </button>
    </>}
    onClose={onClose}
    title={enabling ? 'Ask for your password at startup' : 'Let this server open itself'}
  >
    {enabling ? <>
      <p>From now on, this server waits for your password after every restart — including a power cut — and your apps stay off until you type it. If you are away and cannot reach this page, they stay off until you can.</p>
      <p>In exchange, a stolen server gives up nothing: without your password its disk stays closed, and so do the backups whose key is inside it.</p>
    </> : <>
      <p>This server will open its own disk when it starts, so a power cut needs nothing from you and your apps come back on their own.</p>
      <p>The trade is that someone who takes the whole machine and knows Linux can get into it. A disk pulled out on its own, or this machine sold, still gives up nothing.</p>
    </>}
    <form id="startup-protection" onSubmit={(event) => void submit(event)}>
      <TextInput
        autoComplete="current-password"
        autoFocus
        helperText="The password you sign in to Suite Manager with. It is what your server's security chip will ask for."
        label="Your password"
        onChange={(event) => { setPassword(event.target.value); setError(''); }}
        type="password"
        value={password}
      />
    </form>
    {error ? <Notice title="Nothing was changed" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}

/**
 * The standing answer to "is my data encrypted, and what happens when this
 * thing restarts" — the question an owner has months after the setup screen
 * that showed them their recovery key.
 *
 * It says what is true of this machine in this mode and never more than that.
 * Each mode protects something different, and the one claim MOS must never make
 * is the blanket one: only a machine with startup protection on is useless to
 * someone who walks off with it.
 */

export function EncryptionPanel() {
  const [view, setView] = useState<VaultView | null>(null);
  const [asking, setAsking] = useState<'off' | 'on' | null>(null);

  async function load() {
    try {
      setView(await readVaultView());
    } catch {
      // A panel that cannot read its own state says nothing rather than
      // guessing, in either direction.
      setView(null);
    }
  }

  useEffect(() => { void load(); }, []);

  if (!view) return null;

  const hasChip = Boolean(view.vault.tpm);
  const asksForPassword = view.asksForPassword;
  // `unknown` is the agent not answering, never "not encrypted": the machine
  // still has whatever disk it had a minute ago.
  const unencryptedSentence = view.vault.state === 'unknown'
    ? 'MOS could not read how this server\'s disk is set up just now. Reload in a moment.'
    : view.vault.sentence || 'This server keeps its app data on an unencrypted disk. Your backups are still encrypted with your recovery key.';

  return <Panel>
    <PanelHead heading="h3" title="Disk encryption">
      <p>{view.encrypted
        ? "Your apps' data, your Suite Manager settings and your apps' secrets are all held on an encrypted part of this server's disk. A disk pulled out and read elsewhere gives up nothing."
        : unencryptedSentence}</p>
    </PanelHead>

    {view.encrypted && view.chipNeedsRepair ? <PanelBand
      icon="key"
      note="Its security chip is waiting to be taught what it needs to know again. MOS repairs that the next time you sign in; until then, a restart asks for the recovery key from your recovery kit."
      title="This server will ask for your recovery key after a restart"
      tone="warning"
    /> : null}

    {view.encrypted ? <PanelList>
      <PanelItem>
        {hasChip ? <Switch
          checked={asksForPassword}
          description={asksForPassword
            ? 'Your apps stay off after a restart until you type your password. If it is stolen, nobody gets in: the disk stays closed, and so do the backups whose key is inside it. Turning this off means the server opens itself again, and a stolen machine can be got into.'
            : 'This server opens its own disk when it starts, so a power cut needs nothing from you, but a thief who takes the whole machine and knows Linux can get into it. Turning this on is the only thing that makes it useless to someone who steals it; the cost is that your apps stay off after every restart until you type your password.'}
          label="Ask for my password when this server starts"
          onChange={(event) => setAsking(event.currentTarget.checked ? 'on' : 'off')}
        /> : <p className="suite-meta">This machine has no security chip, so it cannot open its own disk. It asks for your recovery key on a web page after every restart, and your apps start once you enter it.</p>}
      </PanelItem>
      <PanelItem>
        <div className="suite-settings-row">
          <p className="suite-meta">Your recovery key opens this disk and your backups whatever happens to the chip, and it is the only way in if you forget your password.</p>
          <a className="mos-link suite-settings-link" href="/suite-manager/backups">Recovery key in Backup &amp; Restore<Icon name="arrow-right" /></a>
        </div>
      </PanelItem>
    </PanelList> : null}

    {asking ? <StartupProtectionDialog
      enabling={asking === 'on'}
      // Reloaded on cancel as well: a refused switch may have left the chip
      // slot wiped and the mode changed, and the panel must show that state
      // rather than the one the owner started from.
      onClose={() => { setAsking(null); void load(); }}
      onDone={() => { setAsking(null); void load(); }}
    /> : null}
  </Panel>;
}
