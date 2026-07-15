import { useEffect, useId, useMemo, useState } from 'react';

import { Dialog, Icon, Notice, TextInput } from '../../components/ui';
import { PrivacyChangeRow, PrivacyFactsTile, PrivacyPostureDialog } from './PrivacyPosture';
import type { PrivacyAdvisory, PrivacyReviewSummary } from './privacy-posture';
import type { Owner } from '../setup/types';

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
type CatalogStatus = { error: { code: string; message: string } | null; fetchedAt: string | null; freshness: 'fresh' | 'stale' | 'unavailable'; repository: string; revision: string | null };
type CatalogUpdate = {
  available: { compatibility: 'compatible' | 'requires-platform-update'; minimumMosVersion: string; packageDigest: string; packageVersion: string; privacy: { status: string }; sourceRevision: string } | null;
  installed: { packageDigest: string; packageVersion: string } | null;
  status: 'current' | 'installable' | 'installed-newer' | 'integrity-error' | 'not-in-catalog' | 'unavailable' | 'update-available';
};
type UpdateComparison = {
  candidate: { packageVersion: string; privacy: PrivacyReviewSummary };
  changes: Array<{ area: string; classification: string; summary: string }>;
  compatibility: 'compatible' | 'owner-action-required' | 'unsupported' | 'unresolved';
  installed: { packageVersion: string; privacy: PrivacyReviewSummary };
  metadata: { backupRequired: boolean; downtime: string; migrations: string[]; ownerActions: string[]; rollback: string };
  requiredInput: Array<{ id: string; label: string; secret: boolean; type: string }>;
  validation: { agentCapability: string; errors: string[] };
};

type AppPackageSummary = {
  capabilities: {
    exports: Array<{ features: Record<string, unknown>; id: string; implementation: string; interfaceVersion: number | null; protocol: string; title: string; type: string }>;
    integrations: Array<{ accepts: Array<{ interfaceVersion: number | null; protocol: string; type: string }>; id: string; providerLabel: string; title: string }>;
    usefulness: { emptyState: string; requiresOneOf: string[] };
  };
  catalog: CatalogMetadata;
  catalogUpdate: CatalogUpdate | null;
  category: string | string[];
  compatibility?: {
    connections: Array<{
      actionLabel: string;
      capabilityId: string;
      consumerPackageId: string;
      provider: { id: string; installStatus: string; name: string; runtimeState: string };
      ready: boolean;
      relationship: { id: string; lastErrorCode: string | null; status: string; updatedAt: string } | null;
      slotId: string;
      title: string;
    }>;
    missingUsefulPeers: Array<{ message: string; type: string }>;
  };
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
    packageVersion: string;
    projections: Array<{ appliedDigest: string | null; content: unknown; digest: string; kind: string; status: string; updatedAt?: string }>;
    status: string;
    updateRecovery?: { errorCode: string; state: 'retry-safe' | 'rollback-required' | 'commit-required' } | null;
    updatedAt?: string;
  } | null;
  advisories?: PrivacyAdvisory[];
  id: string;
  installStatus: string;
  name: string;
  privacy: PrivacyReviewSummary;
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
  role: 'standalone' | 'companion' | 'capability-provider' | 'integration-helper' | string;
  services: Array<{ dockerfile: string | null; id: string; internalPort: number | null; volumes: string[] }>;
  setup: { fieldCount: number; fields: Array<{ default?: unknown; generated: boolean; id: string; label: string; required: boolean; secret: boolean; type: string }> };
  summary: string;
  validation: { errors: string[]; valid: boolean };
  version: string;
};

