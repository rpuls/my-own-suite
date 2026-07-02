import { useEffect, useId, useMemo, useState } from 'react';

import { Icon, Notice } from '../../components/ui';

type CatalogFeature = { body: string; title: string };
type CatalogLinkKey = 'docs' | 'repository' | 'website';
type CatalogMetadata = {
  complexity: { description: string; label: string; level: string };
  description: string;
  features: CatalogFeature[];
  links: Partial<Record<CatalogLinkKey, string>>;
  privacy: { notes: string[]; summary: string };
  related: string[];
  resourceHint: { description: string; label: string; level: string };
  screenshots: Array<{ alt: string; caption: string; src: string }>;
  tags: string[];
};

type AppPackageSummary = {
  catalog: CatalogMetadata;
  category: string | string[];
  health: { type: string | null; url: string | null } | null;
  homepage: { description: string; group: string; icon: string; name: string } | null;
  icon: string;
  iconUrl: string;
  instance: {
    config?: Array<{ fingerprint: string | null; generated: boolean; key: string; redactedLabel: string | null; secret: boolean; source: string; updatedAt: string; value?: unknown }>;
    enabled: boolean;
    guideState?: { completedAt: string | null; firstViewedAt: string | null; manifestDigest: string; skippedAt: string | null; status: 'not-started' | 'viewed' | 'completed' | 'skipped'; updatedAt: string } | null;
    id: string;
    installedAt: string;
    packageId: string;
    projections: Array<{ appliedDigest: string | null; content: unknown; digest: string; kind: string; status: string; updatedAt?: string }>;
    status: string;
    updatedAt?: string;
  } | null;
  id: string;
  installStatus: string;
  name: string;
  onboarding?: {
    sections?: Array<{
      actionLabel?: string;
      body?: string;
      choices?: Array<{ id: string; label: string; steps: string[] }>;
      id: string;
      steps?: string[];
      title: string;
      type: string;
      values?: Array<{ copy: boolean; label: string; qr: boolean; value: string }>;
    }>;
    steps: Array<{ body: string; title: string; type: string }>;
    summary?: string;
    title?: string;
  };
  routes: Array<{ host: string; port: number | null; service: string }>;
  services: Array<{ dockerfile: string | null; id: string; internalPort: number | null; volumes: string[] }>;
  setup: { fieldCount: number; fields: Array<{ default?: unknown; generated: boolean; id: string; label: string; required: boolean; secret: boolean; type: string }> };
  summary: string;
  validation: { errors: string[]; valid: boolean };
  version: string;
};

type InstallStep = {
  detail: string;
  id: 'prepare' | 'runtime' | 'homepage' | 'ready';
  label: string;
  status: 'complete' | 'failed' | 'pending' | 'running' | 'skipped';
};

const INSTALL_STEP_MIN_MS = 1000;

const CATEGORY_LABELS: Record<string, string> = {
  files: 'Files',
  office: 'Office',
  photos: 'Photos',
  security: 'Security',
  tools: 'Tools',
};

function categoryLabel(category: string) {
  return CATEGORY_LABELS[category] || category.replace(/-/gu, ' ').replace(/\b\w/gu, (match) => match.toUpperCase());
}

function primaryCategory(app: AppPackageSummary) {
  return Array.isArray(app.category) ? app.category[0] || 'apps' : app.category;
}

function homepageApplied(app: AppPackageSummary) {
  const projection = app.instance?.projections.find((item) => item.kind === 'homepage');
  return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
}

function runtimeApplied(app: AppPackageSummary) {
  const required = ['compose', 'caddy', 'health'];
  return required.every((kind) => {
    const projection = app.instance?.projections.find((item) => item.kind === kind);
    return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
  });
}

function healthFailed(app: AppPackageSummary) {
  return app.instance?.projections.some((item) => item.kind === 'health' && item.status === 'failed') === true;
}

function initialsFor(name: string) {
  const words = name.split(/\s+/u).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)).toUpperCase();
}

function baseHost() {
  if (typeof window === 'undefined') return 'mos.home';
  const host = window.location.hostname;
  return host.startsWith('home.') ? host.slice(5) : host;
}

function appUrl(app: AppPackageSummary) {
  const route = app.routes[0];
  if (!route?.host || typeof window === 'undefined') return '';
  return `${window.location.protocol}//${route.host}.${baseHost()}/`;
}

function hasGuide(app: AppPackageSummary) {
  return Boolean(app.onboarding && ((app.onboarding.sections?.length || 0) > 0 || app.onboarding.steps.length > 0));
}

