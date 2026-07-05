import { useEffect, useState } from 'react';

import { Notice } from '../../components/ui';

type PathState = { exists: boolean; kind: string; path: string };
type BackupInventory = {
  actions: { backupEnabled: boolean; backupLabel: string; backupReason: string; restoreEnabled: boolean };
  checkedAt: string;
  contents: {
    caddyFiles: PathState[];
    homepageConfig: { files: PathState[]; path: string };
    httpsSecret: PathState;
    suiteManager: {
      appSecrets: PathState;
      database: PathState;
      databaseShm: PathState;
      databaseWal: PathState;
      stateDir: string;
    };
  };
  destinationModel: { preferred: string[]; status: string; summary: string };
  packages: Array<{
    declaredVolumes: Array<{ backupClass: string; declaredName: string; dockerVolume: string; requiredOnRestore: boolean }>;
    installedAt: string | null;
    manifestDigest: string;
    manifestPresent: boolean;
    packageId: string;
    packageVersion: string;
    status: string;
    warnings: string[];
  }>;
  relationships: { active: number; count: number; statuses: Array<{ count: number; status: string }> };
  summary: { appCount: number; declaredVolumeCount: number; relationshipCount: number; warningCount: number };
  warnings: Array<{ message: string; packageId: string }>;
};

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : fallback);
  return body;
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function statusLabel(value: string) {
  return value.replace(/-/gu, ' ').replace(/\b\w/gu, (match) => match.toUpperCase());
}

function PathList({ items }: { items: PathState[] }) {
  return <ul className="suite-backup-path-list">
    {items.map((item) => <li key={item.path}>
      <span aria-hidden="true" className={`suite-backup-dot ${item.exists ? 'is-ready' : 'is-missing'}`} />
      <code>{item.path}</code>
      <small>{item.exists ? item.kind : 'missing'}</small>
    </li>)}
  </ul>;
}

