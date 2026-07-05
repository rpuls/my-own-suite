import { useEffect, useState, type FormEvent } from 'react';

import { Notice, TextInput } from '../../components/ui';

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

type ApplyResult = { appliedAt: string; bootstrapUrl: string; homeUrl: string; status: string };

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : fallback);
  return body;
}

function LocalDnsInstructions({ homeHost, serverAddress }: { homeHost: string; serverAddress: string }) {
  return <>
    <p>MOS can now serve HTTPS at <strong>{homeHost}</strong>, but your devices or local network may still need to learn where that name lives.</p>
    <p>Create a local DNS override that sends this hostname to this server IP:</p>
    <pre className="suite-command-block">{`${serverAddress} ${homeHost}`}</pre>
    <p>The right place to do that depends on your setup: your router, local DNS server, AdGuard Home, Unbound, Pi-hole, or an operating-system hosts file can all be valid options.</p>
  </>;
}

function AdvancedDetails({ status }: { status: HttpsStatus }) {
  return <details className="suite-advanced"><summary>Advanced details</summary><dl><dt>Bootstrap recovery URL</dt><dd>{status.bootstrapUrl}</dd><dt>Active Home URL</dt><dd>{status.activeHomeUrl}</dd><dt>Install context</dt><dd>{status.installContext}</dd><dt>Detected server IP</dt><dd>{status.serverAddress || 'Not detected'}</dd><dt>TLS mode</dt><dd>{status.tlsMode}</dd><dt>Provider</dt><dd>{status.provider || 'Not configured'}</dd><dt>Last apply</dt><dd>{status.lastApply.status}{status.lastApply.errorCode ? ` (${status.lastApply.errorCode})` : ''}</dd>{status.lastApply.diagnostics ? <><dt>Sanitized diagnostics</dt><dd>{status.lastApply.diagnostics}</dd></> : null}</dl></details>;
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

  useEffect(() => { void load(); }, []);

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
      setFormError('The HTTPS system agent is unavailable. Update or repair the V2 control plane, then try again.'); return;
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

  return <section className="mos-shell suite-settings">
    <div className="suite-hero"><h1>Settings</h1><p className="suite-lead mos-body-lg">Manage how this MOS Home is reached from your browser.</p></div>
    {loadError ? <Notice title="Settings unavailable" variant="error"><p>{loadError}</p></Notice> : null}
    {status ? !status.privateHttpsAvailable ? <div className="mos-panel suite-card suite-settings-panel">
      <div><h2 className="mos-card-title">Custom domains are handled by your provider</h2><p className="suite-meta">This install looks like it is hosted on an external provider. MOS does not manage public DNS, provider routing, or public TLS from here.</p></div>
      <Notice title="Use your provider guide" variant="info"><p>To use a real domain with this cloud install, follow your hosting provider's custom-domain and HTTPS instructions, then point that domain at the provider endpoint or server they give you.</p></Notice>
      <AdvancedDetails status={status} />
    </div> : <div className="mos-panel suite-card suite-settings-panel">
      <div><h2 className="mos-card-title">Private LAN HTTPS with Cloudflare DNS</h2><p className="suite-meta">Use DNS-01 to get a trusted certificate for private local access to <strong>home.&lt;your-domain&gt;</strong>. This does not publish MOS to the internet or configure public access.</p></div>
      {!status.agentAvailable ? <Notice title="HTTPS agent unavailable" variant="warning"><p>You can review and validate the form, but applying requires the installed V2 HTTPS agent and Cloudflare-capable Caddy build.</p></Notice> : null}
      <form className="suite-settings-form" onSubmit={(event) => void submit(event)}>
        <TextInput autoComplete="url" helperText="Example: mos.example.com. Your Home URL becomes home.mos.example.com." label="MOS base domain" onChange={(event) => setBaseDomain(event.target.value)} placeholder="mos.example.com" value={baseDomain} />
        <TextInput autoComplete="email" helperText="Used by the ACME certificate authority for account notices." label="ACME contact email" onChange={(event) => setAcmeEmail(event.target.value)} placeholder="you@example.com" type="email" value={acmeEmail} />
        <TextInput autoComplete="off" helperText="Requires Zone Read and DNS Edit for the relevant Cloudflare zone. The saved token is never returned." label="Cloudflare API token" onChange={(event) => setToken(event.target.value)} placeholder={status.tokenConfigured ? 'Paste a replacement token to reapply' : 'Paste token once'} type="password" value={token} />
        {formError ? <Notice title="HTTPS was not applied" variant="error"><p>{formError}</p></Notice> : null}
        {result ? <Notice title="HTTPS configuration applied" variant="success"><p>Your new Home URL is <a href={result.homeUrl}>{result.homeUrl}</a>.</p><LocalDnsInstructions homeHost={activeHomeHost} serverAddress={dnsAddress} /><a className="mos-btn mos-btn-primary" href={result.homeUrl}>Open HTTPS Home</a></Notice> : null}
        <button className="mos-btn mos-btn-primary" disabled={!canApplyHttps} type="submit">{applying ? 'Applying securely...' : 'Apply HTTPS settings'}</button>
      </form>
      {!result && status.lastApply.status === 'applied' && activeHomeHost ? <Notice title="HTTPS is configured" variant="success"><p>Active Home URL: <a href={status.activeHomeUrl}>{status.activeHomeUrl}</a>.</p><LocalDnsInstructions homeHost={activeHomeHost} serverAddress={dnsAddress} /></Notice> : null}
      <AdvancedDetails status={status} />
    </div> : <p className="suite-meta">Loading HTTPS settings...</p>}
  </section>;
}