function guideStatusLabel(app: AppPackageSummary) {
  const status = app.instance?.guideState?.status;
  if (status === 'completed') return 'Guide complete';
  if (status === 'skipped') return 'Setup guide';
  if (status === 'viewed') return 'Continue guide';
  return 'Setup guide';
}

function statusFor(app: AppPackageSummary) {
  if (!app.validation.valid) return { className: 'is-attention', label: 'Unavailable', tone: 'warning' };
  if (app.instance?.status === 'uninstalled') return { className: 'is-available', label: 'Uninstalled', tone: 'info' };
  if (app.instance?.status === 'disabled' || app.instance?.enabled === false) return { className: 'is-progress', label: 'Disabled', tone: 'info' };
  if (app.installStatus === 'failed' || app.instance?.status === 'failed' || healthFailed(app)) return { className: 'is-attention', label: 'Needs attention', tone: 'error' };
  if (runtimeApplied(app)) return { className: 'is-ready', label: 'Running', tone: 'success' };
  if (app.installStatus === 'installed') return { className: 'is-progress', label: 'Finishing setup', tone: 'info' };
  return { className: 'is-available', label: 'Available', tone: 'info' };
}

function setupLabel(app: AppPackageSummary) {
  if (app.setup.fieldCount === 0) return 'No setup needed';
  if (app.setup.fields.every((field) => field.generated)) return 'MOS generates setup';
  if (app.setup.fields.some((field) => field.required && !field.generated)) return 'Needs your input';
  return `${app.setup.fieldCount} setup field${app.setup.fieldCount === 1 ? '' : 's'}`;
}

function setupFieldsNeedInput(app: AppPackageSummary) {
  return app.setup.fields.filter((field) => !field.generated);
}

function initialSetupConfig(app: AppPackageSummary) {
  return Object.fromEntries(
    setupFieldsNeedInput(app).map((field) => [field.id, typeof field.default === 'string' ? field.default : '']),
  );
}

function requiredSetupMissing(app: AppPackageSummary, setupConfig: Record<string, string>) {
  return setupFieldsNeedInput(app).some((field) => field.required && !String(setupConfig[field.id] || '').trim());
}

function AppHealthIndicator({ app, ledVariant = false }: { app: AppPackageSummary; ledVariant?: boolean }) {
  const tooltipId = useId();
  const status = statusFor(app);
  const label = `${app.name}: ${status.label}`;
  if (ledVariant) {
    return <span aria-describedby={tooltipId} aria-label={label} className="suite-app-health-led-wrap" role="img" tabIndex={0}>
      <span aria-hidden="true" className={`suite-app-health-led ${status.className}`} />
      <span className="suite-app-health-tooltip" id={tooltipId} role="tooltip">{status.label}</span>
    </span>;
  }
  return <span className={`suite-app-health-indicator ${status.className}`}>{status.label}</span>;
}

function complexityLabel(app: AppPackageSummary) {
  return app.catalog.complexity.label || (app.catalog.complexity.level === 'guided' ? 'Guided setup' : app.catalog.complexity.level === 'advanced' ? 'Advanced' : 'Easy setup');
}

function resourceLabel(app: AppPackageSummary) {
  return app.catalog.resourceHint.label || (app.catalog.resourceHint.level ? `${app.catalog.resourceHint.level[0]!.toUpperCase()}${app.catalog.resourceHint.level.slice(1)} resources` : 'Resource use varies');
}

function descriptionFor(app: AppPackageSummary) {
  return app.catalog.description || app.homepage?.description || app.summary;
}

function powershellSingleQuote(value: string) {
  return `'${value.replace(/'/gu, "''")}'`;
}

function hypervHostsRepairCommand(packages: AppPackageSummary[]) {
  const hostBase = baseHost();
  const names = new Set([`home.${hostBase}`]);
  for (const app of packages) {
    for (const route of app.routes) {
      if (route.host) names.add(`${route.host}.${hostBase}`);
    }
  }
  const hostsLiteral = `@(${[...names].sort().map(powershellSingleQuote).join(', ')})`;
  const homeHost = powershellSingleQuote(`home.${hostBase}`);

  return `$ErrorActionPreference='Stop'
$hostsPath="$env:SystemRoot\\System32\\drivers\\etc\\hosts"
$start='# BEGIN MOS V2 HYPERV USB SMOKE'
$end='# END MOS V2 HYPERV USB SMOKE'
$names=${hostsLiteral}
$home=${homeHost}
$ip=(Resolve-DnsName $home -Type A | Select-Object -First 1 -ExpandProperty IPAddress)
$content=Get-Content -Path $hostsPath
$next=New-Object System.Collections.Generic.List[string]
$inside=$false
foreach ($line in $content) {
  if ($line -eq $start) { $inside=$true; continue }
  if ($line -eq $end) { $inside=$false; continue }
  if ($inside) { continue }
  $matches=$false
  foreach ($name in $names) {
    if ($line -match "^\\s*\\S+\\s+$([regex]::Escape($name))(\\s|$)") { $matches=$true; break }
  }
  if (-not $matches) { $next.Add($line) }
}
$next.Add($start)
foreach ($name in $names) { $next.Add("$ip $name") }
$next.Add($end)
Set-Content -Path $hostsPath -Value $next -Encoding ASCII
ipconfig /flushdns`;
}

