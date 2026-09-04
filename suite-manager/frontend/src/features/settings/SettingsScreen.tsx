import { useEffect, useState, type FormEvent } from 'react';

import { AdvancedPanel, Checkbox, Notice, Select, Switch, TextInput, useTechnicalControls } from '../../components/ui';
import { jsonResponse } from '../../lib/api';

type HttpsStatus = {
  acmeEmail: string | null;
  activeHomeUrl: string;
  agentAvailable: boolean;
  baseDomain: string | null;
  bootstrapUrl: string;
  installContext: string;
  lastApply: { at: string | null; diagnostics: string | null; errorCode: string | null; status: string };
  privateHttpsAvailable: boolean;
  provider: string | null;
  serverAddress: string | null;
  tlsMode: string;
  tokenConfigured: boolean;
};

type SecurityEventSummary = {
  byType: Array<{ eventCount: number; eventType: string; lastSeenAt: string | null; subjectCount: number }>;
  eventCount: number;
  lastSeenAt: string | null;
  since: string;
};

type AppReconciliationResult = {
  errorCode?: string;
  homepage?: { errorCode?: string; status?: string };
  homepageEntryFailures?: Array<{ errorCode?: string; packageId: string; status: string }>;
  runtime?: Array<{ errorCode?: string; packageId: string; status: string }>;
  skipped?: boolean;
  status?: string;
};

type ApplyResult = {
  appReconciliation?: AppReconciliationResult;
  appliedAt: string;
  bootstrapUrl: string;
  homeUrl: string;
  status: string;
};


function LocalDnsInstructions({ homeHost, serverAddress }: { homeHost: string; serverAddress: string }) {
  return <>
    <p>MOS can now serve HTTPS at <strong>{homeHost}</strong>, but your devices or local network may still need to learn where that name lives.</p>
    <p>Create a local DNS override that sends this hostname to this server IP:</p>
    <pre className="suite-command-block">{`${serverAddress} ${homeHost}`}</pre>
    <p>The right place to do that depends on your setup: your router, local DNS server, AdGuard Home, Unbound, Pi-hole, or an operating-system hosts file can all be valid options.</p>
  </>;
}

// The one panel on this screen that renders in both contexts: diagnostics when
// an HTTPS apply failed, and ambient detail when it did not. Composing the
// shared panel rather than repeating it keeps the two call sites below —
// provider-managed HTTPS and private LAN HTTPS — showing the same facts.
function HttpsDiagnostics({ status }: { status: HttpsStatus }) {
  return <AdvancedPanel facts={[
    { label: 'Bootstrap recovery URL', value: status.bootstrapUrl },
    { label: 'Active Home URL', value: status.activeHomeUrl },
    { label: 'Install context', value: status.installContext },
    { label: 'Detected server IP', value: status.serverAddress || 'Not detected' },
    { label: 'TLS mode', value: status.tlsMode },
    { label: 'Provider', value: status.provider || 'Not configured' },
    { label: 'Last apply', value: `${status.lastApply.status || 'never'}${status.lastApply.errorCode ? ` (${status.lastApply.errorCode})` : ''}${status.lastApply.at ? ` at ${status.lastApply.at}` : ''}` },
  ]} output={status.lastApply.diagnostics || undefined} reveal={status.lastApply.status === 'failed' ? 'on-failure' : 'technical-mode'} />;
}

