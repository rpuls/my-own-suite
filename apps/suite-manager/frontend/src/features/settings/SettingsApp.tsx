import { CheckCircle2, Globe2, KeyRound, LockKeyhole, RefreshCcw, Rocket, ServerCog } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Notice, TextField } from '../../components/ui';
import { withSetupPath } from '../../lib/base-path';

type LocalHttpsStatus = {
  currentUrls: {
    homepage: string;
    suiteManager: string;
  };
  domain: string;
  localHttpsReady: boolean;
  localHttpsApplyAvailable: boolean;
  realDomain: boolean;
  selfHostFeaturesAvailable: boolean;
  tlsMode: string;
  urlScheme: string;
};

type StatusState =
  | { kind: 'loading' }
  | { kind: 'loaded'; status: LocalHttpsStatus }
  | { kind: 'error'; message: string };

async function readJson<T extends object>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({ error: fallback }))) as T | { error?: string };
  if (!response.ok) {
    throw new Error('error' in body && typeof body.error === 'string' ? body.error : fallback);
  }
  return body as T;
}

async function loadLocalHttpsStatus(): Promise<LocalHttpsStatus> {
  const response = await fetch(withSetupPath('/api/settings/local-https'));
  return readJson<LocalHttpsStatus>(response, 'Unable to load local HTTPS settings.');
}