function defaultInstallSteps(showOnHomepage = true): InstallStep[] {
  return [
    { detail: 'Saving the app choice and generating any safe defaults.', id: 'prepare', label: 'Preparing app', status: 'pending' },
    { detail: 'Building and starting the app through the MOS runtime agent.', id: 'runtime', label: 'Starting app', status: 'pending' },
    ...(showOnHomepage ? [{
      detail: showOnHomepage ? 'Adding a clean shortcut to your private Homepage.' : 'Leaving Homepage unchanged for now.',
      id: 'homepage',
      label: 'Homepage shortcut',
      status: 'pending',
    } satisfies InstallStep] : []),
    { detail: 'The app is ready to open.', id: 'ready', label: 'Ready', status: 'pending' },
  ];
}

function setStep(steps: InstallStep[], id: InstallStep['id'], status: InstallStep['status']) {
  return steps.map((step) => (step.id === id ? { ...step, status } : step));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function withMinimumInstallStep<T>(work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    const remaining = INSTALL_STEP_MIN_MS - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  }
}

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : fallback);
  return body;
}

function InstallProgress({ error, steps }: { error: string; steps: InstallStep[] }) {
  if (!steps.length) return null;
  return <div className="suite-app-install-progress" role="status" aria-live="polite">
    <ol>
      {steps.map((step) => <li className={`is-${step.status}`} key={step.id}>
        <span className="suite-app-step-dot" aria-hidden="true" />
        <span><strong>{step.label}</strong><small>{step.detail}</small></span>
      </li>)}
    </ol>
    {error ? <Notice title="Install needs attention" variant="error"><p>{error}</p></Notice> : null}
  </div>;
}

function resolveGuideValue(app: AppPackageSummary, value: string) {
  const config = new Map((app.instance?.config || [])
    .filter((item) => !item.secret)
    .map((item) => [item.key, String(item.value ?? '')]));
  return value
    .replace(/\$\{app\.publicUrl\}/gu, appUrl(app))
    .replace(/\$\{config\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => config.get(key) || match);
}

function AppGuidePanel({
  app,
  onClose,
  onStatus,
  updating,
}: {
  app: AppPackageSummary;
  onClose: () => void;
  onStatus: (status: 'completed' | 'skipped') => void;
  updating: boolean;
}) {
  const [copied, setCopied] = useState('');
  const [choiceBySection, setChoiceBySection] = useState<Record<string, string>>({});
  const sections = app.onboarding?.sections?.length ? app.onboarding.sections : [{
    id: 'legacy-steps',
    steps: app.onboarding?.steps.map((step) => `${step.title}: ${step.body}`) || [],
    title: 'After install',
    type: 'steps',
  }];
  const status = app.instance?.guideState?.status || 'not-started';

  async function copyValue(key: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? '' : current)), 1400);
  }

  return <aside aria-label={`${app.name} setup guide`} className="suite-app-guide-panel">
    <header className="suite-app-guide-header">
      <div>
        <span className="mos-eyebrow">Setup guide</span>
        <h3>{app.onboarding?.title || `Set up ${app.name}`}</h3>
        {app.onboarding?.summary ? <p>{app.onboarding.summary}</p> : null}
      </div>
      <button aria-label="Close setup guide" className="suite-icon-button" onClick={onClose} type="button"><Icon name="x" /></button>
    </header>

    <div className="suite-app-guide-scroll">
      {status === 'completed' ? <Notice title="Guide marked complete" variant="success"><p>You can reopen it any time from this app detail view.</p></Notice> : null}
      {status === 'skipped' ? <Notice title="Guide skipped for now" variant="info"><p>The guide stays available here when you need it.</p></Notice> : null}

      {sections.map((section) => {
        if (section.type === 'values') {
          return <section className="suite-app-guide-section" key={section.id}>
            <h4>{section.title}</h4>
            <div className="suite-app-guide-values">
              {(section.values || []).map((item) => {
                const value = resolveGuideValue(app, item.value);
                const key = `${section.id}-${item.label}`;
                return <div className="suite-app-guide-value" key={key}>
                  <span>{item.label}</span>
                  <code>{value}</code>
                  {item.copy ? <button className="mos-btn mos-btn-secondary" onClick={() => void copyValue(key, value)} type="button">{copied === key ? 'Copied' : 'Copy'}</button> : null}
                </div>;
              })}
            </div>
          </section>;
        }
        if (section.type === 'choice-guide') {
          const choices = section.choices || [];
          const selectedId = choiceBySection[section.id] || choices[0]?.id || '';
          const selected = choices.find((choice) => choice.id === selectedId) || choices[0];
          return <section className="suite-app-guide-section" key={section.id}>
            <h4>{section.title}</h4>
            <div className="suite-app-guide-choice-tabs">
              {choices.map((choice) => <button aria-pressed={choice.id === selected?.id} key={choice.id} onClick={() => setChoiceBySection((current) => ({ ...current, [section.id]: choice.id }))} type="button">{choice.label}</button>)}
            </div>
            {selected ? <ol className="suite-app-guide-steps">{selected.steps.map((step) => <li key={step}>{step}</li>)}</ol> : null}
          </section>;
        }
        if (section.type === 'manual-complete') {
          return <section className="suite-app-guide-section" key={section.id}>
            <h4>{section.title}</h4>
            {section.body ? <p>{section.body}</p> : null}
            <button className="mos-btn mos-btn-primary" disabled={updating} onClick={() => onStatus('completed')} type="button">{section.actionLabel || 'Mark guide complete'}</button>
          </section>;
        }
        return <section className={`suite-app-guide-section is-${section.type}`} key={section.id}>
          <h4>{section.title}</h4>
          {section.body ? <p>{section.body}</p> : null}
          {section.steps?.length ? <ol className="suite-app-guide-steps">{section.steps.map((step) => <li key={step}>{step}</li>)}</ol> : null}
        </section>;
      })}
      {status !== 'completed' ? <div className="suite-app-guide-end-actions">
        <button className="mos-btn mos-btn-secondary" disabled={updating} onClick={() => onStatus('skipped')} type="button">Skip for now</button>
      </div> : null}
    </div>
  </aside>;
}

