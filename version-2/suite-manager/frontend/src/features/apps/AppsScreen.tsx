import { useEffect, useState } from 'react';

import { Notice } from '../../components/ui';

type AppPackageSummary = {
  category: string;
  health: { type: string | null; url: string | null } | null;
  homepage: { description: string; group: string; icon: string; name: string } | null;
  icon: string;
  instance: {
    enabled: boolean;
    id: string;
    installedAt: string;
    packageId: string;
    projections: Array<{ appliedDigest: string | null; content: unknown; digest: string; kind: string; status: string }>;
    status: string;
  } | null;
  id: string;
  installStatus: string;
  name: string;
  routes: Array<{ host: string; port: number | null; service: string }>;
  services: Array<{ dockerfile: string | null; id: string; internalPort: number | null; volumes: string[] }>;
  setup: { fieldCount: number; fields: Array<{ id: string; label: string; required: boolean; secret: boolean; type: string }> };
  summary: string;
  validation: { errors: string[]; valid: boolean };
  version: string;
};

function homepageApplied(app: AppPackageSummary) {
  const projection = app.instance?.projections.find((item) => item.kind === 'homepage');
  return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
}

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : fallback);
  return body;
}

function PackageDetails({ app }: { app: AppPackageSummary }) {
  const projections = app.instance?.projections || [];
  return <details className="suite-app-package-details">
    <summary>Package details</summary>
    <dl>
      <dt>Service</dt>
      <dd>{app.services.map((service) => `${service.id}:${service.internalPort ?? '?'}`).join(', ') || 'None'}</dd>
      <dt>Route</dt>
      <dd>{app.routes.map((route) => `${route.host} -> ${route.service}:${route.port ?? '?'}`).join(', ') || 'None'}</dd>
      <dt>Homepage</dt>
      <dd>{app.homepage ? `${app.homepage.group} / ${app.homepage.name}` : 'None'}</dd>
      <dt>Volumes</dt>
      <dd>{app.services.flatMap((service) => service.volumes).join(', ') || 'None'}</dd>
      <dt>Health</dt>
      <dd>{app.health ? `${app.health.type}: ${app.health.url}` : 'None'}</dd>
      <dt>Setup</dt>
      <dd>{app.setup.fieldCount === 0 ? 'No setup inputs required' : `${app.setup.fieldCount} setup input${app.setup.fieldCount === 1 ? '' : 's'}`}</dd>
      <dt>Projections</dt>
      <dd>{projections.length ? projections.map((projection) => `${projection.kind}: ${projection.status}`).join(', ') : 'Rendered after logical install'}</dd>
    </dl>
  </details>;
}

export function AppsScreen() {
  const [packages, setPackages] = useState<AppPackageSummary[]>([]);
  const [addingHomepageId, setAddingHomepageId] = useState('');
  const [error, setError] = useState('');
  const [installingId, setInstallingId] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const result = await jsonResponse<{ packages: AppPackageSummary[] }>(
        await fetch('/suite-manager/api/apps/packages'),
        'Unable to load app packages.',
      );
      setPackages(result.packages);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load app packages.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function install(app: AppPackageSummary) {
    if (!app.validation.valid || app.installStatus !== 'not-installed') return;
    setInstallingId(app.id);
    setError('');
    try {
      await jsonResponse<{ instance: AppPackageSummary['instance'] }>(
        await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/install`, { method: 'POST' }),
        `Unable to install ${app.name}.`,
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to install ${app.name}.`);
    } finally {
      setInstallingId('');
    }
  }

  async function addToHomepage(app: AppPackageSummary) {
    if (app.installStatus !== 'installed' || homepageApplied(app)) return;
    setAddingHomepageId(app.id);
    setError('');
    try {
      await jsonResponse<{ instance: AppPackageSummary['instance'] }>(
        await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/add-to-homepage`, { method: 'POST' }),
        `Unable to add ${app.name} to Homepage.`,
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to add ${app.name} to Homepage.`);
    } finally {
      setAddingHomepageId('');
    }
  }

  return <section className="mos-shell suite-apps">
    <div className="suite-hero">
      <span className="mos-pill mos-pill-accent">App packages</span>
      <h1>Apps</h1>
      <p className="suite-lead mos-body-lg">A temporary package visibility surface for the V2 app lifecycle work.</p>
    </div>

    {error ? <Notice title="Apps unavailable" variant="error"><p>{error}</p></Notice> : null}
    {loading ? <p className="suite-meta">Loading app packages...</p> : null}

    {!loading && !error ? <div className="suite-app-package-grid">
      {packages.map((app) => <article className="mos-panel suite-card suite-app-package-card" key={app.id}>
        <div className="suite-app-package-header">
          <div>
            <span className="suite-app-package-icon">{app.icon || app.id.slice(0, 2).toUpperCase()}</span>
          </div>
          <div>
            <p className="suite-meta mos-meta">{app.category}</p>
            <h2 className="mos-card-title">{app.name}</h2>
            <p>{app.summary}</p>
          </div>
        </div>

        <div className="suite-app-package-badges">
          <span className={app.validation.valid ? 'is-ready' : 'is-invalid'}>{app.validation.valid ? 'Package ready' : 'Invalid manifest'}</span>
          <span className={app.installStatus === 'installed' ? 'is-installed' : ''}>{app.installStatus === 'installed' ? 'Installed' : 'Not installed'}</span>
          {homepageApplied(app) ? <span className="is-installed">On Homepage</span> : null}
          <span>{app.setup.fieldCount === 0 ? 'No setup needed' : `${app.setup.fieldCount} setup fields`}</span>
        </div>

        {!app.validation.valid ? <Notice title="Manifest needs work" variant="warning">
          <ul>{app.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>
        </Notice> : null}

        <PackageDetails app={app} />

        {app.installStatus === 'installed'
          ? <div className="suite-app-package-actions">
            <button className="mos-btn mos-btn-primary" disabled={homepageApplied(app) || addingHomepageId === app.id} onClick={() => void addToHomepage(app)} type="button">{homepageApplied(app) ? 'Added to Homepage' : addingHomepageId === app.id ? 'Adding...' : 'Add to Homepage'}</button>
            <button className="mos-btn mos-btn-secondary" disabled type="button">Disable coming next</button>
          </div>
          : <button className="mos-btn mos-btn-primary" disabled={!app.validation.valid || installingId === app.id} onClick={() => void install(app)} type="button">{installingId === app.id ? 'Installing...' : 'Install logically'}</button>}
      </article>)}
    </div> : null}
  </section>;
}