// A pasted repository URL resolves to an unverified external package preview.
// The card reuses the public package summary shape, plus explicit external/trust
// flags and the package's own inlined icon; nothing is persisted by resolving.
type ExternalCard = Pick<AppPackageSummary,
  'capabilities' | 'catalog' | 'category' | 'health' | 'homepage' | 'icon' | 'id' | 'name' | 'role' | 'routes' | 'services' | 'setup' | 'summary' | 'validation' | 'version'> & {
  external: true;
  iconDataUrl: string | null;
  iconUrl: string;
  installStatus: string;
  minimumMosVersion: string;
  mosReviewed: false;
  trust: string;
};
type ExternalSourceCoordinates = { catalogPath: string; kind: string; packageId: string; repository: string; revision: string; trust: string };
type ExternalResolveResponse = {
  card: ExternalCard;
  instanceId: string;
  packageDigest: string;
  permissions: string[];
  source: ExternalSourceCoordinates;
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

function hasHomepageContribution(app: AppPackageSummary) {
  return Boolean(app.homepage);
}

function isCompanionApp(app: AppPackageSummary) {
  return app.role === 'companion' || app.role === 'capability-provider' || app.role === 'integration-helper';
}

function hasPrimaryAppDestination(app: AppPackageSummary) {
  return !isCompanionApp(app) && app.routes.length > 0;
}

function runtimeApplied(app: AppPackageSummary) {
  const required = ['compose', 'caddy', 'health'];
  return required.every((kind) => {
    const projection = app.instance?.projections.find((item) => item.kind === kind);
    return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
  });
}

function runtimeRouteApplied(app: AppPackageSummary) {
  const required = ['compose', 'caddy'];
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
  if (app.instance?.status === 'disabled' || app.instance?.enabled === false) return { className: 'is-progress', label: 'Stopped', tone: 'info' };
  if (app.installStatus === 'failed' || app.instance?.status === 'failed' || healthFailed(app)) return { className: 'is-attention', label: 'Needs attention', tone: 'error' };
  if (runtimeApplied(app)) return { className: 'is-ready', label: 'Running', tone: 'success' };
  if (app.installStatus === 'installed') return { className: 'is-progress', label: 'Finishing setup', tone: 'info' };
  return { className: 'is-available', label: 'Available', tone: 'info' };
}

function setupFieldsNeedInput(app: AppPackageSummary) {
  return app.setup.fields.filter((field) => !field.generated);
}

function initialSetupConfig(app: AppPackageSummary, ownerEmail: string) {
  return Object.fromEntries(
    setupFieldsNeedInput(app).map((field) => [
      field.id,
      typeof field.default === 'string' ? field.default : field.type === 'email' ? ownerEmail : '',
    ]),
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
          {app.catalogUpdate?.status === 'update-available' ? <span className="suite-app-update-pill">Update available</span> : null}
          {app.catalogUpdate?.status === 'integrity-error' ? <span className="suite-app-update-pill is-warning">Catalog conflict</span> : null}
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
  connectingId,
  installing,
  installError,
  installSteps,
  onClose,
  onInstall,
  onLifecycle,
  onConnect,
  onGuideStatus,
  onSelect,
  packages,
  guideUpdating,
  owner,
}: {
  app: AppPackageSummary;
  connectingId: string;
  installing: boolean;
  installError: string;
  installSteps: InstallStep[];
  onClose: () => void;
  onInstall: (app: AppPackageSummary, options?: { config?: Record<string, string>; showOnHomepage?: boolean }) => void;
  onLifecycle: (app: AppPackageSummary, action: 'enable' | 'restart' | 'stop' | 'uninstall') => void;
  onConnect: (connection: NonNullable<AppPackageSummary['compatibility']>['connections'][number]) => void;
  onGuideStatus: (app: AppPackageSummary, status: 'viewed' | 'completed' | 'skipped') => void;
  onSelect: (app: AppPackageSummary) => void;
  packages: AppPackageSummary[];
  guideUpdating: boolean;
  owner: Owner;
}) {
  const [showOnHomepage, setShowOnHomepage] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [setupConfig, setSetupConfig] = useState<Record<string, string>>(() => initialSetupConfig(app, owner.email));
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [comparison, setComparison] = useState<UpdateComparison | null>(null);
  const [comparisonError, setComparisonError] = useState('');
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [updateInput, setUpdateInput] = useState<Record<string, string>>({});
  const ready = runtimeApplied(app);
  const homepageAvailable = hasHomepageContribution(app);
  const primaryDestination = hasPrimaryAppDestination(app);
  const uninstalled = app.instance?.status === 'uninstalled';
  const disabled = !uninstalled && (app.instance?.status === 'disabled' || app.instance?.enabled === false);
  const url = appUrl(app);
  const guideCompleted = app.instance?.guideState?.status === 'completed';
  const inputFields = setupFieldsNeedInput(app);
  const needsPreparation = !app.instance && inputFields.length > 0;
  const relatedIds = app.catalog.related.length
    ? app.catalog.related
    : packages.filter((item) => primaryCategory(item) === primaryCategory(app) && item.id !== app.id).slice(0, 3).map((item) => item.id);
  const related = relatedIds.map((id) => packages.find((item) => item.id === id)).filter(Boolean) as AppPackageSummary[];
  const canInstall = app.validation.valid && !requiredSetupMissing(app, setupConfig) && !installing;
  const connections = app.compatibility?.connections || [];
  const missingUsefulPeers = app.compatibility?.missingUsefulPeers || [];
  const installedCompatiblePeers = packages.filter((item) => item.id !== app.id && item.instance && item.capabilities.exports.some((capability) => app.capabilities.usefulness.requiresOneOf.includes(capability.type)));

  useEffect(() => {
    setShowOnHomepage(hasHomepageContribution(app));
    setSetupOpen(false);
    setGuideOpen(false);
    setActionsOpen(false);
    setSetupConfig(initialSetupConfig(app, owner.email));
    setPrivacyOpen(false);
    setComparison(null);
    setComparisonError('');
    setUpdateInput({});
  }, [app.id, owner.email]);

  async function prepareUpdate() {
    setComparisonLoading(true);
    setComparisonError('');
    try {
      const result = await jsonResponse<{ comparison: UpdateComparison }>(await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/prepare-update`, { method: 'POST' }), `Unable to prepare the ${app.name} update.`);
      setComparison(result.comparison);
      setUpdateInput({});
    } catch (caught) { setComparisonError(caught instanceof Error ? caught.message : 'Unable to prepare this update.'); }
    finally { setComparisonLoading(false); }
  }

  function submitInstall() {
    const config = { ...setupConfig };
    onInstall(app, { config, showOnHomepage: homepageAvailable && showOnHomepage });
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

  const canRestartRuntime = Boolean(runtimeRouteApplied(app) && !disabled && !uninstalled);
  const hasMaintenanceActions = Boolean(canRestartRuntime || ready || disabled || (app.instance && !uninstalled) || (ready && hasGuide(app) && guideCompleted));

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
          {ready && primaryDestination ? <a className="mos-btn mos-btn-primary" href={url}>Open {app.name}</a> : ready && isCompanionApp(app) && installedCompatiblePeers.length ? <button className="mos-btn mos-btn-primary" onClick={() => onSelect(installedCompatiblePeers[0]!)} type="button">View compatible app</button> : ready && isCompanionApp(app) ? <button className="mos-btn mos-btn-primary" disabled type="button">Install compatible app</button> : disabled ? <button className="mos-btn mos-btn-primary" disabled={installing} onClick={() => onLifecycle(app, 'enable')} type="button">{installing ? 'Starting...' : 'Start'}</button> : needsPreparation && !setupOpen ? <button className="mos-btn mos-btn-primary" disabled={!app.validation.valid || uninstalled || installing} onClick={() => setSetupOpen(true)} type="button">Prepare</button> : <button className="mos-btn mos-btn-primary" disabled={!canInstall || uninstalled} onClick={submitInstall} type="button">{installing ? 'Installing...' : 'Install'}</button>}
          {ready && hasGuide(app) && !guideCompleted ? <button className="mos-btn mos-btn-secondary" disabled={guideUpdating} onClick={openGuide} type="button">{guideStatusLabel(app)}</button> : null}
          {hasMaintenanceActions ? <div className="suite-app-actions-menu">
            <button aria-expanded={actionsOpen} aria-haspopup="menu" aria-label="More app actions" className="suite-icon-button" disabled={installing || guideUpdating} onClick={() => setActionsOpen((current) => !current)} title="More app actions" type="button"><Icon name="more" /></button>
            {actionsOpen ? <div className="suite-app-actions-popover" role="menu">
              {ready && hasGuide(app) && guideCompleted ? <button onClick={() => runMenuAction(openGuide)} role="menuitem" type="button">Setup guide</button> : null}
              {canRestartRuntime ? <button onClick={() => runMenuAction(() => onLifecycle(app, 'restart'))} role="menuitem" type="button">Restart</button> : null}
              {ready ? <button onClick={() => runMenuAction(() => onLifecycle(app, 'stop'))} role="menuitem" type="button">Stop</button> : null}
              {disabled ? <button onClick={() => runMenuAction(() => onLifecycle(app, 'enable'))} role="menuitem" type="button">Start</button> : null}
              {app.instance && !uninstalled ? <button onClick={() => runMenuAction(() => onLifecycle(app, 'uninstall'))} role="menuitem" type="button">Uninstall</button> : null}
            </div> : null}
          </div> : null}
          {homepageAvailable && !ready && !disabled && !uninstalled ? <label className="suite-app-homepage-option">
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
      {app.instance?.updateRecovery ? <Notice title="App update needs attention" variant="warning"><p>{app.instance.updateRecovery.state === 'retry-safe' ? 'The update stopped before changing the running app. Review the latest candidate and try again.' : app.instance.updateRecovery.state === 'rollback-required' ? 'The update stopped after changing runtime state. Restore the installed app runtime before retrying.' : 'The package snapshot was promoted before Suite Manager committed its identity. Complete package recovery before another update.'}</p><details className="suite-advanced"><summary>Advanced details</summary><code>{app.instance.updateRecovery.errorCode}</code></details></Notice> : null}

      <div className="suite-app-detail-scroll">
        <InstallProgress error={installError} steps={installSteps} />

        {!app.validation.valid ? <Notice title="This package cannot be installed yet" variant="warning"><ul>{app.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul></Notice> : null}
        {missingUsefulPeers.length ? <Notice title="Needs a compatible app" variant="info"><p>{missingUsefulPeers[0]!.message}</p></Notice> : null}
        {ready && isCompanionApp(app) && !installedCompatiblePeers.length ? <Notice title="Companion app" variant="info"><p>{app.capabilities.usefulness.emptyState || 'Install a compatible app to use this service.'}</p></Notice> : null}
        {app.catalogUpdate?.status === 'integrity-error' ? <Notice title="Catalog integrity conflict" variant="warning"><p>The catalog advertises different package contents under the installed version number. MOS will not treat this as an update.</p></Notice> : null}

        {app.catalogUpdate?.status === 'update-available' && app.catalogUpdate.available ? <section className="suite-app-update-summary">
          <div><span>Installed</span><strong>{app.catalogUpdate.installed?.packageVersion}</strong></div>
          <div><span>Available</span><strong>{app.catalogUpdate.available.packageVersion}</strong></div>
          <div><span>Compatibility</span><strong>{app.catalogUpdate.available.compatibility === 'compatible' ? 'Ready for this MOS version' : `Requires MOS ${app.catalogUpdate.available.minimumMosVersion}`}</strong></div>
          <p>This candidate is visible for comparison only. Applying app updates will be added in the next implementation phase.</p>
          <button className="mos-btn mos-btn-secondary" disabled={comparisonLoading} onClick={() => void prepareUpdate()} type="button">{comparisonLoading ? 'Checking update...' : 'Review update'}</button>
          {comparisonError ? <p role="alert">{comparisonError}</p> : null}
        </section> : null}

        <section className="suite-app-facts" aria-label="App facts">
          <div><span>Category</span><strong>{categoryLabel(primaryCategory(app))}</strong></div>
          <PrivacyFactsTile advisories={app.advisories} onOpen={() => setPrivacyOpen(true)} privacy={app.privacy} />
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

        {connections.length ? <section className="suite-app-detail-section">
          <h3>Connections</h3>
          <div className="suite-app-related-list">
            {connections.map((connection) => {
              const status = connection.relationship?.status || (connection.provider.installStatus === 'not-installed' ? 'Install first' : connection.provider.runtimeState === 'running' ? 'Ready to connect' : 'Start both apps first');
              const busy = connectingId === `${connection.consumerPackageId}:${connection.provider.id}:${connection.slotId}:${connection.capabilityId}`;
              return <button disabled={!connection.ready || busy || installing} key={`${connection.provider.id}-${connection.slotId}-${connection.capabilityId}`} onClick={() => onConnect(connection)} type="button">
                <span><strong>{connection.title}</strong><small>{connection.provider.name} - {status}</small></span>
                <span>{busy ? 'Connecting...' : connection.ready ? connection.actionLabel : 'Unavailable'}</span>
              </button>;
            })}
          </div>
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
    {privacyOpen ? <PrivacyPostureDialog advisories={app.advisories} appName={app.name} onClose={() => setPrivacyOpen(false)} packageVersion={app.instance?.packageVersion || app.version} privacy={app.privacy} /> : null}
    {comparison ? <Dialog footer={<button className="mos-btn mos-btn-secondary" onClick={() => setComparison(null)} type="button">Close</button>} onClose={() => setComparison(null)} title={`Review ${app.name} update`}>
      <div className="suite-app-update-dialog">
        <Notice title={comparison.compatibility === 'unsupported' ? 'This update cannot be applied safely' : comparison.compatibility === 'owner-action-required' ? 'Your input is required' : 'Ready for confirmation'} variant={comparison.compatibility === 'unsupported' ? 'warning' : 'info'}>
          <p>Version {comparison.installed.packageVersion} to {comparison.candidate.packageVersion}.</p>
        </Notice>
        <PrivacyChangeRow candidate={comparison.candidate.privacy} candidateVersion={comparison.candidate.packageVersion} installed={comparison.installed.privacy} installedVersion={comparison.installed.packageVersion} />
        <dl><dt>Backup</dt><dd>{comparison.metadata.backupRequired ? 'Required' : 'Not declared as required'}</dd><dt>Downtime</dt><dd>{comparison.metadata.downtime}</dd><dt>Rollback</dt><dd>{comparison.metadata.rollback}</dd></dl>
        {comparison.changes.length ? <ul>{comparison.changes.map((change, index) => <li key={`${change.area}-${index}`}><strong>{change.area}</strong>: {change.summary}</li>)}</ul> : <p>No structural changes detected.</p>}
        {comparison.requiredInput.map((field) => <TextInput autoComplete={field.secret ? 'new-password' : 'off'} key={field.id} label={field.label} onChange={(event) => setUpdateInput((current) => ({ ...current, [field.id]: event.currentTarget.value }))} type={field.secret ? 'password' : field.type === 'email' ? 'email' : 'text'} value={updateInput[field.id] || ''} />)}
        {comparison.requiredInput.length ? <p className="suite-meta">These values remain in this dialog and are not sent until a future confirmed apply flow is implemented.</p> : null}
        <details className="suite-advanced"><summary>Advanced details</summary><pre>{JSON.stringify(comparison, null, 2)}</pre></details>
      </div>
    </Dialog> : null}
  </div>;
}

// A search query is treated as an external package source only when it is a full
// HTTPS repository URL (host plus at least owner/repo). The backend enforces the
// real host allowlist; this only avoids resolving on every ordinary keystroke.
function repoUrlFromQuery(raw: string): string | null {
  const value = raw.trim();
  if (!/^https:\/\//iu.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.includes('.')) return null;
    if (url.pathname.split('/').filter(Boolean).length < 2) return null;
    return value;
  } catch { return null; }
}

function externalDescription(card: ExternalCard) {
  return card.summary || card.homepage?.description || card.catalog.description || 'External MOS app package.';
}

// Plain-language explanation of one requested permission key so an owner can see
// exactly what an unverified package would be granted before installing it.
function permissionLabel(permission: string): { detail: string; label: string } {
  const separator = permission.indexOf(':');
  const kind = separator === -1 ? permission : permission.slice(0, separator);
  const value = separator === -1 ? '' : permission.slice(separator + 1);
  if (kind === 'route') return { detail: `Serves a web app at ${value}.${baseHost()} on your MOS.`, label: `Web address: ${value}` };
  if (kind === 'volume') return { detail: 'Reads and writes its own private, named storage volume.', label: `Storage: ${value}` };
  if (kind === 'integration') return { detail: 'Can connect to a compatible app you choose. Nothing connects automatically.', label: `Integration: ${value}` };
  if (permission === 'provides-capability') return { detail: 'Other installed apps can connect to this one.', label: 'Provides a capability to other apps' };
  return { detail: '', label: permission };
}

function ExternalAppIcon({ card, large = false }: { card: ExternalCard; large?: boolean }) {
  return <span className={`suite-app-icon${large ? ' suite-app-icon-large' : ''}`} aria-hidden="true">
    {card.iconDataUrl ? <img alt="" src={card.iconDataUrl} /> : <span>{initialsFor(card.name)}</span>}
  </span>;
}

function ExternalAppCard({ card, onOpen }: { card: ExternalCard; onOpen: () => void }) {
  return <article className="suite-app-card is-external">
    <button className="suite-app-card-main" onClick={onOpen} type="button">
      <ExternalAppIcon card={card} />
      <span className="suite-app-card-copy">
        <span className="suite-app-title-row">
          <strong>{card.name}</strong>
          <span className="suite-app-external-pill">External &middot; Unverified</span>
        </span>
        <span>{externalDescription(card)}</span>
      </span>
    </button>
    <div className="suite-app-card-actions">
      <button className="mos-btn mos-btn-primary" onClick={onOpen} type="button">View</button>
    </div>
  </article>;
}

function ExternalAppDetail({ onClose, resolved }: { onClose: () => void; resolved: ExternalResolveResponse }) {
  const { card, permissions, source } = resolved;
  return <div className="suite-app-detail-layer">
    <button aria-label="Close package details" className="suite-app-detail-backdrop" onClick={onClose} tabIndex={-1} type="button" />
    <aside aria-label={`${card.name} details`} aria-modal="true" className="suite-app-detail" role="dialog">
      <header className="suite-app-detail-hero">
        <button aria-label="Close package details" className="suite-icon-button suite-app-detail-close" onClick={onClose} type="button"><Icon name="x" /></button>
        <ExternalAppIcon card={card} large />
        <div className="suite-app-detail-heading">
          <div className="suite-app-detail-title-row">
            <h2>{card.name}</h2>
            <span className="suite-app-external-pill">External &middot; Unverified</span>
          </div>
          <p>{externalDescription(card)}</p>
        </div>
        <div className="suite-app-primary-actions">
          <button className="mos-btn mos-btn-primary" disabled type="button">Install</button>
          <p className="suite-meta">Installing external packages arrives in the next MOS update. You can review what this package would request below.</p>
        </div>
      </header>

      <div className="suite-app-detail-scroll">
        <Notice title="Unverified external package" variant="warning">
          <p>This package comes from a repository you pasted, not the verified MOS catalog. MOS has not reviewed its code or checked any privacy claims. If you install it later, it runs with a restricted profile: only its own named storage and the web addresses listed below &mdash; no privileged access, host folders, or Docker socket.</p>
        </Notice>

        {!card.validation.valid ? <Notice title="This package cannot be installed" variant="warning"><ul>{card.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul></Notice> : null}

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
          <div><span>Version</span><strong>{card.version || 'Unknown'}</strong></div>
          <div><span>Source</span><strong>GitHub</strong></div>
        </section>

        <details className="suite-advanced suite-app-advanced">
          <summary>Advanced details</summary>
          <dl>
            <dt>Repository</dt><dd>{source.repository}</dd>
            <dt>Revision</dt><dd><code>{source.revision.slice(0, 12)}</code></dd>
            <dt>Package id</dt><dd>{source.packageId}</dd>
            <dt>Package digest</dt><dd><code>{resolved.packageDigest}</code></dd>
            <dt>Services</dt><dd>{card.services.map((service) => `${service.id}:${service.internalPort ?? '?'}`).join(', ') || 'None'}</dd>
            <dt>Routes</dt><dd>{card.routes.map((route) => `${route.host} -> ${route.service}:${route.port ?? '?'}`).join(', ') || 'None'}</dd>
          </dl>
        </details>
      </div>
    </aside>
  </div>;
}

export function AppsScreen({ owner }: { owner: Owner }) {
  const [packages, setPackages] = useState<AppPackageSummary[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
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
  const [externalOpen, setExternalOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const result = await jsonResponse<{ catalog: CatalogStatus; packages: AppPackageSummary[] }>(
        await fetch('/suite-manager/api/apps/packages'),
        'Unable to load app packages.',
      );
      setPackages(result.packages);
      setCatalogStatus(result.catalog);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load app packages.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const externalUrl = useMemo(() => repoUrlFromQuery(query), [query]);

  // Paste-a-URL flow: when the search box holds a repository URL, resolve it into
  // an unverified external preview card. Debounced, cancel-safe, and never
  // persists anything; clearing the URL removes the card entirely.
  useEffect(() => {
    if (!externalUrl) {
      setExternalResolved(null);
      setExternalError('');
      setExternalLoading(false);
      setExternalOpen(false);
      return undefined;
    }
    let cancelled = false;
    setExternalLoading(true);
    setExternalError('');
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await jsonResponse<ExternalResolveResponse>(
            await fetch('/suite-manager/api/apps/sources/resolve', {
              body: JSON.stringify({ url: externalUrl }),
              headers: { 'Content-Type': 'application/json' },
              method: 'POST',
            }),
            'That URL does not point to a valid MOS app package.',
          );
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

  async function refreshCatalog() {
    setRefreshingCatalog(true);
    setError('');
    try {
      await jsonResponse(await fetch('/suite-manager/api/apps/catalog/refresh', { method: 'POST' }), 'Unable to refresh the app catalog.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to refresh the app catalog.');
    } finally { setRefreshingCatalog(false); }
  }

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
    const showOnHomepage = hasHomepageContribution(app) && options.showOnHomepage !== false;
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
        jsonResponse<{ instance: AppPackageSummary['instance'] }>(
          await fetch('/suite-manager/api/apps/integrations/connect', {
            body: JSON.stringify({
              consumerPackageId: connection.consumerPackageId,
              providerCapabilityId: connection.capabilityId,
              providerPackageId: connection.provider.id,
              slotId: connection.slotId,
            }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
          }),
          'Unable to connect these apps.',
        ),
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

  const standaloneApps = filtered.filter((app) => !isCompanionApp(app));
  const companionApps = filtered.filter(isCompanionApp);

  return <section className="mos-shell mos-page">
    <div className="suite-app-simple-header">
      <h1>Apps</h1>
      <button className="mos-btn mos-btn-secondary" disabled={refreshingCatalog} onClick={() => void refreshCatalog()} type="button">{refreshingCatalog ? 'Refreshing...' : 'Refresh catalog'}</button>
    </div>

    <div className="suite-app-search">
      <input aria-label="Search apps" onChange={(event) => setQuery(event.target.value)} placeholder="Search apps, or paste a GitHub repo URL..." value={query} />
    </div>

    {error ? <Notice title="Apps unavailable" variant="error"><p>{error}</p></Notice> : null}
    {catalogStatus?.freshness === 'stale' || catalogStatus?.error ? <Notice title="Using the saved app catalog" variant="warning"><p>MOS could not confirm the latest official catalog. Installed apps and the last verified catalog remain available.</p></Notice> : null}
    {loading && !externalUrl ? <p className="suite-meta">Loading app catalog...</p> : null}

    {externalUrl ? <div className="suite-app-catalog-sections">
      <section className="suite-app-catalog-section">
        <div className="suite-app-section-heading"><h2>External package</h2></div>
        {externalLoading ? <p className="suite-meta">Checking that repository for a MOS app package...</p> : null}
        {externalError && !externalLoading ? <Notice title="No app package found at that URL" variant="warning"><p>{externalError}</p></Notice> : null}
        {externalResolved && !externalLoading ? <div className="suite-app-grid">
          <ExternalAppCard card={externalResolved.card} onOpen={() => setExternalOpen(true)} />
        </div> : null}
        {!externalLoading && !externalError && !externalResolved ? <p className="suite-meta">Paste a public GitHub repository that publishes a MOS app package in a <code>.mos</code> folder at its root.</p> : null}
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
    </div> : null}

    {!loading && !error && packages.length ? <details className="suite-advanced suite-app-advanced">
      <summary>Advanced details</summary>
      <dl>
        <dt>Hyper-V hosts repair</dt>
        <dd><pre>{hostsRepairCommand}</pre></dd>
      </dl>
    </details> : null}

    {externalOpen && externalResolved ? <ExternalAppDetail onClose={() => setExternalOpen(false)} resolved={externalResolved} /> : null}

    {selected ? <AppDetail app={selected} connectingId={connectingId} guideUpdating={guideUpdatingId === selected.id} installing={installingId === selected.id || connectingId.startsWith(`${selected.id}:`)} installError={installError} installSteps={installingId === selected.id || connectingId.startsWith(`${selected.id}:`) || installError ? installSteps : []} onClose={() => { setSelectedId(''); setInstallError(''); setInstallSteps([]); }} onConnect={(connection) => void connectPackages(connection)} onGuideStatus={(target, status) => void updateGuideStatus(target, status)} onInstall={(target, options) => void performInstall(target, options)} onLifecycle={(target, action) => void performLifecycle(target, action)} onSelect={(target) => { setSelectedId(target.id); setInstallError(''); setInstallSteps([]); }} owner={owner} packages={packages} /> : null}
  </section>;
}