function AdvancedDetails({ app }: { app: AppPackageSummary }) {
  const projections = app.instance?.projections || [];
  return <details className="suite-advanced suite-app-advanced">
    <summary>Advanced details</summary>
    <dl>
      <dt>Package id</dt><dd>{app.id}</dd>
      <dt>Version</dt><dd>{app.version}</dd>
      <dt>Service</dt><dd>{app.services.map((service) => `${service.id}:${service.internalPort ?? '?'}`).join(', ') || 'None'}</dd>
      <dt>Route</dt><dd>{app.routes.map((route) => `${route.host} -> ${route.service}:${route.port ?? '?'}`).join(', ') || 'None'}</dd>
      <dt>Volumes</dt><dd>{app.services.flatMap((service) => service.volumes).join(', ') || 'None'}</dd>
      <dt>Health</dt><dd>{app.health ? `${app.health.type}: ${app.health.url}` : 'None'}</dd>
      <dt>Projections</dt><dd>{projections.length ? projections.map((projection) => `${projection.kind}: ${projection.status}`).join(', ') : 'Rendered during install'}</dd>
      {app.instance?.config?.length ? <><dt>Config</dt><dd>{app.instance.config.map((item) => `${item.key}: ${item.secret ? item.redactedLabel || 'secret stored' : item.value}`).join(', ')}</dd></> : null}
    </dl>
  </details>;
}

function AppIcon({ app, large = false }: { app: AppPackageSummary; large?: boolean }) {
  return <span className={`suite-app-icon${large ? ' suite-app-icon-large' : ''}`} aria-hidden="true">
    {app.iconUrl ? <img alt="" src={app.iconUrl} /> : <span>{initialsFor(app.name)}</span>}
  </span>;
}

function AppCard({ app, onOpen }: { app: AppPackageSummary; onOpen: (app: AppPackageSummary) => void }) {
  return <article className="suite-app-card">
    <button className="suite-app-card-main" onClick={() => onOpen(app)} type="button">
      <AppIcon app={app} />
      <span className="suite-app-card-copy">
        <span className="suite-app-title-row">
          <strong>{app.name}</strong>
          <span className="suite-app-category-pill">{categoryLabel(primaryCategory(app))}</span>
        </span>
        <span>{descriptionFor(app)}</span>
      </span>
    </button>
    <div className="suite-app-card-actions">
      <AppHealthIndicator app={app} ledVariant />
      <button className="mos-btn mos-btn-primary" onClick={() => onOpen(app)} type="button">View</button>
    </div>
  </article>;
}