function AppReconciliationNotice({ reconciliation }: { reconciliation?: AppReconciliationResult }) {
  if (!reconciliation || reconciliation.skipped || !['failed', 'partial'].includes(String(reconciliation.status || ''))) return null;
  const failedRuntime = (reconciliation.runtime || []).filter((item) => item.status === 'failed');
  const failedEntries = reconciliation.homepageEntryFailures || [];
  const failedPackages = [...new Set([...failedRuntime, ...failedEntries].map((item) => item.packageId))];
  const details = [
    reconciliation.homepage?.status === 'failed' ? `Homepage routes: ${reconciliation.homepage.errorCode || 'failed'}` : '',
    reconciliation.errorCode ? `Reconciliation: ${reconciliation.errorCode}` : '',
    failedPackages.length ? `Apps: ${failedPackages.join(', ')}` : '',
  ].filter(Boolean).join(' | ');

  return <Notice title="HTTPS applied, but app URL reconciliation needs attention" variant="warning">
    <p>Your Home URL was updated. Some app routes or MOS-managed Homepage entries may still need to be reapplied from the Apps or Customize screens.</p>
    {details ? <p className="suite-meta">{details}</p> : null}
  </Notice>;
}

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
function EmailRelayPanel() {
  const [status, setStatus] = useState<SmtpStatus | null>(null);
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

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setResult(null);
    setTestResult('');
    setSaving(true);
    try {
      const saved = await jsonResponse<SmtpSaveResult>(await fetch('/suite-manager/api/settings/smtp', {
        body: JSON.stringify({ allowInvalidCert, fromAddress: fromAddress.trim(), fromName: fromName.trim(), host: host.trim(), password, port: port.trim(), security, username: username.trim() }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'The email relay could not be saved.');
      apply(saved.status);
      setPassword('');
      setResult(saved.verify);
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
      const sent = await jsonResponse<{ sentTo: string }>(await fetch('/suite-manager/api/settings/smtp/test', {
        body: JSON.stringify({ to: testTo.trim() }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'The test message could not be sent.');
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The email relay could not be removed.');
    } finally {
      setBusy('');
    }
  }

  const busyAny = saving || Boolean(busy);
  const canSave = Boolean(host.trim() && fromAddress.trim() && !busyAny);
  const verified = status?.lastVerify.status === 'verified';

  return <div className="mos-panel suite-card suite-settings-panel">
    <div>
      <h2 className="mos-card-title">Email relay</h2>
      <p className="suite-meta">Optional. An SMTP relay that apps you install can send email through — password resets, notifications, invitations. MOS shares one relay with every app that asks for it and does not use it for itself. Bring your own mailbox provider, or a service like Fastmail, Mailgun, or your ISP's SMTP server.</p>
    </div>

    {status?.configured ? <Notice title={verified ? 'Relay configured and verified' : 'Relay configured'} variant={verified ? 'success' : 'info'}>
      <p>Apps send through <strong>{status.host}:{status.port}</strong> as <strong>{status.fromAddress}</strong>. {verified ? 'It last checked out fine.' : 'It has not been verified since it changed — send a test message to confirm it works.'}</p>
    </Notice> : null}

    <form className="suite-settings-form" onSubmit={(event) => void save(event)}>
      <TextInput autoComplete="off" helperText="Hostname or IP of your SMTP server, with no scheme or port." label="Relay host" onChange={(event) => setHost(event.target.value)} placeholder="smtp.fastmail.com" value={host} />
      <Select helperText="Most providers just give you a host, a port and a login. Leave this on Automatic and MOS matches the encryption to the port. Only change it if your provider tells you to." label="Encryption" onChange={(event) => setSecurity(event.currentTarget.value as SmtpSecurityChoice)} value={security}>
        <option value="auto">Automatic — match my provider&apos;s port (recommended)</option>
        <option value="starttls">STARTTLS (upgrade to encrypted, usually port 587)</option>
        <option value="tls">SSL/TLS (encrypted, usually port 465)</option>
        <option value="none">None (no encryption — local network only)</option>
      </Select>
      <TextInput helperText={security === 'auto' ? 'Enter the port your provider gives you — MOS matches the encryption to it (often 587 or 465).' : `Leave blank to use the usual port for this encryption (${SMTP_DEFAULT_PORTS[security]}).`} inputMode="numeric" label="Port" onChange={(event) => setPort(event.target.value)} placeholder={String(portHint(security))} value={port} />
      <TextInput autoComplete="off" helperText="Leave both blank for a relay that needs no login." label="Username" onChange={(event) => setUsername(event.target.value)} placeholder="you@example.com" value={username} />
      <TextInput autoComplete="new-password" helperText={status?.passwordConfigured ? 'A password is saved. Leave blank to keep it, or type a new one to replace it.' : 'Stored like any app secret and never shown again.'} label="Password" onChange={(event) => setPassword(event.target.value)} placeholder={status?.passwordConfigured ? 'Saved — leave blank to keep' : ''} type="password" value={password} />
      <TextInput autoComplete="off" helperText="The address apps send from. Many relays require this to match the account." label="From address" onChange={(event) => setFromAddress(event.target.value)} placeholder="you@example.com" type="email" value={fromAddress} />
      <TextInput autoComplete="off" helperText="Optional. The display name recipients see." label="From name" onChange={(event) => setFromName(event.target.value)} placeholder="My Own Suite" value={fromName} />
      <Checkbox checked={allowInvalidCert} onChange={(event) => setAllowInvalidCert(event.currentTarget.checked)}>
        Allow an insecure relay: one whose TLS certificate this server does not trust, or — with encryption set to None — sending your login unencrypted. Only for a relay on your own trusted network.
      </Checkbox>

      {error ? <Notice title="Something went wrong" variant="error"><p>{error}</p></Notice> : null}
      {result && result.status === 'verified' ? <Notice title="Relay saved and verified" variant="success"><p>MOS connected to the relay and its login was accepted. Send a test message to confirm mail is delivered.</p></Notice> : null}
      {result && result.status !== 'verified' ? <Notice title="Relay saved, but it could not be verified" variant="warning">
        <p>{result.reason || 'MOS could not confirm the relay.'} Your settings are saved; apps will use them. Fix the relay and save again, or send a test message once it is reachable.</p>
      </Notice> : null}

      <div className="suite-updates-track">
        <button className="mos-btn mos-btn-primary" disabled={!canSave} type="submit">{saving ? 'Saving and verifying...' : status?.configured ? 'Save changes' : 'Save relay'}</button>
        {status?.configured ? <button className="mos-btn mos-btn-secondary" disabled={busyAny} onClick={() => void remove()} type="button">{busy === 'remove' ? 'Removing...' : 'Remove relay'}</button> : null}
      </div>
    </form>

    {status?.configured ? <div className="suite-settings-form">
      <TextInput autoComplete="off" helperText="Sends the fixed MOS test message to this address so you can confirm delivery." label="Send a test message to" onChange={(event) => setTestTo(event.target.value)} placeholder={status.ownerEmail || 'you@example.com'} type="email" value={testTo} />
      {testResult ? <Notice title="Test message sent" variant="success"><p>The relay accepted a message to <strong>{testResult}</strong>. If it does not arrive, check the recipient's spam folder and that the from address is one the relay allows.</p></Notice> : null}
      <div className="suite-updates-track">
        <button className="mos-btn mos-btn-secondary" disabled={busyAny || !testTo.trim()} onClick={() => void sendTest()} type="button">{busy === 'test' ? 'Sending...' : 'Send test message'}</button>
      </div>
    </div> : null}

    {status ? <SmtpDiagnostics status={status} /> : null}
  </div>;
}

const MIN_PASSWORD_LENGTH = 12;

// Rotating the owner password matters most on the installs where it was created
// over plain HTTP — a local or own-hardware suite that had no certificate yet.
// The first password travelled the LAN in the clear; this is how it stops being
// the password that guards everything.
function OwnerAccountPanel() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit = Boolean(currentPassword && newPassword.length >= MIN_PASSWORD_LENGTH && newPassword === confirmPassword && !saving);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setChanged(false);
    if (!canSubmit) return;
    setSaving(true);
    try {
      await jsonResponse(await fetch('/suite-manager/api/settings/owner/password', {
        body: JSON.stringify({ currentPassword, newPassword }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Your password could not be changed.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setChanged(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your password could not be changed.');
    } finally {
      setSaving(false);
    }
  }

  return <div className="mos-panel suite-card suite-settings-panel">
    <div><h2 className="mos-card-title">Owner password</h2><p className="suite-meta">Change the password for the account that controls Suite Manager and every app you install.</p></div>
    <form className="suite-settings-form" onSubmit={(event) => void submit(event)}>
      <TextInput autoComplete="current-password" label="Current password" onChange={(event) => { setCurrentPassword(event.target.value); setError(''); setChanged(false); }} type="password" value={currentPassword} />
      <TextInput autoComplete="new-password" helperText={tooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : `At least ${MIN_PASSWORD_LENGTH} characters.`} label="New password" minLength={MIN_PASSWORD_LENGTH} onChange={(event) => { setNewPassword(event.target.value); setError(''); setChanged(false); }} type="password" value={newPassword} />
      <TextInput autoComplete="new-password" helperText={mismatch ? "Those passwords don't match." : 'Retype it to catch typos.'} label="Confirm new password" minLength={MIN_PASSWORD_LENGTH} onChange={(event) => { setConfirmPassword(event.target.value); setError(''); setChanged(false); }} type="password" value={confirmPassword} />
      {error ? <Notice title="Your password was not changed" variant="error"><p>{error}</p></Notice> : null}
      {changed ? <Notice title="Password changed" variant="success"><p>Your new password is active. Every other signed-in browser was signed out; this one stays signed in.</p></Notice> : null}
      <button className="mos-btn mos-btn-primary" disabled={!canSubmit} type="submit">{saving ? 'Changing password...' : 'Change password'}</button>
    </form>
  </div>;
}

// The one place the technical-controls preference is written, and the only way
// an owner discovers the mode exists — nothing hints at it from the app pages,
// because a standing hint on every screen is the clutter this preference
// removes. The hook rather than a panel here because the control *is* the
// preference; it obviously cannot gate itself on being enabled.
function TechnicalControlsPanel() {
  const { enabled, setEnabled } = useTechnicalControls();
  const [error, setError] = useState('');

  return <div className="mos-panel suite-card suite-settings-panel">
    <div>
      <h2 className="mos-card-title">Technical controls</h2>
      <p className="suite-meta">Everything MOS does works the same either way; this only changes what you can see. You can turn it off again at any time without losing anything.</p>
    </div>
    <Switch
      checked={enabled}
      description="Adds panels showing what MOS generated for your apps and system — package details, addresses, configuration and raw logs — plus manual overrides."
      label="Show technical controls"
      onChange={(event) => {
        setError('');
        void setEnabled(event.currentTarget.checked).catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : 'Your preference could not be saved.');
        });
      }}
    />
    {error ? <Notice title="Your preference was not saved" variant="error"><p>{error}</p></Notice> : null}
  </div>;
}

const securityEventLabels: Record<string, { description: string; label: string }> = {
  'app-catalog-refresh-failed': { description: 'MOS could not refresh the verified app catalog.', label: 'Catalog refresh failures' },
  'app-catalog-signature-invalid': { description: 'Catalog data was refused because its publisher signature was missing or invalid.', label: 'Invalid catalog signatures' },
  'app-source-candidate-rejected': { description: 'An external package candidate failed MOS safety or validation checks.', label: 'Rejected external packages' },
  'app-source-download-throttled': { description: 'An external package source exceeded its bounded download rate.', label: 'Throttled package sources' },
  'login-throttled': { description: 'Repeated failed sign-in attempts were temporarily slowed down.', label: 'Throttled sign-in attempts' },
};

function SecurityActivity({ error, summary }: { error: string; summary: SecurityEventSummary | null }) {
  return <div className="mos-panel suite-card suite-settings-panel">
    <div><h2 className="mos-card-title">Recent security activity</h2><p className="suite-meta">Bounded security signals recorded during the last 30 days. Counts identify patterns without showing IP addresses, repository URLs, or internal subject identifiers.</p></div>
    {error ? <Notice title="Security activity unavailable" variant="warning"><p>{error}</p></Notice> : null}
    {!error && !summary ? <p className="suite-meta">Loading security activity...</p> : null}
    {summary && summary.eventCount === 0 ? <Notice title="No recorded security events" variant="success"><p>MOS has not recorded any of the monitored events during this period.</p></Notice> : null}
    {summary && summary.eventCount > 0 ? <Notice title={`${summary.eventCount} security event${summary.eventCount === 1 ? '' : 's'} recorded`} variant="warning">
      <p>Review repeated or recent entries. These signals mean MOS slowed or refused an action; they do not by themselves prove that the server was compromised.</p>
      <dl>{summary.byType.map((event) => {
        const copy = securityEventLabels[event.eventType] || { description: 'MOS recorded a security-relevant refusal.', label: event.eventType };
        return <div key={event.eventType}><dt>{copy.label}</dt><dd>{event.eventCount} event{event.eventCount === 1 ? '' : 's'} across {event.subjectCount} subject{event.subjectCount === 1 ? '' : 's'}; last seen {event.lastSeenAt ? new Date(event.lastSeenAt).toLocaleString() : 'unknown'}. {copy.description}</dd></div>;
      })}</dl>
    </Notice> : null}
  </div>;
}

// Deliberately not behind Technical controls, and the one place in Suite Manager
// where that is the whole point. This exists for an owner who cannot describe
// what is wrong, which is exactly the owner who will never have found a
// technical toggle — gating it would hide the feature from its only user.
// Nothing here is technical to look at: one sentence, one button, one file.
//
// The copy names all three readers on purpose. An owner who can debug their own
// server is as likely to press this as one who cannot, and wording that assumed
// somebody was being asked for help read as strange to everyone else.
function GetHelpPanel() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState('');

  async function create() {
    setCreating(true);
    setError('');
    setCreated('');
    try {
      const response = await fetch('/suite-manager/api/support/bundle');
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || 'The diagnostics file could not be created.');
      }
      const disposition = response.headers.get('Content-Disposition') || '';
      const filename = /filename="([^"]+)"/u.exec(disposition)?.[1] || 'mos-diagnostics.txt';
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = filename;
      link.href = href;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      setCreated(filename);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The diagnostics file could not be created.');
    } finally {
      setCreating(false);
    }
  }

  return <div className="mos-panel suite-card suite-settings-panel">
    <div>
      <h2 className="mos-card-title">When something is not working</h2>
      <p className="suite-meta">MOS can gather what it knows about the problem into one file: what is running, what failed recently, and why. Read it yourself, send it to someone helping you, or give it to an AI assistant. Passwords and app secrets are removed before the file is written.</p>
    </div>
    {error ? <Notice title="The file could not be created" variant="error"><p>{error}</p></Notice> : null}
    {created ? <Notice title="Saved to your downloads" variant="success"><p><strong>{created}</strong> is plain text, so you can open and read it yourself, pass it on, or paste it somewhere that can help.</p></Notice> : null}
    <button className="mos-btn mos-btn-primary" disabled={creating} onClick={() => void create()} type="button">{creating ? 'Collecting...' : 'Create diagnostics file'}</button>
  </div>;
}

export function SettingsScreen() {
  const [status, setStatus] = useState<HttpsStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [baseDomain, setBaseDomain] = useState('');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [token, setToken] = useState('');
  const [formError, setFormError] = useState('');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [securitySummary, setSecuritySummary] = useState<SecurityEventSummary | null>(null);
  const [securityError, setSecurityError] = useState('');

  async function load(): Promise<HttpsStatus | null> {
    try {
      const next = await jsonResponse<HttpsStatus>(await fetch('/suite-manager/api/settings/https'), 'Unable to load HTTPS settings.');
      setStatus(next);
      setBaseDomain(next.baseDomain || '');
      setAcmeEmail(next.acmeEmail || '');
      setLoadError('');
      return next;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load HTTPS settings.');
      return null;
    }
  }

  async function loadAfterRestart(): Promise<HttpsStatus | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const next = await load();
      if (next) return next;
    }
    return null;
  }

  useEffect(() => {
    void load();
    void fetch('/suite-manager/api/settings/security-events')
      .then((response) => jsonResponse<SecurityEventSummary>(response, 'Unable to load recent security activity.'))
      .then((summary) => { setSecuritySummary(summary); setSecurityError(''); })
      .catch((error) => setSecurityError(error instanceof Error ? error.message : 'Unable to load recent security activity.'));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    setResult(null);
    const normalizedDomain = baseDomain.trim().toLowerCase().replace(/\.$/u, '');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(normalizedDomain)) {
      setFormError('Enter a valid Cloudflare-managed base domain.'); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(acmeEmail.trim())) {
      setFormError('Enter a valid ACME contact email address.'); return;
    }
    if (!/^[A-Za-z0-9_-]{20,4096}$/u.test(token.trim())) {
      setFormError('A valid Cloudflare API token is required.'); return;
    }
    if (!status?.agentAvailable) {
      setFormError('The HTTPS system agent is unavailable. Update or repair the MOS control plane, then try again.'); return;
    }

    const submittedToken = token.trim();
    setToken('');
    setApplying(true);
    try {
      const applied = await jsonResponse<ApplyResult>(await fetch('/suite-manager/api/settings/https/apply', {
        body: JSON.stringify({ acmeEmail: acmeEmail.trim(), baseDomain: normalizedDomain, cloudflareApiToken: submittedToken }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'HTTPS could not be applied.');
      setResult(applied);
      await load();
    } catch (error) {
      const recovered = await loadAfterRestart();
      if (recovered?.lastApply.status === 'applied' && recovered.baseDomain === normalizedDomain) {
        setResult({
          appliedAt: recovered.lastApply.at || new Date().toISOString(),
          bootstrapUrl: recovered.bootstrapUrl,
          homeUrl: recovered.activeHomeUrl,
          status: 'applied',
        });
        return;
      }
      setFormError(error instanceof Error ? error.message : 'HTTPS could not be applied.');
    } finally {
      setApplying(false);
    }
  }

  const activeHomeHost = status?.baseDomain ? `home.${status.baseDomain}` : '';
  const dnsAddress = status?.serverAddress || '<server-ip>';
  const canApplyHttps = Boolean(
    status?.agentAvailable &&
    baseDomain.trim() &&
    acmeEmail.trim() &&
    token.trim() &&
    !applying,
  );

  return <section className="mos-shell mos-page">
    <div className="suite-hero"><h1>Settings</h1><p className="suite-lead mos-body-lg">Manage how this MOS Home is reached from your browser, and the owner account that controls it.</p></div>
    <GetHelpPanel />
    {loadError ? <Notice title="Settings unavailable" variant="error"><p>{loadError}</p></Notice> : null}
    {status ? !status.privateHttpsAvailable ? <div className="mos-panel suite-card suite-settings-panel">
      <div><h2 className="mos-card-title">Custom domains are handled by your provider</h2><p className="suite-meta">This install looks like it is hosted on an external provider. MOS does not manage public DNS, provider routing, or public TLS from here.</p></div>
      <Notice title="Use your provider guide" variant="info"><p>To use a real domain with this cloud install, follow your hosting provider's custom-domain and HTTPS instructions, then point that domain at the provider endpoint or server they give you.</p></Notice>
      <HttpsDiagnostics status={status} />
    </div> : <div className="mos-panel suite-card suite-settings-panel">
      <div><h2 className="mos-card-title">Private LAN HTTPS with Cloudflare DNS</h2><p className="suite-meta">Use DNS-01 to get a trusted certificate for private local access to <strong>home.&lt;your-domain&gt;</strong>. This does not publish MOS to the internet or configure public access.</p></div>
      {!status.agentAvailable ? <Notice title="HTTPS agent unavailable" variant="warning"><p>You can review and validate the form, but applying requires the installed MOS HTTPS agent and Cloudflare-capable Caddy build.</p></Notice> : null}
      <form className="suite-settings-form" onSubmit={(event) => void submit(event)}>
        <TextInput autoComplete="url" helperText="Example: mos.example.com. Your Home URL becomes home.mos.example.com." label="MOS base domain" onChange={(event) => setBaseDomain(event.target.value)} placeholder="mos.example.com" value={baseDomain} />
        <TextInput autoComplete="email" helperText="Used by the ACME certificate authority for account notices." label="ACME contact email" onChange={(event) => setAcmeEmail(event.target.value)} placeholder="you@example.com" type="email" value={acmeEmail} />
        <TextInput autoComplete="off" helperText="Requires Zone Read and DNS Edit for the relevant Cloudflare zone. The saved token is never returned." label="Cloudflare API token" onChange={(event) => setToken(event.target.value)} placeholder={status.tokenConfigured ? 'Paste a replacement token to reapply' : 'Paste token once'} type="password" value={token} />
        {formError ? <Notice title="HTTPS was not applied" variant="error"><p>{formError}</p></Notice> : null}
        {result ? <Notice title="HTTPS configuration applied" variant="success"><p>Your new Home URL is <a href={result.homeUrl}>{result.homeUrl}</a>.</p><LocalDnsInstructions homeHost={activeHomeHost} serverAddress={dnsAddress} /><a className="mos-btn mos-btn-primary" href={result.homeUrl}>Open HTTPS Home</a></Notice> : null}
        {result ? <AppReconciliationNotice reconciliation={result.appReconciliation} /> : null}
        <button className="mos-btn mos-btn-primary" disabled={!canApplyHttps} type="submit">{applying ? 'Applying securely...' : 'Apply HTTPS settings'}</button>
      </form>
      {!result && status.lastApply.status === 'applied' && activeHomeHost ? <Notice title="HTTPS is configured" variant="success"><p>Active Home URL: <a href={status.activeHomeUrl}>{status.activeHomeUrl}</a>.</p><LocalDnsInstructions homeHost={activeHomeHost} serverAddress={dnsAddress} /></Notice> : null}
      <HttpsDiagnostics status={status} />
    </div> : <p className="suite-meta">Loading HTTPS settings...</p>}
    <EmailRelayPanel />
    <TechnicalControlsPanel />
    <OwnerAccountPanel />
    <SecurityActivity error={securityError} summary={securitySummary} />
  </section>;
}
