import { CheckCircle2, Globe2, LockKeyhole, RefreshCcw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Notice } from '../../components/ui';
import { withSetupPath } from '../../lib/base-path';

type LocalHttpsStatus = {
  currentUrls: {
    homepage: string;
    suiteManager: string;
  };
  domain: string;
  localHttpsReady: boolean;
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

export default function SettingsApp() {
  const [state, setState] = useState<StatusState>({ kind: 'loading' });
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
                    <Notice title="Manual setup required" variant="warning">
                      <p>
                        This stack is not in local HTTPS mode yet. Configure the env values below, run the normal
                        VPS/self-host init flow, and restart the stack. A future config/domain agent can turn this into
                        an Apply button.
                      </p>
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

                  <div className="suite-settings-panel">
                    <h3 className="mos-card-title">Required env values</h3>
                    <pre className="suite-homepage-caddy-preview-code">
                      <code>{`DOMAIN=home.example.com
PUBLIC_URL_SCHEME=https
MOS_TLS_MODE=cloudflare-dns01

# deploy/vps/services/caddy/.env
CADDY_ACME_EMAIL=you@example.com
CLOUDFLARE_API_TOKEN=<scoped Cloudflare DNS token>`}</code>
                    </pre>
                  </div>

                  <div className="suite-settings-panel">
                    <h3 className="mos-card-title">After DNS-01 is enabled</h3>
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
