import { useState, type FormEvent } from 'react';

import { Notice, Panel, PanelBody, PanelHead, TextInput } from '../../components/ui';
import { postJson } from '../../lib/api';
import { EditToggle } from './EditToggle';

const MIN_PASSWORD_LENGTH = 12;

// Rotating the owner password matters most on the installs where it was created
// over plain HTTP — a local or own-hardware suite that had no certificate yet.
// The first password travelled the LAN in the clear; this is how it stops being
// the password that guards everything.
export function OwnerAccountPanel() {
  const [editing, setEditing] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  // Why the chip did not follow the change, when it did not. The two reasons
  // leave the machine in different states and the owner has to be told which:
  // a chip that refused now holds nothing, an agent that was unreachable was
  // never told and the chip may still hold the previous password.
  const [chipFailed, setChipFailed] = useState<'refused' | 'unreachable' | null>(null);

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit = Boolean(currentPassword && newPassword.length >= MIN_PASSWORD_LENGTH && newPassword === confirmPassword && !saving);

  function clearForm() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setChanged(false);
    if (!canSubmit) return;
    setSaving(true);
    try {
      // The change always goes through, so the only thing the answer can add is
      // whether the disk followed it. It reports that rather than hiding it: the
      // owner has to know which password their server will want after a restart.
      const result = await postJson<{ startupProtection?: { ok: boolean; reason?: string | null } | null }>('/suite-manager/api/settings/owner/password', { currentPassword, newPassword }, 'Your password could not be changed.');
      clearForm();
      const protection = result.startupProtection;
      setChipFailed(!protection || protection.ok ? null : protection.reason === 'vault-agent-unavailable' ? 'unreachable' : 'refused');
      setChanged(true);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your password could not be changed.');
    } finally {
      setSaving(false);
    }
  }

  return <Panel>
    <PanelHead actions={<EditToggle editing={editing} label="Change" onToggle={() => { clearForm(); setChanged(false); setEditing(!editing); }} />} heading="h3" title="Owner password">
      <p>The password for the account that controls Suite Manager and every app you install.</p>
    </PanelHead>
    {editing || changed ? <PanelBody>
      {editing ? <form className="suite-settings-form" onSubmit={(event) => void submit(event)}>
        <TextInput autoComplete="current-password" autoFocus label="Current password" onChange={(event) => { setCurrentPassword(event.target.value); setError(''); }} type="password" value={currentPassword} />
        <div className="suite-settings-fields">
          <TextInput autoComplete="new-password" helperText={tooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : `At least ${MIN_PASSWORD_LENGTH} characters.`} label="New password" minLength={MIN_PASSWORD_LENGTH} onChange={(event) => { setNewPassword(event.target.value); setError(''); }} type="password" value={newPassword} />
          <TextInput autoComplete="new-password" helperText={mismatch ? "Those passwords don't match." : 'Retype it to catch typos.'} label="Confirm new password" minLength={MIN_PASSWORD_LENGTH} onChange={(event) => { setConfirmPassword(event.target.value); setError(''); }} type="password" value={confirmPassword} />
        </div>
        {error ? <Notice title="Your password was not changed" variant="error"><p>{error}</p></Notice> : null}
        <div className="suite-settings-actions">
          <button className="mos-btn mos-btn-primary" disabled={!canSubmit} type="submit">{saving ? 'Changing password...' : 'Change password'}</button>
        </div>
      </form> : null}
      {changed ? <Notice title="Password changed" variant="success"><p>Your new password is active. Every other signed-in browser was signed out; this one stays signed in.</p></Notice> : null}
      {changed && chipFailed === 'refused' ? <Notice title="Your server's chip did not follow the change" variant="warning">
        <p>Your password changed, and your old one no longer opens anything. But this server&apos;s security chip would not take the new one, so it now opens nothing on its own: after a restart it asks for the recovery key from your recovery kit instead of your password.</p>
        <p>MOS tries again the next time you sign in, so signing out and back in is usually the whole fix.</p>
      </Notice> : null}
      {changed && chipFailed === 'unreachable' ? <Notice title="Your server's chip was not told about the change" variant="warning">
        <p>Your password changed, but the part of MOS that manages this server&apos;s disk was not answering, so its security chip was not taught the new one. If this server is set to ask for your password when it starts, it may still want your previous password after a restart; your recovery key opens it either way.</p>
        <p>Once MOS is answering again, turning <strong>Ask for my password when this server starts</strong> off and on in Disk encryption teaches the chip your current password.</p>
      </Notice> : null}
    </PanelBody> : null}
  </Panel>;
}
