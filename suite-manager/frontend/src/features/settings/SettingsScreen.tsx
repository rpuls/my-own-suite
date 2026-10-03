import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { AdvancedPanel, Checkbox, Dialog, Icon, InputAction, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList, Select, Switch, TextInput, useTechnicalControls, type IconName } from '../../components/ui';
import { AppSourcesPanel } from './AppSourcesPanel';
import { jsonResponse } from '../../lib/api';
import { readVaultView, type VaultView } from '../../lib/vault';

// The suite's one recorded address: where apps and Homepage are published.
type SuiteAddress = {
  acmeEmail?: string | null;
  baseDomain?: string | null;
  host: string;
  kind: 'domain' | 'easy-door' | 'lan-name';
  // Whether the name points at this machine right now; null when DNS could not
  // be asked, or for a door, which needs no DNS.
  resolvesHere: boolean | null;
  scheme: 'http' | 'https';
  url: string;
};

type AddressChange = {
  at: string | null;
  diagnostics: string | null;
  errorCode: string | null;
  result: AppReconciliationResult | null;
  stage: string | null;
  stages: string[];
  status: 'applied' | 'applying' | 'failed' | 'never';
  target: { host: string; kind: string; scheme: string } | null;
};

type AddressStatus = {
  address: SuiteAddress;
  agentAvailable: boolean;
  bootstrapUrl: string;
  // The recorded Easy Door name no longer matches the live one: the machine's
  // address moved under it.
  drifted: { from: string; to: string } | null;
  easyDoorUrl: string | null;
  installContext: string;
  lastChange: AddressChange;
  // The domain a restored backup was set up for, waiting to be served here.
  offered: { acmeEmail: string | null; baseDomain: string } | null;
  privateHttpsAvailable: boolean;
  serverAddress: string | null;
};

const CHANGE_STAGE_SENTENCES: Record<string, string> = {
  apps: 'Rebuilding your apps and Homepage on the new address.',
  caddy: 'Configuring the web server and waiting for the certificate. This can take a minute or two.',
  recorded: 'Recording the new address.',
};

const ADDRESS_KIND_SENTENCES: Record<SuiteAddress['kind'], string> = {
  domain: 'Your own domain, with a trusted certificate.',
  'easy-door': 'The Easy Door: the name MOS answers on with nothing configured on your network.',
  'lan-name': 'The name this server was installed with. Your network has to know where it lives.',
};

// Where a poll of the address status ended. Signed out and refused are answers;
// unreachable is the web server restarting under this connection.
type Contact = 'ok' | 'refused' | 'signed-out' | 'unreachable';

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

type GroupId = 'advanced' | 'apps' | 'help' | 'security' | 'suite';
type SettingId = 'activity' | 'address' | 'diagnostics' | 'email' | 'encryption' | 'password' | 'sources' | 'technical';

const GROUPS: Array<{ description: string; id: GroupId; title: string }> = [
  { description: 'Where your suite lives and how it talks to the outside world.', id: 'suite', title: 'Your suite' },
  { description: 'Who controls this suite and how it protects your data.', id: 'security', title: 'Account & security' },
  { description: 'Where your apps come from.', id: 'apps', title: 'Apps' },
  { description: 'Extra detail for people who want to see under the hood.', id: 'advanced', title: 'Advanced' },
  { description: 'For when something is not working.', id: 'help', title: 'Help' },
];

