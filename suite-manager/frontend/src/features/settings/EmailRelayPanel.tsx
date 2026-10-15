import { useEffect, useState, type FormEvent } from 'react';

import { AdvancedPanel, Checkbox, InputAction, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList, Select, TextInput } from '../../components/ui';
import { jsonResponse, postJson } from '../../lib/api';
import { EditToggle } from './EditToggle';

type SmtpStatus = {
  allowInvalidCert: boolean;
  configured: boolean;
  configuredAt: string | null;
  fromAddress: string | null;
  fromName: string | null;
  host: string | null;
  lastVerify: { at: string | null; diagnostics: string | null; errorCode: string | null; status: string };
  ownerEmail: string | null;
  passwordConfigured: boolean;
  port: number | null;
  security: 'none' | 'starttls' | 'tls';
  username: string | null;
};

type SmtpVerify = { diagnostics?: string | null; errorCode?: string; reason?: string; secured?: boolean; status: string };

type SmtpSaveResult = { status: SmtpStatus; verify: SmtpVerify };

// The owner may leave encryption on Automatic and let MOS match it to the port;
// the explicit modes stay for anyone whose provider tells them exactly which.
type SmtpSecurityChoice = 'auto' | SmtpStatus['security'];

const SMTP_DEFAULT_PORTS: Record<SmtpStatus['security'], number> = { none: 25, starttls: 587, tls: 465 };

function portHint(security: SmtpSecurityChoice) {
  return security === 'auto' ? 587 : SMTP_DEFAULT_PORTS[security];
}

// The relay's own record of whether it last checked out, shown as ambient detail
// when it did and as the diagnostic when it did not — the same on-failure panel
// pattern the HTTPS screen uses, so a working relay stays quiet and a broken one
// explains itself with what the relay actually said.
function SmtpDiagnostics({ status }: { status: SmtpStatus }) {
  const verify = status.lastVerify;
  return <AdvancedPanel facts={[
    { label: 'Host', value: status.host ? `${status.host}:${status.port ?? ''}` : 'Not configured' },
    { label: 'Encryption', value: status.security },
    { label: 'Login', value: status.username ? status.username : 'None (unauthenticated relay)' },
    { label: 'From', value: status.fromAddress || 'Not configured' },
    { label: 'Last check', value: `${verify.status}${verify.errorCode ? ` (${verify.errorCode})` : ''}${verify.at ? ` at ${new Date(verify.at).toLocaleString()}` : ''}` },
  ]} output={verify.diagnostics || undefined} reveal={verify.status === 'failed' ? 'on-failure' : 'technical-mode'} />;
}

