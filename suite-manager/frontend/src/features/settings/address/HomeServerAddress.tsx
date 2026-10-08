import { useState, type FormEvent } from 'react';

import { AdvancedPanel, Notice, Panel, PanelBand, PanelBody, PanelHead, TextInput } from '../../../components/ui';
import { EditToggle } from '../EditToggle';
import { DOMAIN_PATTERN, normalizeDomain, type AddressStatus, type SuiteAddress, type SuiteAddressController } from './model';
import { AddressBand, AddressDiagnostics, ChangeOutcome, ContactNotices } from './shared';

const ADDRESS_KIND_SENTENCES: Record<SuiteAddress['kind'], string> = {
  domain: 'Your own domain, with a trusted certificate.',
  'easy-door': 'The Easy Door: the name MOS answers on with nothing configured on your network.',
  'lan-name': 'The name this server was installed with. Your network has to know where it lives.',
};

function LocalDnsInstructions({ homeHost, serverAddress }: { homeHost: string; serverAddress: string }) {
  return <>
    <p>MOS serves HTTPS at <strong>{homeHost}</strong>, but your devices or local network still have to learn where that name lives.</p>
    <p>Create a local DNS override that sends this hostname to this server IP:</p>
    <pre className="suite-command-block">{`${serverAddress} ${homeHost}`}</pre>
    <p>The right place to do that depends on your setup: your router, local DNS server, AdGuard Home, Unbound, Pi-hole, or an operating-system hosts file can all be valid options.</p>
  </>;
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

const ADDRESS_INTRO = 'Where every app and your Homepage are published. MOS itself also keeps answering on the Easy Door and the name it was installed with, so you can always get back here.';

// A server on a home network: the certificate authority cannot reach it, so a
// domain proves itself through Cloudflare DNS and the owner's own network has
// to learn the name. The Easy Door is its address until then.
export function HomeServerAddress({ status, suite }: { status: AddressStatus; suite: SuiteAddressController }) {
  const { applying, busy, contact, error, outcome, setError, startChange } = suite;
  const address = status.address;
  const [editing, setEditing] = useState(false);
  const [baseDomain, setBaseDomain] = useState(address.baseDomain || status.offered?.baseDomain || '');
  const [acmeEmail, setAcmeEmail] = useState(address.acmeEmail || status.offered?.acmeEmail || '');
  const [token, setToken] = useState('');
  const dnsAddress = status.serverAddress || '<server-ip>';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedDomain = normalizeDomain(baseDomain);
    if (!DOMAIN_PATTERN.test(normalizedDomain)) { setError('Enter a valid Cloudflare-managed base domain.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(acmeEmail.trim())) { setError('Enter a valid ACME contact email address.'); return; }
    if (!/^[A-Za-z0-9_-]{20,4096}$/u.test(token.trim())) { setError('A valid Cloudflare API token is required.'); return; }
    if (!status.agentAvailable) { setError('The HTTPS system agent is unavailable. Update or repair the MOS control plane, then try again.'); return; }
    const submittedToken = token.trim();
    setToken('');
    if (await startChange({ acmeEmail: acmeEmail.trim(), baseDomain: normalizedDomain, cloudflareApiToken: submittedToken, kind: 'domain' })) setEditing(false);
  }

  // The offered domain is served with the credential the restore kept for it,
  // so this needs no token. An offer that came without a contact address takes
  // the one in the form.
  async function useOffered() {
    if (!status.offered) return;
    const email = (status.offered.acmeEmail || acmeEmail).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) { setError('Enter a valid ACME contact email address for the offered domain.'); return; }
    await startChange({ acmeEmail: email, kind: 'domain', useOffered: true });
  }

  const canApplyHttps = Boolean(status.agentAvailable && baseDomain.trim() && acmeEmail.trim() && token.trim() && !busy && !applying);

  const notices = [
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
        <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => void suite.dismissOffer()} type="button">{busy === 'dismiss' ? 'Dismissing...' : 'Not on this server'}</button>
      </p>
    </Notice> : null,
    // An error from the drift or offer buttons has no open form to show in.
    error && !editing ? <Notice key="error" title="The address was not changed" variant="error"><p>{error}</p></Notice> : null,
  ].filter(Boolean);

  return <Panel>
    <PanelHead
      actions={applying ? null : <EditToggle editing={editing} label={address.kind === 'domain' ? 'Edit' : 'Use your own domain'} onToggle={() => { setEditing(!editing); setError(''); }} />}
      heading="h3"
      title="Suite address"
    ><p>{ADDRESS_INTRO}</p></PanelHead>
    <AddressBand contact={contact} note={ADDRESS_KIND_SENTENCES[address.kind]} status={status} />
    {!applying && address.kind === 'easy-door' && status.easyDoorCertificate.state !== 'not-applicable' ? <EasyDoorLockBand certificate={status.easyDoorCertificate} /> : null}
    {outcome || notices.length || editing || contact !== 'ok' ? <PanelBody>
      <ContactNotices change={status.lastChange} contact={contact} />
      <ChangeOutcome address={address} dnsHelp={<LocalDnsInstructions homeHost={address.host} serverAddress={dnsAddress} />} outcome={outcome} />
      {notices}
      {editing ? <form className="suite-settings-form" onSubmit={(event) => void submit(event)}>
        <p className="suite-meta">MOS uses Cloudflare DNS-01 to get a trusted certificate for private local access to <strong>home.&lt;your-domain&gt;</strong>. This does not publish MOS to the internet or configure public access. Your apps move to the new address with it.</p>
        {!status.agentAvailable ? <Notice title="HTTPS agent unavailable" variant="warning"><p>You can review and validate the form, but applying requires the installed MOS HTTPS agent and Cloudflare-capable Caddy build.</p></Notice> : null}
        <div className="suite-settings-fields">
          <TextInput autoComplete="url" helperText="Example: mos.example.com. Your Home URL becomes home.mos.example.com." label="Base domain" onChange={(event) => setBaseDomain(event.target.value)} placeholder="mos.example.com" value={baseDomain} />
          <TextInput autoComplete="email" helperText="For account notices from the certificate authority." label="Certificate contact email" onChange={(event) => setAcmeEmail(event.target.value)} placeholder="you@example.com" type="email" value={acmeEmail} />
        </div>
        <TextInput autoComplete="off" helperText="Needs Zone Read and DNS Edit for the relevant Cloudflare zone. Used once, never shown again." label="Cloudflare API token" onChange={(event) => setToken(event.target.value)} placeholder={address.kind === 'domain' ? 'Paste a token to apply again' : 'Paste token once'} type="password" value={token} />
        {error ? <Notice title="The address was not changed" variant="error"><p>{error}</p></Notice> : null}
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