// The one index of this page: it drives the sidebar, the search and the order of
// the cards, so a new setting is one entry here and one card in SETTING_CARDS.
const SETTINGS: Array<{ group: GroupId; icon: IconName; id: SettingId; keywords: string; title: string }> = [
  { group: 'suite', icon: 'globe', id: 'address', keywords: 'domain certificate https url cloudflare acme dns token home where lives move easy door', title: 'Suite address' },
  { group: 'suite', icon: 'mail', id: 'email', keywords: 'smtp mail email relay host port username password from sender test notifications', title: 'Email relay' },
  { group: 'security', icon: 'key', id: 'password', keywords: 'password owner account login change sign in', title: 'Owner password' },
  { group: 'security', icon: 'lock', id: 'encryption', keywords: 'disk encryption boot startup password recovery key tpm chip theft stolen', title: 'Disk encryption' },
  { group: 'security', icon: 'shield', id: 'activity', keywords: 'security events activity log refused throttled audit', title: 'Security activity' },
  { group: 'apps', icon: 'apps', id: 'sources', keywords: 'app sources catalog repository github refresh revisions extra', title: 'App sources' },
  { group: 'advanced', icon: 'settings', id: 'technical', keywords: 'technical controls advanced logs config developer overrides expert', title: 'Technical controls' },
  { group: 'help', icon: 'download', id: 'diagnostics', keywords: 'diagnostics help support troubleshoot problem broken not working logs ai', title: 'Diagnostics file' },
];