// Outbound email is optional and MOS never needs it for itself; it exists so an
// app that sends mail — a password reset, a notification — has a relay to send
// through. A single relay is shared by every app that asks for it, and MOS
// exposes it to those apps and nothing else.
export function EmailRelayPanel() {
  const [status, setStatus] = useState<SmtpStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [security, setSecurity] = useState<SmtpSecurityChoice>('auto');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [allowInvalidCert, setAllowInvalidCert] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<SmtpVerify | null>(null);
  const [testResult, setTestResult] = useState('');
  const [testTo, setTestTo] = useState('');

  function apply(next: SmtpStatus) {
    setStatus(next);
    setHost(next.host || '');
    setPort(next.port ? String(next.port) : '');
    setSecurity(next.configured ? next.security : 'auto');
    setUsername(next.username || '');
    setFromAddress(next.fromAddress || '');
    setFromName(next.fromName || '');
    setAllowInvalidCert(next.allowInvalidCert);
    setTestTo(next.ownerEmail || '');
  }

  async function load() {
    try {
      apply(await jsonResponse<SmtpStatus>(await fetch('/suite-manager/api/settings/smtp'), 'Unable to load the email relay.'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the email relay.');
    }
  }

  useEffect(() => { void load(); }, []);

  function toggleEditing() {
    // Cancelling puts back what is saved, so a half-typed change is not left
    // waiting in the form for the next time it opens.
    if (editing && status) apply(status);
    setPassword('');
    setError('');
    setEditing(!editing);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setResult(null);
    setTestResult('');
    setSaving(true);
    try {
      const saved = await postJson<SmtpSaveResult>('/suite-manager/api/settings/smtp', { allowInvalidCert, fromAddress: fromAddress.trim(), fromName: fromName.trim(), host: host.trim(), password, port: port.trim(), security, username: username.trim() }, 'The email relay could not be saved.');
      apply(saved.status);
      setPassword('');
      setResult(saved.verify);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The email relay could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setError('');
    setTestResult('');
    setBusy('test');
    try {
      const sent = await postJson<{ sentTo: string }>('/suite-manager/api/settings/smtp/test', { to: testTo.trim() }, 'The test message could not be sent.');
      setTestResult(sent.sentTo);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The test message could not be sent.');
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    setError('');
    setResult(null);
    setTestResult('');
    setBusy('remove');
    try {
      apply(await jsonResponse<SmtpStatus>(await fetch('/suite-manager/api/settings/smtp', { method: 'DELETE' }), 'The email relay could not be removed.'));
      setPassword('');
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The email relay could not be removed.');
    } finally {
      setBusy('');
    }
  }

  const busyAny = saving || Boolean(busy);
  const canSave = Boolean(host.trim() && fromAddress.trim() && !busyAny);
  const verified = status?.lastVerify.status === 'verified';
  const relay = status?.configured ? `${status.host}:${status.port} as ${status.fromAddress}` : '';

  return <Panel>
    <PanelHead actions={<EditToggle editing={editing} label={status?.configured ? 'Edit' : 'Set up'} onToggle={toggleEditing} />} heading="h3" title="Email relay">
      <p>Optional. Lets your apps send password resets, notifications and invitations through one mail server. MOS shares it with every app that asks for it and does not use it for itself.</p>
    </PanelHead>
    {status?.configured ? verified
      ? <PanelBand icon="check" note={relay} title="Configured and verified" tone="accent" />
      : <PanelBand icon="mail" note={`${relay}. Not verified since it changed: send a test message to confirm it works.`} title="Configured" tone="info" /> : null}
    {editing || error || result ? <PanelBody>
      {editing ? <form className="suite-settings-form" onSubmit={(event) => void save(event)}>
        <p className="suite-meta">Bring your own mailbox provider, or a service like Fastmail, Mailgun, or your ISP&apos;s SMTP server.</p>
        <fieldset className="suite-settings-fieldset">
          <legend className="suite-field-label">Server</legend>
          <div className="suite-settings-fields suite-settings-fields-narrow">
            <TextInput autoComplete="off" helperText="Hostname or IP, with no scheme or port." label="Relay host" onChange={(event) => setHost(event.target.value)} placeholder="smtp.fastmail.com" value={host} />
            <Select helperText="Leave on Automatic unless your provider tells you otherwise." label="Encryption" onChange={(event) => setSecurity(event.currentTarget.value as SmtpSecurityChoice)} value={security}>
              <option value="auto">Automatic — match my provider&apos;s port (recommended)</option>
              <option value="starttls">STARTTLS (upgrade to encrypted, usually port 587)</option>
              <option value="tls">SSL/TLS (encrypted, usually port 465)</option>
              <option value="none">None (no encryption — local network only)</option>
            </Select>
            <TextInput helperText={security === 'auto' ? 'MOS matches the encryption to it, often 587 or 465.' : `Blank uses the usual port, ${SMTP_DEFAULT_PORTS[security]}.`} inputMode="numeric" label="Port" onChange={(event) => setPort(event.target.value)} placeholder={String(portHint(security))} value={port} />
          </div>
        </fieldset>
        <fieldset className="suite-settings-fieldset">
          <legend className="suite-field-label">Sign-in</legend>
          <div className="suite-settings-fields">
            <TextInput autoComplete="off" helperText="Leave both blank for a relay that needs no login." label="Username" onChange={(event) => setUsername(event.target.value)} placeholder="you@example.com" value={username} />
            <TextInput autoComplete="new-password" helperText={status?.passwordConfigured ? 'A password is saved. Type a new one to replace it.' : 'Stored like any app secret and never shown again.'} label="Password" onChange={(event) => setPassword(event.target.value)} placeholder={status?.passwordConfigured ? 'Saved — leave blank to keep' : ''} type="password" value={password} />
          </div>
        </fieldset>
        <fieldset className="suite-settings-fieldset">
          <legend className="suite-field-label">Sender</legend>
          <div className="suite-settings-fields">
            <TextInput autoComplete="off" helperText="Many relays require this to match the account." label="From address" onChange={(event) => setFromAddress(event.target.value)} placeholder="you@example.com" type="email" value={fromAddress} />
            <TextInput autoComplete="off" helperText="Optional. The name recipients see." label="From name" onChange={(event) => setFromName(event.target.value)} placeholder="My Own Suite" value={fromName} />
          </div>
        </fieldset>
        <Checkbox checked={allowInvalidCert} onChange={(event) => setAllowInvalidCert(event.currentTarget.checked)}>
          Allow an insecure relay: one whose TLS certificate this server does not trust, or — with encryption set to None — sending your login unencrypted. Only for a relay on your own trusted network.
        </Checkbox>
        <div className={`suite-settings-actions${status?.configured ? ' suite-settings-actions-split' : ''}`}>
          {status?.configured ? <button className="mos-btn mos-btn-ghost" disabled={busyAny} onClick={() => void remove()} type="button">{busy === 'remove' ? 'Removing...' : 'Remove relay'}</button> : null}
          <button className="mos-btn mos-btn-primary" disabled={!canSave} type="submit">{saving ? 'Saving and verifying...' : status?.configured ? 'Save changes' : 'Save relay'}</button>
        </div>
      </form> : null}
      {error ? <Notice title="Something went wrong" variant="error"><p>{error}</p></Notice> : null}
      {result && result.status === 'verified' ? <Notice title="Relay saved and verified" variant="success"><p>MOS connected to the relay and its login was accepted. Send a test message to confirm mail is delivered.</p></Notice> : null}
      {result && result.status !== 'verified' ? <Notice title="Relay saved, but it could not be verified" variant="warning">
        <p>{result.reason || 'MOS could not confirm the relay.'} Your settings are saved; apps will use them. Fix the relay and save again, or send a test message once it is reachable.</p>
      </Notice> : null}
    </PanelBody> : null}
    {status?.configured ? <PanelList><PanelItem>
      <div className="suite-settings-form">
        <InputAction
          action={<button className="mos-btn mos-btn-secondary" disabled={busyAny || !testTo.trim()} onClick={() => void sendTest()} type="button">{busy === 'test' ? 'Sending...' : 'Send test'}</button>}
          autoComplete="off"
          helperText="Sends the fixed MOS test message to this address so you can confirm delivery."
          label="Send a test message to"
          onChange={(event) => setTestTo(event.target.value)}
          placeholder={status.ownerEmail || 'you@example.com'}
          type="email"
          value={testTo}
        />
        {testResult ? <Notice title="Test message sent" variant="success"><p>The relay accepted a message to <strong>{testResult}</strong>. If it does not arrive, check the recipient&apos;s spam folder and that the from address is one the relay allows.</p></Notice> : null}
      </div>
    </PanelItem></PanelList> : null}
    {status ? <PanelBody><SmtpDiagnostics status={status} /></PanelBody> : null}
  </Panel>;
}