function downloadInventory(inventory: BackupInventory) {
  const timestamp = inventory.checkedAt.replace(/[:.]/gu, '-');
  const blob = new Blob([`${JSON.stringify(inventory, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mos-v2-backup-inventory-${timestamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function BackupsScreen() {
  const [inventory, setInventory] = useState<BackupInventory | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setInventory(await jsonResponse<BackupInventory>(
        await fetch('/suite-manager/api/backups/inventory'),
        'Unable to load backup inventory.',
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load backup inventory.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return <section className="mos-shell suite-backups">
    <div className="suite-hero">
      <span className="mos-pill mos-pill-accent">Whole-suite recovery</span>
      <h1>Backup</h1>
      <p className="suite-lead mos-body-lg">
        Back up everything needed to recover this MOS install, including Suite Manager, Homepage, HTTPS settings, apps, relationships, secrets, and app data.
      </p>
    </div>

    {error ? <Notice title="Backup inventory unavailable" variant="error"><p>{error}</p></Notice> : null}
    {loading ? <p className="suite-meta">Loading backup inventory...</p> : null}

    {inventory ? <div className="suite-backup-layout">
      <section className="mos-panel suite-card suite-backup-panel">
        <div className="suite-backup-header-row">
          <div>
            <h2 className="mos-card-title">Back up everything</h2>
            <p className="suite-meta">Checked {formatDate(inventory.checkedAt)}</p>
          </div>
          <span className={`mos-pill ${inventory.summary.warningCount === 0 ? 'is-active' : ''}`}>
            {inventory.summary.warningCount === 0 ? 'Inventory ready' : `${inventory.summary.warningCount} warning(s)`}
          </span>
        </div>

        <div className="suite-backup-facts">
          <div><span>Apps</span><strong>{inventory.summary.appCount}</strong></div>
          <div><span>Volumes</span><strong>{inventory.summary.declaredVolumeCount}</strong></div>
          <div><span>Relationships</span><strong>{inventory.summary.relationshipCount}</strong></div>
        </div>

        <Notice title="Archive jobs are not enabled yet" variant="warning">
          <p>{inventory.actions.backupReason}</p>
        </Notice>

        <div className="suite-backup-action-row">
          <button className="mos-btn mos-btn-primary" disabled={!inventory.actions.backupEnabled} type="button">
            {inventory.actions.backupLabel}
          </button>
          <button className="mos-btn mos-btn-secondary" disabled type="button">
            Download backup
          </button>
          <button className="mos-btn mos-btn-secondary" onClick={() => downloadInventory(inventory)} type="button">
            Download inventory
          </button>
        </div>
        <p className="suite-meta">
          Browser archive download will be enabled after the V2 backup agent can create encrypted backup bundles without depending on Suite Manager staying online during the cold snapshot.
        </p>
      </section>

      <section className="mos-panel suite-card suite-backup-panel">
        <h2 className="mos-card-title">Destination model</h2>
        <p className="suite-meta">{inventory.destinationModel.summary}</p>
        <div className="suite-backup-destination-preview">
          {inventory.destinationModel.preferred.map((item) => <div key={item}>
            <strong>{item}</strong>
            <span>{item.includes('USB') ? 'Planned for removable storage detection and mount flow.' : 'Planned for same-machine recovery snapshots.'}</span>
          </div>)}
        </div>
      </section>

      {inventory.warnings.length ? <Notice title="Inventory warnings" variant="warning">
        <ul>{inventory.warnings.map((warning) => <li key={`${warning.packageId}-${warning.message}`}>{warning.packageId}: {warning.message}</li>)}</ul>
      </Notice> : null}

      <section className="mos-panel suite-card suite-backup-panel">
        <h2 className="mos-card-title">Protected areas</h2>
        <div className="suite-backup-protected-grid">
          <div><span>Suite Manager state</span><strong>{inventory.contents.suiteManager.database.exists ? 'Found' : 'Missing'}</strong></div>
          <div><span>App secrets</span><strong>{inventory.contents.suiteManager.appSecrets.exists ? 'Found' : 'Pending'}</strong></div>
          <div><span>Homepage config</span><strong>{inventory.contents.homepageConfig.files.filter((item) => item.exists).length}/{inventory.contents.homepageConfig.files.length}</strong></div>
          <div><span>HTTPS token</span><strong>{inventory.contents.httpsSecret.exists ? 'Found' : 'Not configured'}</strong></div>
        </div>
      </section>

      <section className="mos-panel suite-card suite-backup-panel">
        <h2 className="mos-card-title">Installed app data</h2>
        {inventory.packages.length ? <div className="suite-backup-package-list">
          {inventory.packages.map((app) => <article key={app.packageId}>
            <div>
              <strong>{app.packageId}</strong>
              <span>{statusLabel(app.status)} - {app.packageVersion}</span>
            </div>
            <span className="mos-pill">{app.declaredVolumes.length} volume(s)</span>
            {app.declaredVolumes.length ? <ul>
              {app.declaredVolumes.map((volume) => <li key={volume.dockerVolume}><code>{volume.dockerVolume}</code></li>)}
            </ul> : null}
          </article>)}
        </div> : <p className="suite-meta">No app packages are installed yet.</p>}
      </section>

      <details className="suite-advanced suite-backup-advanced">
        <summary>Advanced details</summary>
        <dl>
          <dt>Suite Manager database</dt><dd><code>{inventory.contents.suiteManager.database.path}</code></dd>
          <dt>State directory</dt><dd><code>{inventory.contents.suiteManager.stateDir}</code></dd>
          <dt>Homepage config root</dt><dd><code>{inventory.contents.homepageConfig.path}</code></dd>
          <dt>Relationships</dt><dd>{inventory.relationships.statuses.map((item) => `${item.status}: ${item.count}`).join(', ') || 'None'}</dd>
        </dl>
        <h3>Homepage files</h3>
        <PathList items={inventory.contents.homepageConfig.files} />
        <h3>Caddy files</h3>
        <PathList items={inventory.contents.caddyFiles} />
      </details>
    </div> : null}
  </section>;
}