// Every whitespace-separated term has to appear somewhere in the setting.
function matchesQuery(setting: typeof SETTINGS[number], query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const groupTitle = GROUPS.find((group) => group.id === setting.group)?.title || '';
  const haystack = `${setting.title} ${groupTitle} ${setting.keywords}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function EditToggle({ editing, label, onToggle }: { editing: boolean; label: string; onToggle: () => void }) {
  return <button aria-expanded={editing} className={`mos-btn ${editing ? 'mos-btn-ghost' : 'mos-btn-secondary'}`} onClick={onToggle} type="button">{editing ? 'Cancel' : label}</button>;
}

function LocalDnsInstructions({ homeHost, serverAddress }: { homeHost: string; serverAddress: string }) {
  return <>
    <p>MOS serves HTTPS at <strong>{homeHost}</strong>, but your devices or local network still have to learn where that name lives.</p>
    <p>Create a local DNS override that sends this hostname to this server IP:</p>
    <pre className="suite-command-block">{`${serverAddress} ${homeHost}`}</pre>
    <p>The right place to do that depends on your setup: your router, local DNS server, AdGuard Home, Unbound, Pi-hole, or an operating-system hosts file can all be valid options.</p>
  </>;
}

// The one panel on this screen that renders in both contexts: diagnostics when
// a change of address failed, and ambient detail when it did not.
function AddressDiagnostics({ status }: { status: AddressStatus }) {
  const change = status.lastChange;
  return <AdvancedPanel facts={[
    { label: 'Recorded address', value: `${status.address.url} (${status.address.kind})` },
    { label: 'Install-time URL', value: status.bootstrapUrl },
    { label: 'Easy Door URL', value: status.easyDoorUrl || 'None: this server is not on a private network' },
    { label: 'Name points here', value: status.address.resolvesHere === null ? 'Not checked' : status.address.resolvesHere ? 'Yes' : 'No' },
    { label: 'Install context', value: status.installContext },
    { label: 'Detected server IP', value: status.serverAddress || 'Not detected' },
    { label: 'Last change', value: `${change.status}${change.target ? ` to ${change.target.host}` : ''}${change.stage ? ` (${change.stage})` : ''}${change.errorCode ? ` (${change.errorCode})` : ''}${change.at ? ` at ${change.at}` : ''}` },
  ]} output={change.diagnostics || undefined} reveal={change.status === 'failed' ? 'on-failure' : 'technical-mode'} />;
}

function AppReconciliationNotice({ reconciliation }: { reconciliation?: AppReconciliationResult | null }) {
  if (!reconciliation || reconciliation.skipped || !['failed', 'partial'].includes(String(reconciliation.status || ''))) return null;
  const failedRuntime = (reconciliation.runtime || []).filter((item) => item.status === 'failed');
  const failedEntries = reconciliation.homepageEntryFailures || [];
  const failedPackages = [...new Set([...failedRuntime, ...failedEntries].map((item) => item.packageId))];
  const details = [
    reconciliation.homepage?.status === 'failed' ? `Homepage routes: ${reconciliation.homepage.errorCode || 'failed'}` : '',
    reconciliation.errorCode ? `Reconciliation: ${reconciliation.errorCode}` : '',
    failedPackages.length ? `Apps: ${failedPackages.join(', ')}` : '',
  ].filter(Boolean).join(' | ');

  return <Notice title="The address changed, but some apps did not follow it" variant="warning">
    <p>Your suite is on its new address. The apps named below could not be rebuilt on it; open them under Apps and apply their runtime again.</p>
    {details ? <p className="suite-meta">{details}</p> : null}
  </Notice>;
}

const ADDRESS_INTRO = 'Where every app and your Homepage are published. MOS itself also keeps answering on the Easy Door and the name it was installed with, so you can always get back here.';

function SuiteAddressPanel() {
  const [status, setStatus] = useState<AddressStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [contact, setContact] = useState<Contact>('ok');
  const [editing, setEditing] = useState(false);
  const [baseDomain, setBaseDomain] = useState('');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [token, setToken] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState<'' | 'change' | 'dismiss'>('');
  // The change this screen started, so its outcome is shown once and the
  // history of an earlier one is not mistaken for it.
  const [startedAt, setStartedAt] = useState<string | null>(null);

  // One read of the address status, and the screen is told where it ended:
  // signed out, refused at this address, unreachable, or answered. A domain
  // change restarts the web server under this connection, so a poll that fails
  // is expected for a while and is never rendered as anything it did not see.
  async function load(): Promise<AddressStatus | null> {
    let response: Response;
    try {
      response = await fetch('/suite-manager/api/settings/address', { cache: 'no-store' });
    } catch {
      setContact('unreachable');
      return null;
    }
    if (response.status === 401) { setContact('signed-out'); return null; }
    if (response.status === 421) { setContact('refused'); return null; }
    if (!response.ok) {
      setContact('unreachable');
      if (!status) setLoadError((await response.json().catch(() => ({}))).error || 'Unable to load the suite address.');
      return null;
    }
    const next = await jsonResponse<AddressStatus>(response, 'Unable to load the suite address.');
    setContact('ok');
    setLoadError('');
    setStatus(next);
    return next;
  }

  useEffect(() => {
    void load().then((next) => {
      if (!next) return;
      setBaseDomain(next.address.baseDomain || next.offered?.baseDomain || '');
      setAcmeEmail(next.address.acmeEmail || next.offered?.acmeEmail || '');
    });
  }, []);

  const applying = status?.lastChange.status === 'applying';
  // While a change runs the screen polls, through whatever the web server
  // answers on, until the change has an outcome.
  useEffect(() => {
    if (!applying && contact !== 'unreachable') return undefined;
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [applying, contact]);

  // Every way of moving the suite is the same request with a different body,
  // and every one of them is answered before it finishes.
  async function startChange(body: Record<string, unknown>) {
    setFormError('');
    setBusy('change');
    try {
      const started = await jsonResponse<{ startedAt: string }>(await fetch('/suite-manager/api/settings/address/change', {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'The address could not be changed.');
      setStartedAt(started.startedAt);
      setEditing(false);
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'The address could not be changed.');
    } finally {
      setBusy('');
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
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
    await startChange({ acmeEmail: acmeEmail.trim(), baseDomain: normalizedDomain, cloudflareApiToken: submittedToken, kind: 'domain' });
  }

  // The offered domain is served with the credential the restore kept for it,
  // so this needs no token. An offer that came without a contact address takes
  // the one in the form.
  async function useOffered() {
    if (!status?.offered) return;
    const email = (status.offered.acmeEmail || acmeEmail).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) { setFormError('Enter a valid ACME contact email address for the offered domain.'); return; }
    await startChange({ acmeEmail: email, kind: 'domain', useOffered: true });
  }

  async function dismissOffer() {
    setFormError('');
    setBusy('dismiss');
    try {
      await jsonResponse(await fetch('/suite-manager/api/settings/address/offer/dismiss', { method: 'POST' }), 'The offer could not be dismissed.');
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'The offer could not be dismissed.');
    } finally {
      setBusy('');
    }
  }

  const address = status?.address;
  const change = status?.lastChange;
  const dnsAddress = status?.serverAddress || '<server-ip>';
  // The outcome of the change this screen started, shown until the next one.
  const outcome = change && startedAt && change.at && change.at >= startedAt && change.status !== 'applying' ? change : null;
  const canApplyHttps = Boolean(status?.agentAvailable && baseDomain.trim() && acmeEmail.trim() && token.trim() && !busy && !applying);

  const contactNotices = <>
    {contact === 'signed-out' ? <Notice title="Your session ended" variant="warning"><p>Sign in again to see where the address change ended up.</p><a className="mos-btn mos-btn-primary" href="/suite-manager/">Sign in</a></Notice> : null}
    {contact === 'refused' && change?.target ? <Notice title="This address no longer answers for Settings" variant="info"><p>MOS is running, and the suite has moved. Continue at <a href={`${change.target.scheme}://${change.target.host}/suite-manager/settings`}>{`${change.target.scheme}://${change.target.host}/`}</a>.</p></Notice> : null}
  </>;

  if (!status || !address || !change) {
    return <Panel>
      <PanelHead heading="h3" title="Suite address"><p>{ADDRESS_INTRO}</p></PanelHead>
      <PanelBody>
        {loadError ? <Notice title="The suite address could not be loaded" variant="error"><p>{loadError}</p></Notice> : null}
        {contactNotices}
        {contact === 'ok' && !loadError ? <p className="suite-meta">Loading the suite address...</p> : null}
      </PanelBody>
    </Panel>;
  }

  if (!status.privateHttpsAvailable) {
    return <Panel>
      <PanelHead heading="h3" title="Suite address"><p>This install looks like it is hosted on an external provider. MOS does not manage public DNS, provider routing, or public TLS from here.</p></PanelHead>
      <PanelBand icon="globe" note="Custom domains are handled by your provider." title={address.url} />
      <PanelBody>
        <Notice title="Use your provider guide" variant="info"><p>To use a real domain with this cloud install, follow your hosting provider&apos;s custom-domain and HTTPS instructions, then point that domain at the provider endpoint or server they give you.</p></Notice>
        <AddressDiagnostics status={status} />
      </PanelBody>
    </Panel>;
  }

  const notices = [
    outcome?.status === 'applied' ? <Notice key="moved" title="Your suite moved" variant="success">
      <p>It is now published at <a href={address.url}>{address.url}</a>.</p>
      {address.kind === 'domain' && address.resolvesHere !== true ? <LocalDnsInstructions homeHost={address.host} serverAddress={dnsAddress} /> : null}
      <a className="mos-btn mos-btn-primary" href={address.url}>Open {address.host}</a>
    </Notice> : null,
    outcome?.status === 'applied' ? <AppReconciliationNotice key="reconciliation" reconciliation={outcome.result} /> : null,
    outcome?.status === 'failed' ? <Notice key="failed" title="The address was not changed" variant="error"><p>Your suite is still at <a href={address.url}>{address.url}</a>. The reason is in the details below.</p></Notice> : null,
    !outcome && !applying && address.kind === 'domain' && address.resolvesHere === false ? <Notice key="dns" title={`${address.host} does not point at this server`} variant="warning"><LocalDnsInstructions homeHost={address.host} serverAddress={dnsAddress} /></Notice> : null,
    status.drifted && !applying ? <Notice key="drifted" title="This server's address changed" variant="warning">
      <p>Your suite was set up on <strong>{status.drifted.from}</strong>, but this server now answers on <strong>{status.drifted.to}</strong>. Your apps still name the old address until the suite follows. A fixed address for this server on your router prevents this.</p>
      <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={() => void startChange({ kind: 'easy-door' })} type="button">{busy === 'change' ? 'Moving...' : `Move to ${status.drifted.to}`}</button>
    </Notice> : null,
    status.offered && !applying ? <Notice key="offered" title={`This backup was set up for ${status.offered.baseDomain}`} variant="info">
      <p>This machine serves <strong>{address.host}</strong>. Anything set up against <strong>home.{status.offered.baseDomain}</strong> — phone apps, sync clients, browser extensions — keeps failing until that name points here and this server serves it. MOS kept that domain&apos;s credential from the backup, so serving it here needs no token; pointing the name at this server is the part MOS cannot do for you.</p>
      {!status.offered.acmeEmail ? <TextInput autoComplete="email" helperText="The backup did not carry one." label="ACME contact email for the offered domain" onChange={(event) => setAcmeEmail(event.target.value)} type="email" value={acmeEmail} /> : null}
      <p>
        <button className="mos-btn mos-btn-primary" disabled={Boolean(busy) || !status.agentAvailable} onClick={() => void useOffered()} type="button">{busy === 'change' ? 'Moving...' : `Serve ${status.offered.baseDomain} from here`}</button>
        {' '}
        <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => void dismissOffer()} type="button">{busy === 'dismiss' ? 'Dismissing...' : 'Not on this server'}</button>
      </p>
    </Notice> : null,
    // A form error from the drift or offer buttons has no open form to show in.
    formError && !editing ? <Notice key="error" title="The address was not changed" variant="error"><p>{formError}</p></Notice> : null,
  ].filter(Boolean);

  return <Panel>
    <PanelHead
      actions={applying ? null : <EditToggle editing={editing} label={address.kind === 'domain' ? 'Edit' : 'Use your own domain'} onToggle={() => { setEditing(!editing); setFormError(''); }} />}
      heading="h3"
      title="Suite address"
    ><p>{ADDRESS_INTRO}</p></PanelHead>
    {applying
      ? <PanelBand busy note={`${CHANGE_STAGE_SENTENCES[change.stage || ''] || 'Starting.'}${contact === 'unreachable' ? ' The web server is restarting, so this page has no answer for a moment. It keeps asking.' : ''}`} title={`Moving your suite to ${change.target?.host || 'its new address'}`} tone="info" />
      : <PanelBand icon="check" note={ADDRESS_KIND_SENTENCES[address.kind]} title={<a href={address.url}>{address.url}</a>} tone="accent" />}
    {notices.length || editing || contact !== 'ok' ? <PanelBody>
      {contactNotices}
      {notices}
      {editing ? <form className="suite-settings-form" onSubmit={(event) => void submit(event)}>
        <p className="suite-meta">MOS uses Cloudflare DNS-01 to get a trusted certificate for private local access to <strong>home.&lt;your-domain&gt;</strong>. This does not publish MOS to the internet or configure public access. Your apps move to the new address with it.</p>
        {!status.agentAvailable ? <Notice title="HTTPS agent unavailable" variant="warning"><p>You can review and validate the form, but applying requires the installed MOS HTTPS agent and Cloudflare-capable Caddy build.</p></Notice> : null}
        <div className="suite-settings-fields">
          <TextInput autoComplete="url" helperText="Example: mos.example.com. Your Home URL becomes home.mos.example.com." label="Base domain" onChange={(event) => setBaseDomain(event.target.value)} placeholder="mos.example.com" value={baseDomain} />
          <TextInput autoComplete="email" helperText="For account notices from the certificate authority." label="Certificate contact email" onChange={(event) => setAcmeEmail(event.target.value)} placeholder="you@example.com" type="email" value={acmeEmail} />
        </div>
        <TextInput autoComplete="off" helperText="Needs Zone Read and DNS Edit for the relevant Cloudflare zone. Used once, never shown again." label="Cloudflare API token" onChange={(event) => setToken(event.target.value)} placeholder={address.kind === 'domain' ? 'Paste a token to apply again' : 'Paste token once'} type="password" value={token} />
        {formError ? <Notice title="The address was not changed" variant="error"><p>{formError}</p></Notice> : null}
        <div className="suite-settings-actions">
          <button className="mos-btn mos-btn-primary" disabled={!canApplyHttps} type="submit">Move my suite to this domain</button>
        </div>
      </form> : null}
    </PanelBody> : null}
    <PanelBody><AddressDiagnostics status={status} /></PanelBody>
  </Panel>;
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
      const saved = await jsonResponse<SmtpSaveResult>(await fetch('/suite-manager/api/settings/smtp', {
        body: JSON.stringify({ allowInvalidCert, fromAddress: fromAddress.trim(), fromName: fromName.trim(), host: host.trim(), password, port: port.trim(), security, username: username.trim() }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'The email relay could not be saved.');
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

const MIN_PASSWORD_LENGTH = 12;

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
      await jsonResponse(await fetch('/suite-manager/api/settings/vault/startup-password', {
        body: JSON.stringify({ enabled: enabling, password }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'How this server starts could not be changed.');
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
function EncryptionPanel() {
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

// Rotating the owner password matters most on the installs where it was created
// over plain HTTP — a local or own-hardware suite that had no certificate yet.
// The first password travelled the LAN in the clear; this is how it stops being
// the password that guards everything.
function OwnerAccountPanel() {
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
      const result = await jsonResponse<{ startupProtection?: { ok: boolean; reason?: string | null } | null }>(await fetch('/suite-manager/api/settings/owner/password', {
        body: JSON.stringify({ currentPassword, newPassword }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Your password could not be changed.');
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

// The one place the technical-controls preference is written, and the only way
// an owner discovers the mode exists — nothing hints at it from the app pages,
// because a standing hint on every screen is the clutter this preference
// removes. The hook rather than a panel here because the control *is* the
// preference; it obviously cannot gate itself on being enabled.
function TechnicalControlsPanel() {
  const { enabled, setEnabled } = useTechnicalControls();
  const [error, setError] = useState('');

  return <Panel>
    <PanelHead heading="h3" title="Technical controls">
      <p>Everything MOS does works the same either way; this only changes what you can see. You can turn it off again at any time without losing anything.</p>
    </PanelHead>
    <PanelList><PanelItem>
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
    </PanelItem></PanelList>
    {error ? <PanelBody><Notice title="Your preference was not saved" variant="error"><p>{error}</p></Notice></PanelBody> : null}
  </Panel>;
}

const securityEventLabels: Record<string, { description: string; label: string }> = {
  'app-catalog-signature-invalid': { description: 'Catalog data was refused because its publisher signature was missing or invalid.', label: 'Invalid catalog signatures' },
  'app-source-candidate-rejected': { description: 'An external package candidate failed MOS safety or validation checks.', label: 'Rejected external packages' },
  'app-source-download-throttled': { description: 'An external package source exceeded its bounded download rate.', label: 'Throttled package sources' },
  'login-throttled': { description: 'Repeated failed sign-in attempts were temporarily slowed down.', label: 'Throttled sign-in attempts' },
};

function SecurityActivityPanel() {
  const [summary, setSummary] = useState<SecurityEventSummary | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void fetch('/suite-manager/api/settings/security-events')
      .then((response) => jsonResponse<SecurityEventSummary>(response, 'Unable to load recent security activity.'))
      .then((next) => { setSummary(next); setError(''); })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load recent security activity.'));
  }, []);

  const count = summary?.eventCount ?? 0;

  return <Panel>
    <PanelHead actions={count > 0 ? <EditToggle editing={open} label="View" onToggle={() => setOpen(!open)} /> : null} heading="h3" title="Security activity">
      <p>Times MOS slowed or refused an action in the last 30 days. Counts show patterns without IP addresses, repository URLs, or internal subject identifiers.</p>
    </PanelHead>
    {error ? <PanelBand icon="shield" note={error} title="Security activity unavailable" tone="warning" />
      : !summary ? <PanelBand busy title="Loading security activity" />
        : count === 0 ? <PanelBand icon="check" note="MOS has not recorded any of the monitored events during this period." title="No recorded security events" tone="accent" />
          : <PanelBand icon="shield" note="These mean MOS slowed or refused an action. They do not by themselves prove the server was compromised." title={`${count} security event${count === 1 ? '' : 's'} recorded`} tone="warning" />}
    {summary && count > 0 && open ? <PanelList>
      {summary.byType.map((event) => {
        const copy = securityEventLabels[event.eventType] || { description: 'MOS recorded a security-relevant refusal.', label: event.eventType };
        return <PanelItem key={event.eventType}>
          <div className="suite-settings-row">
            <div className="suite-settings-row-main">
              <strong>{copy.label}</strong>
              <span className="suite-meta">{copy.description} Across {event.subjectCount} subject{event.subjectCount === 1 ? '' : 's'}; last seen {event.lastSeenAt ? new Date(event.lastSeenAt).toLocaleString() : 'unknown'}.</span>
            </div>
            <span className="mos-pill" title={`${event.eventCount} event${event.eventCount === 1 ? '' : 's'}`}>{event.eventCount}</span>
          </div>
        </PanelItem>;
      })}
    </PanelList> : null}
  </Panel>;
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
function DiagnosticsPanel() {
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

  return <Panel>
    <PanelHead actions={<button className="mos-btn mos-btn-primary" disabled={creating} onClick={() => void create()} type="button"><Icon name="download" />{creating ? 'Collecting...' : 'Create file'}</button>} heading="h3" title="Diagnostics file">
      <p>One file with what is running, what failed recently, and why. Read it yourself, send it to someone helping you, or give it to an AI assistant. Passwords and app secrets are removed before the file is written.</p>
    </PanelHead>
    {error || created ? <PanelBody>
      {error ? <Notice title="The file could not be created" variant="error"><p>{error}</p></Notice> : null}
      {created ? <Notice title="Saved to your downloads" variant="success"><p><strong>{created}</strong> is plain text, so you can open and read it yourself, pass it on, or paste it somewhere that can help.</p></Notice> : null}
    </PanelBody> : null}
  </Panel>;
}

const SETTING_CARDS: Record<SettingId, () => ReactNode> = {
  activity: () => <SecurityActivityPanel />,
  address: () => <SuiteAddressPanel />,
  diagnostics: () => <DiagnosticsPanel />,
  email: () => <EmailRelayPanel />,
  encryption: () => <EncryptionPanel />,
  password: () => <OwnerAccountPanel />,
  sources: () => <AppSourcesPanel />,
  technical: () => <TechnicalControlsPanel />,
};

// Distance from the top of the viewport at which a card counts as the one being
// read, and the margin a jump leaves above it.
const READING_LINE = 160;

function scrollToAnchor(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// The setting being read: the last visible card whose top has passed the reading
// line, or the last card once the page cannot scroll any further.
function useActiveSetting(visible: SettingId[]) {
  const [active, setActive] = useState<SettingId | null>(visible[0] ?? null);
  const key = visible.join(' ');
  useEffect(() => {
    function update() {
      let current = visible[0] ?? null;
      for (const id of visible) {
        const card = document.getElementById(`set-${id}`);
        if (card && card.getBoundingClientRect().top < READING_LINE) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = visible.at(-1) ?? current;
      setActive(current);
    }
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [key]);
  return [active, setActive] as const;
}

function SettingsSidebar({ active, onClear, onJump, onQuery, query, visible }: {
  active: SettingId | null;
  onClear: () => void;
  onJump: (id: SettingId) => void;
  onQuery: (query: string) => void;
  query: string;
  visible: SettingId[];
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName || '');
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <aside className="suite-settings-aside">
    <div className="suite-settings-search">
      <Icon name="search" />
      <input
        aria-label="Search settings"
        className="suite-input"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onClear(); }}
        placeholder="Search settings"
        ref={searchRef}
        type="search"
        value={query}
      />
      {query ? <button aria-label="Clear search" className="suite-settings-search-clear" onClick={onClear} type="button"><Icon name="x" /></button> : <kbd aria-hidden="true">/</kbd>}
    </div>
    {query.trim() ? <p className="suite-meta suite-settings-found" role="status">{visible.length === 1 ? '1 setting found' : `${visible.length} settings found`}</p> : null}

    <nav aria-label="Settings sections" className="suite-settings-nav">
      {GROUPS.map((group) => {
        const items = SETTINGS.filter((setting) => setting.group === group.id && visible.includes(setting.id));
        if (!items.length) return null;
        return <div className="suite-settings-nav-group" key={group.id}>
          <button className="mos-eyebrow suite-settings-nav-heading" onClick={() => scrollToAnchor(`grp-${group.id}`)} type="button">{group.title}</button>
          {items.map((setting) => <button aria-current={active === setting.id ? 'location' : undefined} className="suite-settings-nav-item" key={setting.id} onClick={() => onJump(setting.id)} type="button">
            <Icon name={setting.icon} />{setting.title}
          </button>)}
        </div>;
      })}
    </nav>

    <div className="suite-settings-aside-help">
      <strong>Something not working?</strong>
      <p className="suite-meta">Gather what MOS knows into one file you can share.</p>
      <a className="mos-link suite-settings-link" href="#set-diagnostics" onClick={(event) => { event.preventDefault(); onClear(); onJump('diagnostics'); }}>Create diagnostics file<Icon name="arrow-right" /></a>
    </div>
  </aside>;
}

export function SettingsScreen() {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => SETTINGS.filter((setting) => matchesQuery(setting, query)).map((setting) => setting.id), [query]);
  const [active, setActive] = useActiveSetting(visible);

  function jump(id: SettingId) {
    setActive(id);
    // A cleared search re-shows the target in the same render, so wait for it.
    window.requestAnimationFrame(() => scrollToAnchor(`set-${id}`));
  }

  return <section className="mos-shell mos-page mos-page-wider">
    <div className="suite-settings-layout">
      <SettingsSidebar
        active={active}
        onClear={() => setQuery('')}
        onJump={jump}
        onQuery={(next) => { setQuery(next); window.scrollTo({ top: 0 }); }}
        query={query}
        visible={visible}
      />

      <div className="suite-settings-main">
        <div className="suite-hero"><h1>Settings</h1><p className="suite-lead mos-body-lg">How your suite is reached, who controls it, and how it keeps itself safe.</p></div>

        {!visible.length ? <Panel><PanelBody>
          <h2 className="mos-card-title">No settings match &ldquo;{query.trim()}&rdquo;</h2>
          <p className="suite-meta">Try a broader word like &ldquo;email&rdquo;, &ldquo;password&rdquo; or &ldquo;domain&rdquo;.</p>
          <div><button className="mos-btn mos-btn-secondary" onClick={() => setQuery('')} type="button">Clear search</button></div>
        </PanelBody></Panel> : null}

        {/* Hidden rather than unmounted, so a search never throws away a half-typed form. */}
        {GROUPS.map((group) => {
          const settings = SETTINGS.filter((setting) => setting.group === group.id);
          return <section className="suite-settings-group" hidden={!settings.some((setting) => visible.includes(setting.id))} id={`grp-${group.id}`} key={group.id}>
            <div className="suite-settings-group-head">
              <h2 className="mos-eyebrow">{group.title}</h2>
              <p className="suite-meta">{group.description}</p>
            </div>
            {settings.map((setting) => <div className="suite-setting" hidden={!visible.includes(setting.id)} id={`set-${setting.id}`} key={setting.id}>
              {SETTING_CARDS[setting.id]()}
            </div>)}
          </section>;
        })}
      </div>
    </div>
  </section>;
}
