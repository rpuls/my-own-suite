import { useState } from 'react';

import { AdvancedPanel, Icon, Notice } from '../../components/ui';
import { initialSetupConfig, requiredSetupMissing, setupFieldsNeedInput } from './AppConfigDialog';
import type { Owner } from '../setup/types';
import { appSourceLabel } from '../../lib/app-sources';
import { AppSetupPanel, InstallButton } from './AppDetail';
import { externalDescription, initialsFor, permissionLabel } from './model';
import type { ExternalCard, ExternalSourceCoordinates } from './types';

function ExternalAppIcon({ card, large = false }: { card: ExternalCard; large?: boolean }) {
  return <span className={`suite-app-icon${large ? ' suite-app-icon-large' : ''}`} aria-hidden="true">
    {card.iconDataUrl ? <img alt="" src={card.iconDataUrl} /> : <span>{initialsFor(card.name)}</span>}
  </span>;
}

export function ExternalAppCard({ card, onOpen }: { card: ExternalCard; onOpen: () => void }) {
  const broken = card.packageErrors.length > 0;
  return <article className="suite-app-card is-external">
    <button className="suite-app-card-main" onClick={onOpen} type="button">
      <ExternalAppIcon card={card} />
      <span className="suite-app-card-copy">
        <span className="suite-app-title-row">
          <strong>{card.name}</strong>
          <span className="suite-app-external-pill">External &middot; Unverified</span>
        </span>
        <span>{broken ? 'This app package cannot be installed until its publisher fixes it.' : externalDescription(card)}</span>
      </span>
    </button>
    <div className="suite-app-card-actions">
      <button className="mos-btn mos-btn-primary" onClick={onOpen} type="button">View</button>
    </div>
  </article>;
}

export function ExternalAppDetail({ card, installError, installing, onClose, onInstall, owner, source }: {
  card: ExternalCard;
  installError: string;
  installing: boolean;
  onClose: () => void;
  onInstall: (card: ExternalCard, config: Record<string, string>) => void;
  owner: Owner;
  source: ExternalSourceCoordinates;
}) {
  const permissions = card.permissions;
  const [setupConfig, setSetupConfig] = useState<Record<string, string>>(() => initialSetupConfig(card, owner));
  const inputFields = setupFieldsNeedInput(card);
  const canInstall = card.validation.valid && !card.packageErrors.length && !requiredSetupMissing(card, setupConfig) && !installing;
  return <div className="suite-app-detail-layer">
    <button aria-label="Close package details" className="suite-app-detail-backdrop" onClick={onClose} tabIndex={-1} type="button" />
    <aside aria-label={`${card.name} details`} aria-modal="true" className="suite-app-detail" role="dialog">
      {/* An external package never ships screenshots, so this is the same hero
          without a cover image. */}
      <header className="suite-app-detail-hero">
        <div className="suite-app-detail-hero-top">
          <button aria-label="Close package details" className="suite-app-hero-pill is-round" onClick={onClose} type="button"><Icon name="x" /></button>
        </div>
        <div className="suite-app-detail-hero-bottom">
          <ExternalAppIcon card={card} large />
          <div className="suite-app-detail-heading">
            <div className="suite-app-detail-title-row">
              <h2>{card.name}</h2>
            </div>
            <p className="suite-app-detail-replaces">
              <span className="suite-app-external-pill">External &middot; Unverified</span>
            </p>
          </div>
        </div>
        <div className="suite-app-action-bar">
          <InstallButton disabled={!canInstall} installing={installing} onClick={() => onInstall(card, { ...setupConfig })} unmet={card.unmetRequirements} />
        </div>
      </header>

      <div className="suite-app-detail-scroll">
        <p className="suite-app-detail-description">{externalDescription(card)}</p>
        {inputFields.length ? <AppSetupPanel
          disabled={installing}
          fields={inputFields}
          onChange={(id, value) => setSetupConfig((current) => ({ ...current, [id]: value }))}
          values={setupConfig}
        /> : null}

        {installError ? <Notice title="This package could not be installed" variant="warning"><p>{installError}</p></Notice> : null}

        <Notice title="Unverified external package" variant="warning">
          <p>This package comes from a repository you brought yourself, not the verified MOS catalog. MOS has not reviewed its code or checked any privacy claims. Installing it builds its Dockerfiles on your server, which runs commands the publisher wrote &mdash; with network access &mdash; before any of MOS&apos;s runtime restrictions apply. Install it only if you trust whoever publishes that repository. Once running, it is restricted to its own named storage and the web addresses listed below &mdash; no privileged access, host folders, or Docker socket.</p>
        </Notice>

        {!card.validation.valid ? <Notice title="This package cannot be installed" variant="warning"><ul>{card.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul></Notice> : null}

        {card.packageErrors.length ? <Notice title="This package cannot be installed" variant="warning">
          <p>The repository publishes this app, but MOS refuses it for the reasons below. Only its publisher can fix these.</p>
          <ul>{card.packageErrors.map((item) => <li key={item}>{item}</li>)}</ul>
        </Notice> : null}

        <section className="suite-app-detail-section">
          <h3>Requested access</h3>
          {permissions.length ? <ul className="suite-app-permission-list">
            {permissions.map((permission) => {
              const described = permissionLabel(permission);
              return <li key={permission}><strong>{described.label}</strong>{described.detail ? <small>{described.detail}</small> : null}</li>;
            })}
          </ul> : <p className="suite-meta">This package does not request any web addresses, storage, or integrations.</p>}
        </section>

        <section className="suite-app-facts" aria-label="Package facts">
          <div><span>Trust</span><strong>Unverified</strong></div>
          <div><span>Review</span><strong>Not reviewed by MOS</strong></div>
          {card.appVersion ? <div><span>Version</span><strong>{card.appVersion}</strong></div> : null}
          <div><span>Source</span><strong>{appSourceLabel(source.repository)}</strong></div>
        </section>

        <AdvancedPanel className="suite-app-advanced" facts={[
          { label: 'Repository', value: source.repository },
          { code: true, label: 'Revision', value: source.revision.slice(0, 12) },
          { label: 'Package id', value: card.packageId },
          { label: 'Package version', value: card.version || 'Unknown' },
          { code: true, label: 'Package digest', value: card.packageDigest || 'Unavailable' },
          { label: 'Services', value: card.services.map((service) => `${service.id}:${service.internalPort ?? '?'}`).join(', ') || 'None' },
          { label: 'Routes', value: card.routes.map((route) => `${route.host} -> ${route.service}${route.kind === 'api' ? ' (api)' : ''}`).join(', ') || 'None' },
        ]} reveal="technical-mode" />
      </div>
    </aside>
  </div>;
}
