import { CheckCircle2, Clock3, Download, ExternalLink, Wrench } from 'lucide-react';
import { useState } from 'react';

import { Notice } from '../../components/ui';
import { CatalogSetupHelperPanel } from './setup-helper-registry';
import { installCatalogApp, loadCatalogSetupHelper, useAppCatalog } from './useAppCatalog';
import type { CatalogApp, CatalogProvisioningMode, CatalogSetupHelperResponse } from './types';

type AppCatalogPickerProps = {
  mode?: 'embedded' | 'standalone';
  onInstallUnavailable?: (app: CatalogApp) => void;
};

function provisioningLabel(mode: CatalogProvisioningMode): string {
  if (mode === 'automatic') {
    return 'Automatic';
  }
  if (mode === 'assisted') {
    return 'Guided setup';
  }
  if (mode === 'manual') {
    return 'Manual setup';
  }
  return 'Not in alpha';
}

function statusLabel(app: CatalogApp): string {
  if (app.installed.status === 'installed') {
    return 'Installed';
  }
  if (app.installed.status === 'pending-apply') {
    return 'Ready to apply';
  }
  if (app.installed.status === 'installing') {
    return 'Installing';
  }
  if (app.installed.status === 'failed') {
    return 'Needs attention';
  }
  if (app.installed.status === 'disabled') {
    return 'Disabled';
  }
  return 'Available';
}

function StatusIcon({ app }: { app: CatalogApp }) {
  if (app.installed.status === 'installed') {
    return <CheckCircle2 aria-hidden="true" className="suite-inline-icon" />;
  }
  if (app.provisioning.mode === 'automatic') {
    return <Download aria-hidden="true" className="suite-inline-icon" />;
  }
  if (app.provisioning.mode === 'unsupported-alpha') {
    return <Clock3 aria-hidden="true" className="suite-inline-icon" />;
  }
  return <Wrench aria-hidden="true" className="suite-inline-icon" />;
}

export function AppCatalogPicker({ mode = 'embedded', onInstallUnavailable }: AppCatalogPickerProps) {
  const { setCatalog, state } = useAppCatalog();
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [helper, setHelper] = useState<CatalogSetupHelperResponse | null>(null);
  const [helperError, setHelperError] = useState<string | null>(null);
  const [helperLoadingAppId, setHelperLoadingAppId] = useState<string | null>(null);

  async function install(app: CatalogApp): Promise<void> {
    if (app.provisioning.mode === 'manual' || app.provisioning.mode === 'unsupported-alpha') {
      onInstallUnavailable?.(app);
      return;
    }

    setInstallingAppId(app.id);
    setInstallMessage(null);
    setInstallError(null);
    try {
      const response = await installCatalogApp(app.id);
      setCatalog(response);
      setInstallMessage(`${app.name} install is ready.`);
    } catch (error: unknown) {
      setInstallError(error instanceof Error ? error.message : 'Unable to install this app.');
    } finally {
      setInstallingAppId(null);
    }
  }

  async function openSetupHelper(app: CatalogApp): Promise<void> {
    setHelperLoadingAppId(app.id);
    setHelperError(null);
    try {
      setHelper(await loadCatalogSetupHelper(app.id));
    } catch (error: unknown) {
      setHelperError(error instanceof Error ? error.message : 'Unable to load this setup helper.');
    } finally {
      setHelperLoadingAppId(null);
    }
  }

  if (state.kind === 'loading') {
    return <p className="suite-empty">Loading app catalog...</p>;
  }

  if (state.kind === 'error') {
    return (
      <Notice title="Could not load catalog" variant="error">
        <p>{state.message}</p>
      </Notice>
    );
  }

  const apps = state.catalog.apps;

  return (
    <section className={`suite-app-catalog-picker is-${mode}`} aria-label="MOS app catalog">
      {installMessage ? (
        <Notice title="Install plan ready" variant="success">
          <p>{installMessage}</p>
        </Notice>
      ) : null}
      {installError ? (
        <Notice title="Install failed" variant="error">
          <p>{installError}</p>
        </Notice>
      ) : null}
      {helperError ? (
        <Notice title="Setup helper unavailable" variant="error">
          <p>{helperError}</p>
        </Notice>
      ) : null}
      {helper ? (
        <Notice title={helper.title} variant="info">
          <CatalogSetupHelperPanel helper={helper} />
        </Notice>
      ) : null}
      <div className="suite-app-catalog-list">
        {apps.map((app) => (
          <article className="suite-app-catalog-item" key={app.id}>
            <div className="suite-app-catalog-item-main">
              <div className="suite-app-catalog-title-row">
                <h3>{app.name}</h3>
                <span className={`suite-app-catalog-status is-${app.installed.status}`}>
                  <StatusIcon app={app} />
                  {statusLabel(app)}
                </span>
              </div>
              <p>{app.summary}</p>
              <div className="suite-app-catalog-meta" aria-label={`${app.name} setup details`}>
                <span>{app.category}</span>
                <span>{provisioningLabel(app.provisioning.mode)}</span>
                {app.dependencies.length > 0 ? <span>{app.dependencies.length} companion app</span> : null}
              </div>
            </div>
            <div className="suite-app-catalog-actions">
              <a className="suite-subtle-button" href={app.docs.app} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" className="suite-inline-icon" />
                Docs
              </a>
              <button
                className="suite-copy-button"
                disabled={
                  installingAppId === app.id ||
                  app.installed.status === 'installed' ||
                  app.installed.status === 'pending-apply'
                }
                onClick={() => void install(app)}
                type="button"
              >
                <Download aria-hidden="true" className="suite-inline-icon" />
                {installingAppId === app.id
                  ? 'Preparing...'
                  : app.installed.status === 'installed'
                    ? 'Installed'
                    : app.installed.status === 'pending-apply'
                      ? 'Ready'
                      : 'Install'}
              </button>
              {app.installed.status === 'installed' && app.provisioning.setupHelper ? (
                <button
                  className="suite-copy-button"
                  disabled={helperLoadingAppId === app.id}
                  onClick={() => void openSetupHelper(app)}
                  type="button"
                >
                  <Wrench aria-hidden="true" className="suite-inline-icon" />
                  {helperLoadingAppId === app.id
                    ? 'Opening...'
                    : app.provisioning.postInstallActionLabel || 'Setup'}
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
