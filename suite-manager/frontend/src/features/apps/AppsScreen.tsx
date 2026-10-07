import { useEffect, useMemo, useState } from 'react';

import { AdvancedPanel, Notice } from '../../components/ui';
import { requiredSetupMissing } from './AppConfigDialog';
import { setStep } from './ProgressSteps';
import type { Owner } from '../setup/types';
import { jsonResponse, postJson } from '../../lib/api';
import { appSourceLabel } from '../../lib/app-sources';
import { AppCard } from './AppCard';
import { AppDetail } from './AppDetail';
import { ExternalAppCard, ExternalAppDetail } from './ExternalApp';
import { catalogFacts, categoryLabel, hasHomepageContribution, installJobError, installJobSteps, isCompanionApp, primaryCategory, repoUrlFromQuery, withMinimumInstallStep } from './model';
import type { AppPackageSummary, CatalogStatus, ExternalCard, ExternalResolveResponse, ExternalSourceCoordinates, InstallStep } from './types';

export function AppsScreen({ owner }: { owner: Owner }) {
  const [packages, setPackages] = useState<AppPackageSummary[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);
  const [connectingId, setConnectingId] = useState('');
  const [error, setError] = useState('');
  const [installError, setInstallError] = useState('');
  const [installSteps, setInstallSteps] = useState<InstallStep[]>([]);
  const [installingId, setInstallingId] = useState('');
  const [guideUpdatingId, setGuideUpdatingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [externalResolved, setExternalResolved] = useState<ExternalResolveResponse | null>(null);
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState('');
  // Which of a source's packages the owner has opened, by namespaced id — a
  // repository may publish several.
  const [externalOpenId, setExternalOpenId] = useState('');
  const [externalInstalling, setExternalInstalling] = useState(false);
  const [externalInstallError, setExternalInstallError] = useState('');
  const [externalAdding, setExternalAdding] = useState(false);
  const [externalAddError, setExternalAddError] = useState('');

  // Silent loads run in the background: they never flash the loading state and
  // never replace a working catalog view with a transient fetch error. A silent
  // success still clears an earlier error, so a page that failed to load once
  // recovers on its own.
  async function load({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const result = await jsonResponse<{ catalog: CatalogStatus; packages: AppPackageSummary[] }>(
        await fetch('/suite-manager/api/apps/packages'),
        'Unable to load app packages.',
      );
      setPackages(result.packages);
      setCatalogStatus(result.catalog);
      setError('');
    } catch (caught) {
      if (!silent) setError(caught instanceof Error ? caught.message : 'Unable to load app packages.');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // Fetches the current app list from GitHub in the background and folds it in.
  async function refreshCatalog() {
    try {
      const response = await fetch('/suite-manager/api/apps/catalog/refresh', { method: 'POST' });
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string; status?: CatalogStatus };
      if (body.status) setCatalogStatus(body.status);
      if (!response.ok) throw new Error(`${body.code || 'CATALOG_FETCH_FAILED'}: ${body.error || 'app catalog refresh failed'}`);
      console.debug('[apps] app catalog checked:', body.status?.fetchedAt, body.status?.revision);
      await load({ silent: true });
    } catch (caught) {
      console.warn('[apps] could not refresh the app catalog:', caught instanceof Error ? caught.message : caught);
    }
  }

  useEffect(() => {
    void (async () => {
      await load();
      await refreshCatalog();
    })();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load({ silent: true });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const jobRunning = packages.some((app) => app.installJob?.status === 'running' || app.updateJob?.status === 'running');
  useEffect(() => {
    if (!jobRunning) return undefined;
    const timer = window.setTimeout(() => void load({ silent: true }), 1500);
    return () => window.clearTimeout(timer);
  }, [jobRunning, packages]);

  // The catalog and advisory feed are a convenience on top of the signed catalog
  // the release already ships, so a stale or failed fetch goes to the console
  // rather than interrupting normal users with a banner.
  useEffect(() => {
    if (!catalogStatus) return;
    if (catalogStatus.freshness === 'stale' || catalogStatus.error) {
      console.warn('[apps] official catalog refresh is not fresh:', {
        error: catalogStatus.error?.code || null,
        fetchedAt: catalogStatus.fetchedAt,
        freshness: catalogStatus.freshness,
        message: catalogStatus.error?.message || null,
        revision: catalogStatus.revision,
      });
    }
    if (catalogStatus.advisories && (catalogStatus.advisories.freshness !== 'fresh' || catalogStatus.advisories.error)) {
      console.warn('[apps] privacy advisories are not fresh:', catalogStatus.advisories.error?.code || catalogStatus.advisories.freshness, catalogStatus.advisories.error?.message || '');
    }
  }, [catalogStatus]);

  const externalUrl = useMemo(() => repoUrlFromQuery(query), [query]);

  // Paste-a-URL flow: when the search box holds a repository URL, resolve it into
  // an unverified external preview card. Debounced, cancel-safe, and never
  // persists anything; clearing the URL removes the card entirely.
  useEffect(() => {
    if (!externalUrl) {
      setExternalResolved(null);
      setExternalError('');
      setExternalLoading(false);
      setExternalOpenId('');
      return undefined;
    }
    let cancelled = false;
    setExternalLoading(true);
    setExternalError('');
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await postJson<ExternalResolveResponse>('/suite-manager/api/apps/sources/resolve', { url: externalUrl }, 'That URL does not point to a valid MOS app package.');
          if (!cancelled) setExternalResolved(result);
        } catch (caught) {
          if (!cancelled) {
            setExternalResolved(null);
            setExternalError(caught instanceof Error ? caught.message : 'That URL does not point to a valid MOS app package.');
          }
        } finally {
          if (!cancelled) setExternalLoading(false);
        }
      })();
    }, 450);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [externalUrl]);

  const selected = packages.find((app) => app.id === selectedId) || null;
  const externalOpenCard = externalResolved?.packages.find((card) => card.id === externalOpenId) || null;

  // Register the pasted repository as an added source. Nothing is installed: the
  // source's apps join the catalog list, and the owner installs from there whenever
  // they like. Managing and removing added sources lives in Settings.
  async function addExternalSource(repository: string) {
    setExternalAdding(true);
    setExternalAddError('');
    try {
      await postJson<{ source: unknown }>('/suite-manager/api/apps/sources', { repository }, 'Unable to add that app source.');
      // Clearing the query drops the preview and shows the ordinary catalog, which
      // now includes this source's apps.
      setQuery('');
      await load();
    } catch (caught) {
      setExternalAddError(caught instanceof Error ? caught.message : 'Unable to add that app source.');
    } finally {
      setExternalAdding(false);
    }
  }

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return packages.filter((app) => {
      if (!normalizedQuery) return true;
      const haystack = [
        app.name,
        app.summary,
        Array.isArray(app.category) ? app.category.join(' ') : app.category,
        categoryLabel(primaryCategory(app)),
        app.homepage?.description || '',
        app.catalog.description,
        app.catalog.privacy.summary,
        app.catalog.resourceHint.label,
        // Owners search for what they are leaving behind ("dropbox", "lastpass")
        // more readily than for an app they have never heard of.
        ...app.catalog.replaces,
        ...app.catalog.tags,
        ...app.catalog.features.flatMap((feature) => [feature.title, feature.body]),
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [packages, query]);

  // Installing a pasted repository is the only point where an external package
  // is persisted. The backend re-resolves and re-validates the URL, so what is
  // installed is whatever passes the gate right now rather than the previewed
  // card. Once it is installed it is an ordinary app instance under its
  // namespaced id, so the normal install flow finishes runtime and Homepage.
  async function performExternalInstall(card: ExternalCard, source: ExternalSourceCoordinates, config: Record<string, string> = {}) {
    if (!card.validation.valid || card.packageErrors.length) return;
    setExternalInstalling(true);
    setExternalInstallError('');
    try {
      // Naming the package is what makes a repository publishing several of them
      // installable: the backend refuses to choose on the owner's behalf.
      const installed = await postJson<{ packageId: string }>(
        '/suite-manager/api/apps/sources/install',
        { config, packageId: card.id, url: source.repository },
        `Unable to install ${card.name}.`,
      );
      const refreshed = await jsonResponse<{ catalog: CatalogStatus; packages: AppPackageSummary[] }>(
        await fetch('/suite-manager/api/apps/packages'),
        'Unable to load app packages.',
      );
      setPackages(refreshed.packages);
      setCatalogStatus(refreshed.catalog);
      const app = refreshed.packages.find((item) => item.id === installed.packageId);
      setExternalOpenId('');
      setQuery('');
      // Forward the collected setup values: the package is installed by now, but
      // performInstall still needs them to pass its required-field check before
      // it applies the runtime. Without them it returns silently and the app
      // never starts.
      if (app) await performInstall(app, { config });
    } catch (caught) {
      setExternalInstallError(caught instanceof Error ? caught.message : `Unable to install ${card.name}.`);
    } finally {
      setExternalInstalling(false);
    }
  }

  async function performInstall(app: AppPackageSummary, options: { config?: Record<string, string>; showOnHomepage?: boolean } = {}) {
    const setupConfig = options.config || {};
    const canInstall = app.validation.valid && !app.packageErrors?.length && !requiredSetupMissing(app, setupConfig);
    if (!canInstall) return;
    const showOnHomepage = hasHomepageContribution(app) && options.showOnHomepage !== false;
    setSelectedId(app.id);
    setInstallingId(app.id);
    setInstallError('');
    setInstallSteps([]);
    try {
      // An app offered by one of the owner's added sources is not in the reviewed
      // catalog, so it is first fetched through the external gate. After that it
      // is an ordinary instance under its namespaced id and installs like any other.
      const external = app.installStatus !== 'installed' && app.external && app.source ? app.source : null;
      if (external) {
        await postJson('/suite-manager/api/apps/sources/install', { config: setupConfig, packageId: app.id, url: external.repository }, `Unable to prepare ${app.name}.`);
      }
      await postJson(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/install-job`, { config: setupConfig, showOnHomepage }, `Unable to install ${app.name}.`);
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : `Unable to install ${app.name}.`);
    } finally {
      await load({ silent: true });
      setInstallingId('');
    }
  }

  async function performLifecycle(app: AppPackageSummary, action: 'enable' | 'restart' | 'stop' | 'uninstall') {
    if (!app.instance || installingId) return;
    const labels = { enable: 'Start', restart: 'Restart', stop: 'Stop', uninstall: 'Uninstall' };
    setSelectedId(app.id);
    setInstallingId(app.id);
    setInstallError('');
    setInstallSteps([
      { detail: `${labels[action]} ${app.name}.`, id: 'runtime', label: labels[action], status: 'running' },
    ]);
    try {
      await withMinimumInstallStep(async () =>
        jsonResponse<{ instance: AppPackageSummary['instance'] }>(
          await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/${action}`, { method: 'POST' }),
          `Unable to ${labels[action].toLowerCase()} ${app.name}.`,
        ),
      );
      setInstallSteps((steps) => setStep(steps, 'runtime', 'complete'));
      await load();
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : `Unable to ${labels[action].toLowerCase()} ${app.name}.`);
      setInstallSteps((steps) => setStep(steps, 'runtime', 'failed'));
      await load();
    } finally {
      setInstallingId('');
    }
  }

  async function connectPackages(connection: NonNullable<AppPackageSummary['compatibility']>['connections'][number]) {
    if (connectingId || installingId) return;
    const operationId = `${connection.consumerPackageId}:${connection.provider.id}:${connection.slotId}:${connection.capabilityId}`;
    setSelectedId(connection.consumerPackageId);
    setConnectingId(operationId);
    setInstallError('');
    setInstallSteps([
      { detail: `Connecting ${connection.provider.name}.`, id: 'runtime', label: 'Connecting apps', status: 'running' },
    ]);
    try {
      await withMinimumInstallStep(async () =>
        postJson<{ instance: AppPackageSummary['instance'] }>('/suite-manager/api/apps/integrations/connect', {
          consumerPackageId: connection.consumerPackageId,
          providerCapabilityId: connection.capabilityId,
          providerPackageId: connection.provider.id,
          slotId: connection.slotId,
        }, 'Unable to connect these apps.'),
      );
      setInstallSteps((steps) => setStep(steps, 'runtime', 'complete'));
      await load();
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : 'Unable to connect these apps.');
      setInstallSteps((steps) => setStep(steps, 'runtime', 'failed'));
      await load();
    } finally {
      setConnectingId('');
    }
  }

  async function updateGuideStatus(app: AppPackageSummary, status: 'viewed' | 'completed' | 'skipped') {
    if (!app.instance || guideUpdatingId) return;
    setGuideUpdatingId(app.id);
    try {
      await postJson<{ instance: AppPackageSummary['instance'] }>(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/guide`, { status }, `Unable to update ${app.name} setup guide.`);
      await load();
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : `Unable to update ${app.name} setup guide.`);
      await load();
    } finally {
      setGuideUpdatingId('');
    }
  }

  // Apps an added source offers get their own section per source, so "these came
  // from a repository you added" is told by where a card sits rather than by a badge
  // on every one of them. An installed external app is one of the owner's apps and
  // belongs in the sections above with the rest: the source section is about what a
  // source is *offering*, which is also why removing a source empties it without
  // touching anything installed.
  const offered = filtered.filter((app) => app.source && !app.instance);
  const own = filtered.filter((app) => !(app.source && !app.instance));
  const standaloneApps = own.filter((app) => !isCompanionApp(app));
  const companionApps = own.filter(isCompanionApp);
  const sourceSections = offered.reduce<Array<{ apps: AppPackageSummary[]; repository: string; title: string }>>((sections, app) => {
    const repository = app.source!.repository;
    const existing = sections.find((section) => section.repository === repository);
    if (existing) existing.apps.push(app);
    else sections.push({ apps: [app], repository, title: app.source!.publisher || appSourceLabel(repository) });
    return sections;
  }, []);

  return <section className="mos-shell mos-page">
    <div className="suite-app-simple-header">
      <h1>Apps</h1>
    </div>

    <div className="suite-app-search">
      <input aria-label="Search apps" onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or what you want to do..." value={query} />
    </div>

    {error ? <Notice title="Apps unavailable" variant="error"><p>{error}</p></Notice> : null}
    {loading && !externalUrl ? <p className="suite-meta">Loading app catalog...</p> : null}

    {externalUrl ? <div className="suite-app-catalog-sections">
      <section className="suite-app-catalog-section">
        <div className="suite-app-section-heading">
          <h2>{externalResolved && externalResolved.packages.length > 1
            ? `${externalResolved.packages.length} apps from ${appSourceLabel(externalResolved.source.repository)}`
            : 'External package'}</h2>
          {/* Adding is what makes a catalog browsable later without pasting the URL
              again. It is offered only once the repository has actually resolved,
              and only while it is not already added. */}
          {externalResolved && !externalResolved.added ? <button className="mos-btn mos-btn-secondary" disabled={externalAdding} onClick={() => void addExternalSource(externalResolved.source.repository)} type="button">
            {externalAdding ? 'Adding...' : 'Add this source'}
          </button> : null}
        </div>
        {externalLoading ? <p className="suite-meta">Checking that repository for MOS app packages...</p> : null}
        {externalError && !externalLoading ? <Notice title="No app package found at that URL" variant="warning"><p>{externalError}</p></Notice> : null}
        {externalAddError ? <Notice title="This source could not be added" variant="warning"><p>{externalAddError}</p></Notice> : null}
        {externalResolved?.added ? <p className="suite-meta">You have already added this source, so its apps are listed with your catalog below.</p> : null}
        {externalResolved && !externalLoading ? <div className="suite-app-grid">
          {externalResolved.packages.map((card) => <ExternalAppCard card={card} key={card.id} onOpen={() => setExternalOpenId(card.id)} />)}
        </div> : null}
        {!externalLoading && !externalError && !externalResolved ? <p className="suite-meta">Paste a public GitHub repository that publishes MOS app packages in a <code>.mos</code> folder at its root &mdash; one app, or a catalog of them.</p> : null}
      </section>
    </div> : null}

    {!externalUrl && !loading && !error && filtered.length === 0 ? <div className="suite-app-empty">
      <h2>No apps match that search</h2>
      <p>Try the app name or the thing you want to solve, like passwords, PDFs, files, photos, security, or office documents.</p>
    </div> : null}

    {!externalUrl && !loading && !error && filtered.length ? <div className="suite-app-catalog-sections">
      {standaloneApps.length ? <section className="suite-app-catalog-section">
        <div className="suite-app-section-heading"><h2>Apps</h2></div>
        <div className="suite-app-grid">
          {standaloneApps.map((app) => <AppCard app={app} key={app.id} onOpen={(target) => { setSelectedId(target.id); setInstallError(''); setInstallSteps([]); }} />)}
        </div>
      </section> : null}
      {companionApps.length ? <section className="suite-app-catalog-section">
        <div className="suite-app-section-heading"><h2>Companion apps</h2></div>
        <div className="suite-app-grid">
          {companionApps.map((app) => <AppCard app={app} key={app.id} onOpen={(target) => { setSelectedId(target.id); setInstallError(''); setInstallSteps([]); }} />)}
        </div>
      </section> : null}
      {sourceSections.map((section) => <section className="suite-app-catalog-section" key={section.repository}>
        <div className="suite-app-section-heading">
          <h2>{section.title}</h2>
          <p className="suite-meta">A source you added. MOS has not reviewed these apps. Manage it in Settings.</p>
        </div>
        <div className="suite-app-grid">
          {section.apps.map((app) => <AppCard app={app} key={app.id} onOpen={(target) => { setSelectedId(target.id); setInstallError(''); setInstallSteps([]); }} />)}
        </div>
      </section>)}
    </div> : null}

    {catalogStatus && !externalUrl ? <AdvancedPanel facts={catalogFacts(catalogStatus)} reveal="technical-mode" summary="App catalog">
      {catalogStatus.error
        ? <p>{catalogStatus.error.message}</p>
        : <p>This list is the published catalog folded together with the app packages this MOS version shipped with; whichever offers the newer version of an app wins.</p>}
      {catalogStatus.error ? <p>Apps still update from the packages this MOS version shipped with, so nothing here is broken — but app versions published since are not known to this server.</p> : null}
    </AdvancedPanel> : null}

    {externalOpenCard && externalResolved ? <ExternalAppDetail
      card={externalOpenCard}
      installError={externalInstallError}
      installing={externalInstalling}
      onClose={() => setExternalOpenId('')}
      onInstall={(card, config) => { void performExternalInstall(card, externalResolved.source, config); }}
      owner={owner}
      source={externalResolved.source}
    /> : null}

    {selected ? <AppDetail app={selected} connectingId={connectingId} guideUpdating={guideUpdatingId === selected.id} installing={installingId === selected.id || connectingId.startsWith(`${selected.id}:`) || selected.installJob?.status === 'running'} installError={installError || installJobError(selected)} installSteps={installJobSteps(selected).length ? installJobSteps(selected) : installingId === selected.id || connectingId.startsWith(`${selected.id}:`) || installError ? installSteps : []} onClose={() => { setSelectedId(''); setInstallError(''); setInstallSteps([]); }} onConnect={(connection) => void connectPackages(connection)} onGuideStatus={(target, status) => void updateGuideStatus(target, status)} onInstall={(target, options) => void performInstall(target, options)} onLifecycle={(target, action) => void performLifecycle(target, action)} onSelect={(target) => { setSelectedId(target.id); setInstallError(''); setInstallSteps([]); }} onUpdated={() => load()} owner={owner} packages={packages} /> : null}
  </section>;
}
