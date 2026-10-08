import { useState, type FormEvent } from 'react';

import { Notice, Panel, PanelBody, PanelHead, TextInput } from '../../../components/ui';
import { EditToggle } from '../EditToggle';
import { DOMAIN_PATTERN, normalizeDomain, type AddressStatus, type SuiteAddress, type SuiteAddressController } from './model';
import { AddressBand, AddressDiagnostics, ChangeOutcome, ContactNotices } from './shared';

const ADDRESS_KIND_SENTENCES: Record<SuiteAddress['kind'], string> = {
  domain: 'Your own domain, with a trusted certificate.',
  'easy-door': 'The address this server was installed with.',
  'lan-name': 'The address this server was installed with. It works as it is; your own domain is optional.',
};

// Every app is a name under the domain, so one wildcard record covers them all,
// Homepage included.
function DnsRecord({ domain, serverAddress }: { domain: string; serverAddress: string }) {
  return <pre className="suite-command-block">{`Type   A\nName   *.${domain}\nValue  ${serverAddress}`}</pre>;
}

// A server the internet can reach: the certificate authority checks a domain by
// visiting it, so the owner points the domain here and MOS does the rest, with
// no account or token.
export function PublicServerAddress({ status, suite }: { status: AddressStatus; suite: SuiteAddressController }) {
  const { applying, busy, contact, error, outcome, setError, startChange } = suite;
  const address = status.address;
  const [editing, setEditing] = useState(false);
  const [baseDomain, setBaseDomain] = useState(address.baseDomain || status.offered?.baseDomain || '');
  const serverAddress = status.serverAddress || "this server's IP address";
  const domain = normalizeDomain(baseDomain);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!DOMAIN_PATTERN.test(domain)) { setError('Enter a valid domain, such as example.com.'); return; }
    if (await startChange({ baseDomain: domain, kind: 'domain' })) setEditing(false);
  }

  const notices = [
    !outcome && !applying && address.kind === 'domain' && address.resolvesHere === false ? <Notice key="dns" title={`${address.host} does not point at this server`} variant="warning">
      <p>Browsers cannot reach your suite through it. Check this record where your domain&apos;s DNS is managed:</p>
      <DnsRecord domain={address.baseDomain || address.host} serverAddress={serverAddress} />
    </Notice> : null,
    status.offered && !applying ? <Notice key="offered" title={`This backup was set up for ${status.offered.baseDomain}`} variant="info">
      <p>Anything set up against <strong>home.{status.offered.baseDomain}</strong> — phone apps, sync clients, browser extensions — keeps failing until that domain points at this server. Add this record where its DNS is managed, then serve it from here:</p>
      <DnsRecord domain={status.offered.baseDomain} serverAddress={serverAddress} />
      <p>
        <button className="mos-btn mos-btn-primary" disabled={Boolean(busy) || !status.agentAvailable} onClick={() => void startChange({ baseDomain: status.offered?.baseDomain, kind: 'domain' })} type="button">{busy === 'change' ? 'Moving...' : `Serve ${status.offered.baseDomain} from here`}</button>
        {' '}
        <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => void suite.dismissOffer()} type="button">{busy === 'dismiss' ? 'Dismissing...' : 'Not on this server'}</button>
      </p>
    </Notice> : null,
    error && !editing ? <Notice key="error" title="The address was not changed" variant="error"><p>{error}</p></Notice> : null,
  ].filter(Boolean);

  return <Panel>
    <PanelHead
      actions={applying ? null : <EditToggle editing={editing} label={address.kind === 'domain' ? 'Edit' : 'Use your own domain'} onToggle={() => { setEditing(!editing); setError(''); }} />}
      heading="h3"
      title="Suite address"
    ><p>Where every app and your Homepage are published. MOS itself also keeps answering on <a href={status.bootstrapUrl}>{status.bootstrapUrl}</a>, so you can always get back here.</p></PanelHead>
    <AddressBand contact={contact} note={ADDRESS_KIND_SENTENCES[address.kind]} status={status} />
    {outcome || notices.length || editing || contact !== 'ok' ? <PanelBody>
      <ContactNotices change={status.lastChange} contact={contact} />
      <ChangeOutcome address={address} outcome={outcome} />
      {notices}
      {editing ? <form className="suite-settings-form" onSubmit={(event) => void submit(event)}>
        <p className="suite-meta">Your apps and Homepage move to names under your domain, each with a trusted certificate. Point the domain at this server, then move. No account or token is needed.</p>
        {!status.agentAvailable ? <Notice title="HTTPS agent unavailable" variant="warning"><p>Moving the suite needs the MOS HTTPS agent. Update or repair the MOS control plane, then try again.</p></Notice> : null}
        <TextInput autoComplete="url" helperText={`Your Home URL becomes home.${DOMAIN_PATTERN.test(domain) ? domain : 'example.com'}.`} label="Your domain" onChange={(event) => setBaseDomain(event.target.value)} placeholder="example.com" value={baseDomain} />
        <p>Add this record where your domain&apos;s DNS is managed, usually at the company you bought it from:</p>
        <DnsRecord domain={DOMAIN_PATTERN.test(domain) ? domain : 'example.com'} serverAddress={serverAddress} />
        <p className="suite-meta">A new record can take a few minutes to reach everyone. MOS checks it before anything moves.</p>
        {error ? <Notice title="The address was not changed" variant="error"><p>{error}</p></Notice> : null}
        <div className="suite-settings-actions">
          <button className="mos-btn mos-btn-primary" disabled={!status.agentAvailable || !domain || Boolean(busy) || applying} type="submit">{busy === 'change' ? 'Checking...' : 'Move my suite to this domain'}</button>
        </div>
      </form> : null}
    </PanelBody> : null}
    <PanelBody>
      <AddressDiagnostics status={status} />
    </PanelBody>
  </Panel>;
}
