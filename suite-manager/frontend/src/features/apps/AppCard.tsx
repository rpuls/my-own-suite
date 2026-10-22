import { useId } from 'react';

import { pausedByDrive, type StorageEntry } from '../storage/model';
import { appIconSrc, categoryLabel, initialsFor, primaryCategory, statusFor, summaryFor } from './model';
import type { AppPackageSummary } from './types';

export function AppHealthIndicator({ app, ledVariant = false, paused = false }: { app: AppPackageSummary; ledVariant?: boolean; paused?: boolean }) {
  const tooltipId = useId();
  const status = statusFor(app, { paused });
  const label = `${app.name}: ${status.label}`;
  if (ledVariant) {
    return <span aria-describedby={tooltipId} aria-label={label} className="suite-app-health-led-wrap" role="img" tabIndex={0}>
      <span aria-hidden="true" className={`suite-app-health-led ${status.className}`} />
      <span className="suite-app-health-tooltip" id={tooltipId} role="tooltip">{status.label}</span>
    </span>;
  }
  return <span className={`suite-app-health-indicator ${status.className}`}>
    <span aria-hidden="true" className={`suite-app-health-led ${status.className}`} />
    {status.label}
  </span>;
}

export function AppIcon({ app, large = false }: { app: AppPackageSummary; large?: boolean }) {
  const icon = appIconSrc(app);
  return <span className={`suite-app-icon${large ? ' suite-app-icon-large' : ''}`} aria-hidden="true">
    {icon ? <img alt="" src={icon} /> : <span>{initialsFor(app.name)}</span>}
  </span>;
}

export function AppCard({ app, onOpen, storage }: { app: AppPackageSummary; onOpen: (app: AppPackageSummary) => void; storage: StorageEntry[] | null }) {
  return <article className={`suite-app-card${app.external ? ' is-external' : ''}`}>
    <button className="suite-app-card-main" onClick={() => onOpen(app)} type="button">
      <AppIcon app={app} />
      <span className="suite-app-card-copy">
        <span className="suite-app-title-row">
          <strong>{app.name}</strong>
          <span className="suite-app-category-pill">{categoryLabel(primaryCategory(app))}</span>
          {app.external ? <span className="suite-app-external-pill">External &middot; Unverified</span> : null}
          {/* Only advertise an update the owner can actually apply. A candidate that
              needs a newer MOS than this one is still described in the detail panel,
              which explains which MOS version it wants. */}
          {app.catalogUpdate?.status === 'update-available' && app.catalogUpdate.available?.compatibility === 'compatible'
            ? <span className="suite-app-update-pill">Update available</span> : null}
        </span>
        <span>{summaryFor(app)}</span>
      </span>
    </button>
    <div className="suite-app-card-actions">
      <AppHealthIndicator app={app} ledVariant paused={Boolean(pausedByDrive(app.id, storage))} />
      <button className="mos-btn mos-btn-primary" onClick={() => onOpen(app)} type="button">View</button>
    </div>
  </article>;
}