function AppDetail({
  app,
  installing,
  installError,
  installSteps,
  onClose,
  onInstall,
  onLifecycle,
  onRefresh,
  onGuideStatus,
  onSelect,
  packages,
  refreshing,
  guideUpdating,
}: {
  app: AppPackageSummary;
  installing: boolean;
  installError: string;
  installSteps: InstallStep[];
  onClose: () => void;
  onInstall: (app: AppPackageSummary, options?: { config?: Record<string, string>; showOnHomepage?: boolean }) => void;
  onLifecycle: (app: AppPackageSummary, action: 'disable' | 'enable' | 'uninstall') => void;
  onRefresh: (app: AppPackageSummary) => void;
  onGuideStatus: (app: AppPackageSummary, status: 'viewed' | 'completed' | 'skipped') => void;
  onSelect: (app: AppPackageSummary) => void;
  packages: AppPackageSummary[];
  refreshing: boolean;
  guideUpdating: boolean;
}) {
  const [showOnHomepage, setShowOnHomepage] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [setupConfig, setSetupConfig] = useState<Record<string, string>>(() => initialSetupConfig(app));
  const ready = runtimeApplied(app);
  const disabled = app.instance?.status === 'disabled' || app.instance?.enabled === false;
  const uninstalled = app.instance?.status === 'uninstalled';
  const url = appUrl(app);
  const guideCompleted = app.instance?.guideState?.status === 'completed';
  const inputFields = setupFieldsNeedInput(app);
  const needsPreparation = !app.instance && inputFields.length > 0;
  const relatedIds = app.catalog.related.length
    ? app.catalog.related
    : packages.filter((item) => primaryCategory(item) === primaryCategory(app) && item.id !== app.id).slice(0, 3).map((item) => item.id);
  const related = relatedIds.map((id) => packages.find((item) => item.id === id)).filter(Boolean) as AppPackageSummary[];
  const canInstall = app.validation.valid && !requiredSetupMissing(app, setupConfig) && !installing;

  useEffect(() => {
    setShowOnHomepage(true);
    setSetupOpen(false);
    setGuideOpen(false);
    setActionsOpen(false);
    setSetupConfig(initialSetupConfig(app));
  }, [app.id]);

  function submitInstall() {
    const config = { ...setupConfig };
    onInstall(app, { config, showOnHomepage });
    setSetupConfig((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => {
      const field = app.setup.fields.find((item) => item.id === key);
      return [key, field?.secret ? '' : value];
    })));
  }

  function openGuide() {
    setGuideOpen(true);
    setActionsOpen(false);
    if (!app.instance?.guideState || app.instance.guideState.status === 'not-started') {
      onGuideStatus(app, 'viewed');
    }
  }

  function runMenuAction(action: () => void) {
    setActionsOpen(false);
    action();
  }

  const canRefreshRuntime = Boolean(app.instance && !disabled && !uninstalled);
  const hasMaintenanceActions = Boolean(canRefreshRuntime || ready || (app.instance && !uninstalled) || (ready && hasGuide(app) && guideCompleted));

  return <div className={`suite-app-detail-layer${guideOpen ? ' has-guide' : ''}`}>
    <button aria-label="Close app details" className="suite-app-detail-backdrop" onClick={onClose} tabIndex={-1} type="button" />
    {guideOpen && hasGuide(app) ? <AppGuidePanel app={app} onClose={() => setGuideOpen(false)} onStatus={(status) => onGuideStatus(app, status)} updating={guideUpdating} /> : null}
    <aside aria-label={`${app.name} details`} aria-modal="true" className="suite-app-detail" role="dialog">
      <header className="suite-app-detail-hero">
        <button aria-label="Close app details" className="suite-icon-button suite-app-detail-close" onClick={onClose} type="button"><Icon name="x" /></button>
        <AppIcon app={app} large />
        <div className="suite-app-detail-heading">
          <div className="suite-app-detail-title-row">
            <h2>{app.name}</h2>
            <AppHealthIndicator app={app} />
          </div>
          <p>{descriptionFor(app)}</p>
        </div>
        <div className="suite-app-primary-actions">
          {ready ? <a className="mos-btn mos-btn-primary" href={url}>Open {app.name}</a> : disabled ? <button className="mos-btn mos-btn-primary" disabled={installing} onClick={() => onLifecycle(app, 'enable')} type="button">{installing ? 'Enabling...' : 'Enable'}</button> : needsPreparation && !setupOpen ? <button className="mos-btn mos-btn-primary" disabled={!app.validation.valid || uninstalled || installing} onClick={() => setSetupOpen(true)} type="button">Prepare</button> : <button className="mos-btn mos-btn-primary" disabled={!canInstall || uninstalled} onClick={submitInstall} type="button">{installing ? 'Installing...' : 'Install'}</button>}
          {ready && hasGuide(app) && !guideCompleted ? <button className="mos-btn mos-btn-secondary" disabled={guideUpdating} onClick={openGuide} type="button">{guideStatusLabel(app)}</button> : null}
          {hasMaintenanceActions ? <div className="suite-app-actions-menu">
            <button aria-expanded={actionsOpen} aria-haspopup="menu" aria-label="More app actions" className="suite-icon-button" disabled={installing || guideUpdating} onClick={() => setActionsOpen((current) => !current)} title="More app actions" type="button"><Icon name="more" /></button>
            {actionsOpen ? <div className="suite-app-actions-popover" role="menu">
              {ready && hasGuide(app) && guideCompleted ? <button onClick={() => runMenuAction(openGuide)} role="menuitem" type="button">Setup guide</button> : null}
              {canRefreshRuntime ? <button disabled={refreshing} onClick={() => runMenuAction(() => onRefresh(app))} role="menuitem" type="button">{refreshing ? 'Checking status...' : 'Refresh status'}</button> : null}
              {ready ? <button onClick={() => runMenuAction(() => onLifecycle(app, 'disable'))} role="menuitem" type="button">Disable</button> : null}
              {app.instance && !uninstalled ? <button onClick={() => runMenuAction(() => onLifecycle(app, 'uninstall'))} role="menuitem" type="button">Uninstall</button> : null}
            </div> : null}
          </div> : null}
          {!ready && !disabled && !uninstalled ? <label className="suite-app-homepage-option">
            <input checked={showOnHomepage} disabled={installing} onChange={(event) => setShowOnHomepage(event.currentTarget.checked)} type="checkbox" />
            <span>Add shortcut to Homepage</span>
          </label> : null}
          {setupOpen && needsPreparation ? <div className="suite-app-setup-panel">
            {inputFields.map((field) => <label key={field.id}>
              <span>{field.label}{field.required ? ' *' : ''}</span>
              <input
                autoComplete={field.secret ? 'new-password' : 'off'}
                disabled={installing}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setSetupConfig((current) => ({ ...current, [field.id]: value }));
                }}
                type={field.secret ? 'password' : field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
                value={setupConfig[field.id] || ''}
              />
            </label>)}
          </div> : null}
        </div>
      </header>

      <div className="suite-app-detail-scroll">
        <InstallProgress error={installError} steps={installSteps} />

        {!app.validation.valid ? <Notice title="This package cannot be installed yet" variant="warning"><ul>{app.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul></Notice> : null}

        <section className="suite-app-facts" aria-label="App facts">
          <div><span>Category</span><strong>{categoryLabel(primaryCategory(app))}</strong></div>
          <div><span>Setup</span><strong>{setupLabel(app)}</strong></div>
          <div><span>Complexity</span><strong>{complexityLabel(app)}</strong></div>
          <div><span>Resources</span><strong>{resourceLabel(app)}</strong></div>
        </section>

        {app.catalog.features.length ? <section className="suite-app-detail-section">
          <h3>Best For</h3>
          <div className="suite-app-feature-grid">
            {app.catalog.features.map((feature) => <article key={feature.title}>
              <strong>{feature.title}</strong>
              {feature.body ? <p>{feature.body}</p> : null}
            </article>)}
          </div>
        </section> : null}

        <section className="suite-app-detail-section">
          <h3>Setup</h3>
          {app.setup.fieldCount === 0 ? <p className="suite-meta">This app does not need extra setup before MOS starts it.</p> : <div className="suite-app-setup-list">
            {app.setup.fields.map((field) => <div key={field.id}>
              <strong>{field.label}</strong>
              <span>{field.generated ? 'Generated and stored by MOS' : field.required ? 'Required before install' : field.default !== undefined ? 'Default provided' : 'Optional'}</span>
            </div>)}
          </div>}
          {app.onboarding?.steps.length ? <div className="suite-app-next-steps">
            <h4>After install</h4>
            {app.onboarding.steps.map((step) => <article key={`${step.type}-${step.title}`}>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
            </article>)}
          </div> : null}
        </section>

        {app.catalog.privacy.summary || app.catalog.privacy.notes.length ? <section className="suite-app-detail-section suite-app-privacy">
          <h3>Privacy Notes</h3>
          {app.catalog.privacy.summary ? <p>{app.catalog.privacy.summary}</p> : null}
          {app.catalog.privacy.notes.length ? <ul>{app.catalog.privacy.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
        </section> : null}

        {(Object.keys(app.catalog.links).length || related.length) ? <section className="suite-app-detail-section">
          <h3>Links And Related Apps</h3>
          {Object.keys(app.catalog.links).length ? <div className="suite-app-link-row">
            {Object.entries(app.catalog.links).map(([key, href]) => <a className="mos-btn mos-btn-secondary" href={href} key={key} rel="noreferrer" target="_blank">{key === 'repository' ? 'Repository' : key === 'website' ? 'Website' : 'Docs'}</a>)}
          </div> : null}
          {related.length ? <div className="suite-app-related-list">{related.map((item) => <button key={item.id} onClick={() => onSelect(item)} type="button"><AppIcon app={item} /><span><strong>{item.name}</strong><small>{descriptionFor(item)}</small></span></button>)}</div> : null}
        </section> : null}

        <AdvancedDetails app={app} />
      </div>
    </aside>
  </div>;
}

export function AppsScreen() {
  const [packages, setPackages] = useState<AppPackageSummary[]>([]);
  const [error, setError] = useState('');
  const [installError, setInstallError] = useState('');
  const [installSteps, setInstallSteps] = useState<InstallStep[]>([]);
  const [installingId, setInstallingId] = useState('');
  const [guideUpdatingId, setGuideUpdatingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [refreshingId, setRefreshingId] = useState('');
  const [selectedId, setSelectedId] = useState('');

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

  const selected = packages.find((app) => app.id === selectedId) || null;
  const hostsRepairCommand = useMemo(() => hypervHostsRepairCommand(packages), [packages]);

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
        app.catalog.complexity.label,
        app.catalog.resourceHint.label,
        ...app.catalog.tags,
        ...app.catalog.features.flatMap((feature) => [feature.title, feature.body]),
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [packages, query]);

  async function performInstall(app: AppPackageSummary, options: { config?: Record<string, string>; showOnHomepage?: boolean } = {}) {
    const setupConfig = options.config || {};
    const canInstall = app.validation.valid && !requiredSetupMissing(app, setupConfig);
    if (!canInstall) return;
    const showOnHomepage = options.showOnHomepage !== false;
    setSelectedId(app.id);
    setInstallingId(app.id);
    setInstallError('');
    setInstallSteps(defaultInstallSteps(showOnHomepage));

    let current = app;
    try {
      if (current.installStatus !== 'installed') {
        setInstallSteps((steps) => setStep(steps, 'prepare', 'running'));
        const installed = await withMinimumInstallStep(async () =>
          jsonResponse<{ instance: AppPackageSummary['instance'] }>(
            await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(current.id)}/install`, {
              body: JSON.stringify({ config: setupConfig }),
              headers: { 'Content-Type': 'application/json' },
              method: 'POST',
            }),
            `Unable to prepare ${current.name}.`,
          ),
        );
        current = { ...current, installStatus: 'installed', instance: installed.instance };
        setInstallSteps((steps) => setStep(steps, 'prepare', 'complete'));
      } else {
        setInstallSteps((steps) => setStep(steps, 'prepare', 'running'));
        await withMinimumInstallStep(async () => undefined);
        setInstallSteps((steps) => setStep(steps, 'prepare', 'skipped'));
      }

      if (!runtimeApplied(current)) {
        setInstallSteps((steps) => setStep(steps, 'runtime', 'running'));
        const applied = await withMinimumInstallStep(async () =>
          jsonResponse<{ instance: AppPackageSummary['instance'] }>(
            await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(current.id)}/apply-runtime`, { method: 'POST' }),
            `Unable to start ${current.name}.`,
          ),
        );
        current = { ...current, instance: applied.instance };
        setInstallSteps((steps) => setStep(steps, 'runtime', 'complete'));
      } else {
        setInstallSteps((steps) => setStep(steps, 'runtime', 'running'));
        await withMinimumInstallStep(async () => undefined);
        setInstallSteps((steps) => setStep(steps, 'runtime', 'skipped'));
      }

      if (showOnHomepage && !homepageApplied(current)) {
        setInstallSteps((steps) => setStep(steps, 'homepage', 'running'));
        const homepage = await withMinimumInstallStep(async () =>
          jsonResponse<{ instance: AppPackageSummary['instance'] }>(
            await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(current.id)}/add-to-homepage`, { method: 'POST' }),
            `Unable to add ${current.name} to Homepage.`,
          ),
        );
        current = { ...current, instance: homepage.instance };
        setInstallSteps((steps) => setStep(steps, 'homepage', 'complete'));
      } else if (showOnHomepage) {
        setInstallSteps((steps) => setStep(steps, 'homepage', 'running'));
        await withMinimumInstallStep(async () => undefined);
        setInstallSteps((steps) => setStep(steps, 'homepage', 'skipped'));
      }

      setInstallSteps((steps) => setStep(steps, 'ready', 'running'));
      await withMinimumInstallStep(async () => undefined);
      setInstallSteps((steps) => setStep(steps, 'ready', 'complete'));
      await load();
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : `Unable to install ${app.name}.`);
      setInstallSteps((steps) => {
        const running = steps.find((step) => step.status === 'running');
        return running ? setStep(steps, running.id, 'failed') : steps;
      });
      await load();
    } finally {
      setInstallingId('');
    }
  }

  async function performLifecycle(app: AppPackageSummary, action: 'disable' | 'enable' | 'uninstall') {
    if (!app.instance || installingId) return;
    const labels = { disable: 'Disable', enable: 'Enable', uninstall: 'Uninstall' };
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
          `Unable to ${action} ${app.name}.`,
        ),
      );
      setInstallSteps((steps) => setStep(steps, 'runtime', 'complete'));
      await load();
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : `Unable to ${action} ${app.name}.`);
      setInstallSteps((steps) => setStep(steps, 'runtime', 'failed'));
      await load();
    } finally {
      setInstallingId('');
    }
  }

  async function refreshRuntimeStatus(app: AppPackageSummary) {
    if (!app.instance || refreshingId) return;
    setSelectedId(app.id);
    setRefreshingId(app.id);
    setInstallError('');
    try {
      await jsonResponse<{ instance: AppPackageSummary['instance'] }>(
        await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/refresh-runtime-status`, { method: 'POST' }),
        `Unable to refresh ${app.name}.`,
      );
      await load();
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : `Unable to refresh ${app.name}.`);
      await load();
    } finally {
      setRefreshingId('');
    }
  }

  async function updateGuideStatus(app: AppPackageSummary, status: 'viewed' | 'completed' | 'skipped') {
    if (!app.instance || guideUpdatingId) return;
    setGuideUpdatingId(app.id);
    try {
      await jsonResponse<{ instance: AppPackageSummary['instance'] }>(
        await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/guide`, {
          body: JSON.stringify({ status }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
        `Unable to update ${app.name} setup guide.`,
      );
      await load();
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : `Unable to update ${app.name} setup guide.`);
      await load();
    } finally {
      setGuideUpdatingId('');
    }
  }

  return <section className="mos-shell suite-apps suite-app-catalog">
    <div className="suite-app-simple-header">
      <h1>Apps</h1>
    </div>

    <div className="suite-app-search">
      <input aria-label="Search apps" onChange={(event) => setQuery(event.target.value)} placeholder="Search apps..." value={query} />
    </div>

    {error ? <Notice title="Apps unavailable" variant="error"><p>{error}</p></Notice> : null}
    {loading ? <p className="suite-meta">Loading app catalog...</p> : null}

    {!loading && !error && filtered.length === 0 ? <div className="suite-app-empty">
      <h2>No apps match that search</h2>
      <p>Try the app name or the thing you want to solve, like passwords, PDFs, files, photos, security, or office documents.</p>
    </div> : null}

    {!loading && !error && filtered.length ? <div className="suite-app-grid">
      {filtered.map((app) => <AppCard app={app} key={app.id} onOpen={(target) => { setSelectedId(target.id); setInstallError(''); setInstallSteps([]); }} />)}
    </div> : null}

    {!loading && !error && packages.length ? <details className="suite-advanced suite-app-advanced">
      <summary>Advanced details</summary>
      <dl>
        <dt>Hyper-V hosts repair</dt>
        <dd><pre>{hostsRepairCommand}</pre></dd>
      </dl>
    </details> : null}

    {selected ? <AppDetail app={selected} guideUpdating={guideUpdatingId === selected.id} installing={installingId === selected.id} installError={installError} installSteps={installingId === selected.id || installError ? installSteps : []} onClose={() => { setSelectedId(''); setInstallError(''); setInstallSteps([]); }} onGuideStatus={(target, status) => void updateGuideStatus(target, status)} onInstall={(target, options) => void performInstall(target, options)} onLifecycle={(target, action) => void performLifecycle(target, action)} onRefresh={(target) => void refreshRuntimeStatus(target)} onSelect={(target) => { setSelectedId(target.id); setInstallError(''); setInstallSteps([]); }} packages={packages} refreshing={refreshingId === selected.id} /> : null}
  </section>;
}