async function applyLocalHttps(input: {
  acmeEmail: string;
  cloudflareApiToken: string;
  domain: string;
}): Promise<{ applied: boolean; restartScheduled?: boolean }> {
  const response = await fetch(withSetupPath('/api/settings/local-https/apply'), {
    body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  return readJson<{ applied: boolean; restartScheduled?: boolean }>(response, 'Unable to apply local HTTPS settings.');
}

function suggestedDomain(domain: string): string {
  if (!domain || domain === 'localhost' || domain === 'mos.home' || domain.endsWith('.home')) {
    return 'mos.example.com';
  }
  return domain;
}

export default function SettingsApp() {
  const [state, setState] = useState<StatusState>({ kind: 'loading' });
  const [domain, setDomain] = useState('');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [cloudflareApiToken, setCloudflareApiToken] = useState('');
  const [applyState, setApplyState] = useState<
    { kind: 'idle' } | { kind: 'applying' } | { kind: 'success'; message: string } | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const browserUsesHttps =
    typeof window !== 'undefined' && window.location.protocol.toLowerCase() === 'https:';

  async function refresh(): Promise<void> {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'loaded', status: await loadLocalHttpsStatus() });
    } catch (error: unknown) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to load local HTTPS settings.',
      });
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (state.kind === 'loaded' && !domain) {
      setDomain(suggestedDomain(state.status.domain));
    }
  }, [domain, state]);

  async function handleApply(): Promise<void> {
    setApplyState({ kind: 'applying' });
    try {
      await applyLocalHttps({ acmeEmail, cloudflareApiToken, domain });
      setCloudflareApiToken('');
      setApplyState({
        kind: 'success',
        message:
          'Local HTTPS settings were applied. Suite Manager is restarting; refresh this page in about 20 seconds.',
      });
    } catch (error: unknown) {
      setApplyState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to apply local HTTPS settings.',
      });
    }
  }

  return (
    <main className="suite-app">
      <section className="mos-shell suite-hero">
        <span className="mos-eyebrow">Suite Manager</span>
        <h1 className="mos-page-title">Settings</h1>
      </section>

      <section className="mos-shell suite-homepage-config-shell">
        <div className="mos-panel suite-card">
          <div className="suite-homepage-config-header">
            <div>
              <h2 className="mos-card-title">Local HTTPS</h2>
              <p className="suite-meta mos-meta">Use a real domain locally without exposing the suite to the public internet.</p>
            </div>
            <button className="suite-copy-button" onClick={() => void refresh()} type="button">
              <RefreshCcw aria-hidden="true" className="suite-inline-icon" />
              Refresh
            </button>
          </div>

          {state.kind === 'loading' ? <p className="suite-empty">Loading settings...</p> : null}

          {state.kind === 'error' ? (
            <Notice title="Settings unavailable" variant="error">
              <p>{state.message}</p>
            </Notice>
          ) : null}

          {state.kind === 'loaded' ? (
            <div className="suite-settings-stack">
              {!state.status.selfHostFeaturesAvailable ? (
                <>
                  <Notice
                    title={browserUsesHttps ? 'Secure managed hosting detected' : 'Managed hosting detected'}
                    variant={browserUsesHttps ? 'success' : 'info'}
                  >
                    {browserUsesHttps ? (
                      <p>
                        You are already using encrypted HTTPS through your managed infrastructure or hosting provider.
                        Local HTTPS setup is only needed for self-host installs where MOS manages local Caddy.
                      </p>
                    ) : (
                      <p>
                        You are hosting MOS on managed infrastructure. Local HTTPS setup is only available for self-host
                        installs where MOS controls the local Caddy reverse proxy. Configure your custom domain and SSL
                        certificate with your hosting provider instead.
                      </p>
                    )}
                  </Notice>

                  <div className="suite-settings-grid">
                    <div className="suite-settings-fact">
                      <Globe2 aria-hidden="true" className="suite-choice-icon" />
                      <span className="suite-field-label">Current host</span>
                      <strong>{typeof window !== 'undefined' ? window.location.host : state.status.domain}</strong>
                    </div>
                    <div className="suite-settings-fact">
                      <LockKeyhole aria-hidden="true" className="suite-choice-icon" />
                      <span className="suite-field-label">Browser protocol</span>
                      <strong>{browserUsesHttps ? 'https' : 'http'}</strong>
                    </div>
                    <div className="suite-settings-fact">
                      <CheckCircle2 aria-hidden="true" className="suite-choice-icon" />
                      <span className="suite-field-label">Infrastructure</span>
                      <strong>managed</strong>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {state.status.localHttpsReady ? (
                    <Notice title="Local HTTPS is configured" variant="success">
                      <p>Caddy is configured for Cloudflare DNS-01 certificates with HTTPS MOS URLs.</p>
                    </Notice>
                  ) : (
                    <Notice title="Local HTTPS is not enabled yet" variant="warning">
                      <p>Connect a Cloudflare-managed domain and Suite Manager can update the local stack for you.</p>
                    </Notice>
                  )}

                  <div className="suite-settings-grid">
                    <div className="suite-settings-fact">
                      <Globe2 aria-hidden="true" className="suite-choice-icon" />
                      <span className="suite-field-label">Domain</span>
                      <strong>{state.status.domain}</strong>
                    </div>
                    <div className="suite-settings-fact">
                      <LockKeyhole aria-hidden="true" className="suite-choice-icon" />
                      <span className="suite-field-label">URL protocol</span>
                      <strong>{state.status.urlScheme}</strong>
                    </div>
                    <div className="suite-settings-fact">
                      <CheckCircle2 aria-hidden="true" className="suite-choice-icon" />
                      <span className="suite-field-label">TLS mode</span>
                      <strong>{state.status.tlsMode}</strong>
                    </div>
                  </div>

                  {!state.status.localHttpsReady ? (
                    <div className="suite-settings-panel suite-local-https-panel">
                      <div className="suite-settings-panel-header">
                        <div>
                          <h3 className="mos-card-title">Apply local HTTPS</h3>
                          <p className="suite-meta mos-meta">
                            Use a subdomain you own in Cloudflare. Public app DNS records are not required.
                          </p>
                        </div>
                        <ServerCog aria-hidden="true" className="suite-choice-icon" />
                      </div>

                      {state.status.localHttpsApplyAvailable ? (
                        <>
                          <div className="suite-local-https-form">
                            <TextField
                              helperText="Example: mos.example.com. Apps will use homepage.mos.example.com and suite-manager.mos.example.com."
                              label="MOS base domain"
                              onChange={(event) => setDomain(event.target.value)}
                              placeholder="mos.example.com"
                              value={domain}
                            />
                            <TextField
                              helperText="Used by Let's Encrypt for certificate account notices."
                              label="ACME contact email"
                              onChange={(event) => setAcmeEmail(event.target.value)}
                              placeholder="you@example.com"
                              type="email"
                              value={acmeEmail}
                            />
                            <TextField
                              autoComplete="off"
                              helperText="Cloudflare token scoped to Zone Read and DNS Edit for the parent zone."
                              label="Cloudflare API token"
                              onChange={(event) => setCloudflareApiToken(event.target.value)}
                              placeholder="Paste token once"
                              type="password"
                              value={cloudflareApiToken}
                            />
                          </div>

                          <div className="suite-local-https-checklist">
                            <div>
                              <KeyRound aria-hidden="true" className="suite-inline-icon" />
                              <span>Cloudflare token permissions: Zone Read and DNS Edit for the zone.</span>
                            </div>
                            <div>
                              <Globe2 aria-hidden="true" className="suite-inline-icon" />
                              <span>Local DNS wildcard should point *.{domain || 'mos.example.com'} to this machine.</span>
                            </div>
                          </div>

                          {applyState.kind === 'success' ? (
                            <Notice title="Applied" variant="success">
                              <p>{applyState.message}</p>
                            </Notice>
                          ) : null}

                          {applyState.kind === 'error' ? (
                            <Notice title="Could not apply settings" variant="error">
                              <p>{applyState.message}</p>
                            </Notice>
                          ) : null}

                          <button
                            className="suite-copy-button suite-primary-action"
                            disabled={applyState.kind === 'applying'}
                            onClick={() => void handleApply()}
                            type="button"
                          >
                            <Rocket aria-hidden="true" className="suite-inline-icon" />
                            {applyState.kind === 'applying' ? 'Applying...' : 'Apply local HTTPS'}
                          </button>
                        </>
                      ) : (
                        <Notice title="Apply action unavailable" variant="info">
                          <p>
                            The local service agent is not advertising the HTTPS apply capability yet. Update/reconcile
                            the self-host agent, then return here.
                          </p>
                        </Notice>
                      )}
                    </div>
                  ) : null}

                  <div className="suite-settings-panel">
                    <h3 className="mos-card-title">Local DNS</h3>
                    <p className="suite-meta mos-meta">Homepage: {state.status.currentUrls.homepage}</p>
                    <p className="suite-meta mos-meta">Suite Manager: {state.status.currentUrls.suiteManager}</p>
                    <p className="suite-meta mos-meta">
                      Point local DNS for the wildcard domain to this machine. Cloudflare only needs API access for
                      temporary ACME TXT records; public app A/AAAA records are not required.
                    </p>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
