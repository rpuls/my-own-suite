import { useEffect, useState, type FormEvent } from 'react';

import { AdvancedPanel, Notice, Panel, PanelBand, PanelBody, PanelHead, TextInput } from '../../components/ui';
import { jsonResponse, postJson } from '../../lib/api';
import { EditToggle } from './EditToggle';

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
  // The trusted certificate for the Easy Door. `log` is Caddy's own lines about
  // it while it has not arrived, for the technical panel only.
  easyDoorCertificate: { host: string | null; log: string[]; notAfter: string | null; state: 'held' | 'not-applicable' | 'pending' };
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

type AppReconciliationResult = {
  errorCode?: string;
  homepage?: { errorCode?: string; status?: string };
  homepageEntryFailures?: Array<{ errorCode?: string; packageId: string; status: string }>;
  runtime?: Array<{ errorCode?: string; packageId: string; status: string }>;
  skipped?: boolean;
  status?: string;
};

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

// Whether the Easy Door is served with a certificate every browser trusts. Never
// "failed": Caddy keeps asking for it, and the switch to HTTPS happens by itself.
function EasyDoorLockBand({ certificate }: { certificate: AddressStatus['easyDoorCertificate'] }) {
  if (certificate.state === 'held') {
    const until = certificate.notAfter ? new Date(certificate.notAfter).toLocaleDateString(undefined, { dateStyle: 'long' }) : null;
    return <PanelBand icon="lock" note={`Every browser trusts this address. The certificate renews itself${until ? `; the current one is valid until ${until}` : ''}.`} title="Trusted HTTPS" />;
  }
  return <PanelBand busy note="MOS is getting a trusted certificate for this address. Until it arrives your suite works over plain HTTP, and apps that need HTTPS wait. There is nothing to do: everything switches over by itself." title="HTTPS is on its way" tone="info" />;
}

function EasyDoorCertificateDetails({ certificate }: { certificate: AddressStatus['easyDoorCertificate'] }) {
  if (!certificate.log.length) return null;
  return <AdvancedPanel facts={[
    { label: 'Certificate', value: certificate.host ? `*.${certificate.host.replace(/^home\./u, '')}` : 'None' },
    { label: 'State', value: certificate.state },
  ]} output={certificate.log.join('\n')} reveal="technical-mode" summary="Certificate details" />;
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

export function SuiteAddressPanel() {
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
      const started = await postJson<{ startedAt: string }>('/suite-manager/api/settings/address/change', body, 'The address could not be changed.');
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
    {!applying && address.kind === 'easy-door' && status.easyDoorCertificate.state !== 'not-applicable' ? <EasyDoorLockBand certificate={status.easyDoorCertificate} /> : null}
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
    <PanelBody>
      <AddressDiagnostics status={status} />
      <EasyDoorCertificateDetails certificate={status.easyDoorCertificate} />
    </PanelBody>
  </Panel>;
}
