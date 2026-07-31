import { useEffect, useId, useMemo, useState } from 'react';

import { ActionMenu, AppConnect, Dialog, Icon, Notice, TextInput } from '../../components/ui';
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
  replaces: string;
  resourceHint: { description: string; label: string; level: string };
  screenshots: Array<{ alt: string; caption: string; src: string }>;
  tags: string[];
};
type CatalogStatus = { advisories?: { error: { code: string; message: string } | null; fetchedAt: string | null; freshness: 'fresh' | 'stale' | 'unavailable'; revision: string | null }; error: { code: string; message: string } | null; fetchedAt: string | null; freshness: 'fresh' | 'stale' | 'unavailable'; repository: string; revision: string | null };
type CatalogUpdate = {
  available: { compatibility: 'compatible' | 'requires-platform-update'; minimumMosVersion: string; packageDigest: string; packageVersion: string; privacy: { status: string }; sourceRevision: string } | null;
  installed: { packageDigest: string; packageVersion: string } | null;
  // `external-source` means the app came from a pasted repository rather than the
  // reviewed catalog, so only that repository knows whether a newer package
  // exists and the owner checks on demand.
  status: 'current' | 'external-source' | 'installable' | 'installed-newer' | 'not-in-catalog' | 'unavailable' | 'update-available';
};
type UpdateComparison = {
  candidate: { packageVersion: string; privacy: PrivacyReviewSummary };
  changes: Array<{ area: string; classification: string; summary: string }>;
  compatibility: 'compatible' | 'owner-action-required' | 'unsupported' | 'unresolved';
  // Binds an apply to the exact pair of packages that were compared here. The
  // backend re-compares and refuses the apply if either side moved since.
  confirmationToken: string;
  installed: { packageVersion: string; privacy: PrivacyReviewSummary };
  metadata: { backupRequired: boolean; downtime: string; migrations: string[]; ownerActions: string[]; rollback: string };
  // What the candidate asks MOS for, and what it asks for that the installed
  // version does not already have.
  permissions: { added: string[]; candidate: string[]; installed: string[]; removed: string[] };
  requiredInput: Array<{ default?: unknown; id: string; label: string; secret: boolean; type: string }>;
  updateStatus: 'current' | 'installed-newer' | 'update-available';
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
  // Trust of the source this instance was installed from, reported by the
  // backend and never derived from package metadata.
  external?: boolean;
  id: string;
  installStatus: string;
  mosReviewed?: boolean;
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

// Setup fields read the same way for a catalog package and a pasted external
// one, so these take anything carrying a setup schema.
type SetupSource = Pick<AppPackageSummary, 'setup'>;

function setupFieldsNeedInput(app: SetupSource) {
  return app.setup.fields.filter((field) => !field.generated);
}

// Non-secret manifest defaults may reference the signed-in owner
// (`${owner.name}`, `${owner.email}`) so setup forms open personalized.
function ownerDefault(value: string, owner: Owner) {
  return value.replace(/\$\{owner\.email\}/gu, owner.email).replace(/\$\{owner\.name\}/gu, owner.name);
}

function initialSetupConfig(app: SetupSource, owner: Owner) {
  return Object.fromEntries(
    setupFieldsNeedInput(app).map((field) => [
      field.id,
      typeof field.default === 'string' ? ownerDefault(field.default, owner) : field.type === 'email' ? owner.email : '',
    ]),
  );
}

function requiredSetupMissing(app: SetupSource, setupConfig: Record<string, string>) {
  return setupFieldsNeedInput(app).some((field) => field.required && !String(setupConfig[field.id] || '').trim());
}

function AppSetupPanel({ disabled, fields, onChange, values }: {
  disabled: boolean;
  fields: AppPackageSummary['setup']['fields'];
  onChange: (id: string, value: string) => void;
  values: Record<string, string>;
}) {
  return <div className="suite-app-setup-panel">
    {fields.map((field) => <TextInput
        autoComplete={field.secret ? 'new-password' : 'off'}
        disabled={disabled}
        key={field.id}
        label={`${field.label}${field.required ? ' *' : ''}`}
        onChange={(event) => onChange(field.id, event.currentTarget.value)}
        type={field.secret ? 'password' : field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
        value={values[field.id] || ''}
      />)}
  </div>;
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

function resourceLabel(app: AppPackageSummary) {
  return app.catalog.resourceHint.label || (app.catalog.resourceHint.level ? `${app.catalog.resourceHint.level[0]!.toUpperCase()}${app.catalog.resourceHint.level.slice(1)} resources` : 'Resource use varies');
}

function serviceExposed(app: AppPackageSummary, serviceId: string) {
  return app.routes.some((route) => route.service === serviceId);
}

// Plain-language role for one package service. Manifests do not describe their
// services for humans, so this reads the service id the way an owner would:
// the routed service is the app itself, the rest are recognisable supporting
// parts (database, cache, machine learning).
// COUSIN LOGIC — the public site's app drawer duplicates this heuristic in
// site/src/lib/app-catalog.ts (serviceRole); if wording or matching changes
// here, change it there too.
function serviceRoleLabel(app: AppPackageSummary, serviceId: string) {
  if (serviceExposed(app, serviceId)) return isCompanionApp(app) ? `The ${app.name} service` : `The ${app.name} app you open`;
  const id = serviceId.toLowerCase();
  if (/postgres|mysql|mariadb|database|\bdb\b/u.test(id)) return 'Database';
  if (/valkey|redis|memcache|cache/u.test(id)) return 'Cache';
  if (/machine-learning/u.test(id)) return 'Machine learning';
  return 'Support service';
}

// SIBLING VISUAL — the public site's app drawer renders the same meter
// (see the `meter` helper in site/src/components/AppCatalog.astro); keep the
// level mapping and look in sync.
function ResourceMeter({ level }: { level: string }) {
  const filled = level === 'high' ? 3 : level === 'medium' ? 2 : level === 'low' ? 1 : 0;
  return <span aria-hidden="true" className={`suite-app-resource-meter${level === 'high' ? ' is-high' : ''}`}>
    {[1, 2, 3].map((bar) => <span className={bar <= filled ? 'is-filled' : ''} key={bar} />)}
  </span>;
}

function descriptionFor(app: AppPackageSummary) {
  return app.catalog.description || app.homepage?.description || app.summary;
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
  onUpdated,
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
  onUpdated: () => Promise<void>;
  packages: AppPackageSummary[];
  guideUpdating: boolean;
  owner: Owner;
}) {
  const [showOnHomepage, setShowOnHomepage] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [setupConfig, setSetupConfig] = useState<Record<string, string>>(() => initialSetupConfig(app, owner));
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [slideIdx, setSlideIdx] = useState(0);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [comparison, setComparison] = useState<UpdateComparison | null>(null);
  const [comparisonError, setComparisonError] = useState('');
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [updateInput, setUpdateInput] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState('');
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
  // An update applies only when there is a newer package to apply, MOS can apply
  // it safely, and every value the new version newly requires has been given.
  const canApplyUpdate = Boolean(comparison)
    && comparison!.updateStatus === 'update-available'
    && comparison!.compatibility !== 'unsupported'
    && comparison!.requiredInput.every((field) => (updateInput[field.id] || '').trim())
    && !applying;
  const connections = app.compatibility?.connections || [];
  const missingUsefulPeers = app.compatibility?.missingUsefulPeers || [];
  const installedCompatiblePeers = packages.filter((item) => item.id !== app.id && item.instance && item.capabilities.exports.some((capability) => app.capabilities.usefulness.requiresOneOf.includes(capability.type)));

  useEffect(() => {
    setShowOnHomepage(hasHomepageContribution(app));
    setSetupOpen(false);
    setGuideOpen(false);
    setSetupConfig(initialSetupConfig(app, owner));
    setPrivacyOpen(false);
    setGalleryOpen(false);
    setSlideIdx(0);
    setResourcesOpen(false);
    setComparison(null);
    setComparisonError('');
    setUpdateInput({});
    setApplyError('');
    setRecoverError('');
  }, [app.id, owner]);

  async function prepareUpdate() {
    setComparisonLoading(true);
    setComparisonError('');
    try {
      const result = await jsonResponse<{ comparison: UpdateComparison }>(await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/prepare-update`, { method: 'POST' }), `Unable to prepare the ${app.name} update.`);
      setComparison(result.comparison);
      setUpdateInput(Object.fromEntries(result.comparison.requiredInput.flatMap((field) => (typeof field.default === 'string' ? [[field.id, ownerDefault(field.default, owner)]] : []))));
      setApplyError('');
    } catch (caught) { setComparisonError(caught instanceof Error ? caught.message : 'Unable to prepare this update.'); }
    finally { setComparisonLoading(false); }
  }

  // Applying is bound to the exact pair of packages this dialog compared. The
  // backend re-downloads and re-compares both sides and refuses the token if
  // either moved, so an update can only ever apply what the owner just reviewed.
  async function applyUpdate() {
    if (!comparison) return;
    setApplying(true);
    setApplyError('');
    try {
      await jsonResponse(
        await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/stage-update`, {
          body: JSON.stringify({ config: updateInput, confirmationToken: comparison.confirmationToken }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
        `Unable to update ${app.name}.`,
      );
      setComparison(null);
      setUpdateInput({});
      await onUpdated();
    } catch (caught) {
      setApplyError(caught instanceof Error ? caught.message : `Unable to update ${app.name}.`);
    } finally { setApplying(false); }
  }

  // One action for both recovery states: the backend inspects what the failed
  // update actually left behind and either finishes the pending commit or
  // restores the previous runtime.
  async function recoverUpdate() {
    setRecovering(true);
    setRecoverError('');
    try {
      await jsonResponse(
        await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/recover-update`, { method: 'POST' }),
        `Unable to recover ${app.name}.`,
      );
      await onUpdated();
    } catch (caught) {
      setRecoverError(caught instanceof Error ? caught.message : `Unable to recover ${app.name}.`);
    } finally { setRecovering(false); }
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
    if (!app.instance?.guideState || app.instance.guideState.status === 'not-started') {
      onGuideStatus(app, 'viewed');
    }
  }

  // A running app with a newer package waiting leads with the update rather
  // than with its front door: the owner came here to be told what changed, and
  // an update they never notice is an update they never apply. Opening the app
  // stays one button away.
  const updateWaiting = Boolean(ready && app.catalogUpdate?.status === 'update-available' && app.catalogUpdate.available && !app.instance?.updateRecovery);
  const canRestartRuntime = Boolean(runtimeRouteApplied(app) && !disabled && !uninstalled);
  const maintenanceActions = [
    ...(ready && hasGuide(app) && guideCompleted ? [{ label: 'Setup guide', onSelect: openGuide }] : []),
    ...(canRestartRuntime ? [{ label: 'Restart', onSelect: () => onLifecycle(app, 'restart') }] : []),
    ...(ready ? [{ label: 'Stop (keeps data)', onSelect: () => onLifecycle(app, 'stop') }] : []),
    ...(disabled ? [{ label: 'Start', onSelect: () => onLifecycle(app, 'enable') }] : []),
    ...(app.instance && !uninstalled ? [{ label: 'Uninstall', onSelect: () => setConfirmUninstall(true) }] : []),
  ];

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
            <span className="suite-app-category-pill">{categoryLabel(primaryCategory(app))}</span>
            {app.external ? <span className="suite-app-external-pill">External &middot; Unverified</span> : null}
            <AppHealthIndicator app={app} />
          </div>
          {app.catalog.replaces ? <p className="suite-app-detail-replaces"><span>Replaces</span><strong>{app.catalog.replaces}</strong></p> : null}
        </div>
        <div className="suite-app-primary-actions">
          {updateWaiting ? <>
            <button className="mos-btn mos-btn-primary" disabled={comparisonLoading} onClick={() => void prepareUpdate()} type="button">{comparisonLoading ? 'Checking update...' : 'Review update'}</button>
            {primaryDestination ? <a className="mos-btn mos-btn-secondary" href={url}>Open {app.name}</a> : null}
          </> : ready && primaryDestination ? <a className="mos-btn mos-btn-primary" href={url}>Open {app.name}</a> : ready && isCompanionApp(app) && installedCompatiblePeers.length ? <button className="mos-btn mos-btn-primary" onClick={() => onSelect(installedCompatiblePeers[0]!)} type="button">View compatible app</button> : ready && isCompanionApp(app) ? <button className="mos-btn mos-btn-primary" disabled type="button">Install compatible app</button> : disabled ? <button className="mos-btn mos-btn-primary" disabled={installing} onClick={() => onLifecycle(app, 'enable')} type="button">{installing ? 'Starting...' : 'Start'}</button> : needsPreparation && !setupOpen ? <button className="mos-btn mos-btn-primary" disabled={!app.validation.valid || uninstalled || installing} onClick={() => setSetupOpen(true)} type="button">Prepare</button> : <button className="mos-btn mos-btn-primary" disabled={!canInstall || uninstalled} onClick={submitInstall} type="button">{installing ? 'Installing...' : 'Install'}</button>}
          {ready && hasGuide(app) && !guideCompleted ? <button className="mos-btn mos-btn-secondary" disabled={guideUpdating} onClick={openGuide} type="button">{guideStatusLabel(app)}</button> : null}
          {maintenanceActions.length ? <ActionMenu ariaLabel="More app actions" disabled={installing || guideUpdating} items={maintenanceActions} /> : null}
          {confirmUninstall ? <Dialog
            footer={<>
              <button className="mos-btn mos-btn-primary" disabled={installing} onClick={() => { setConfirmUninstall(false); onLifecycle(app, 'uninstall'); }} type="button">Uninstall and delete data</button>
              <button className="mos-btn mos-btn-secondary" disabled={installing} onClick={() => setConfirmUninstall(false)} type="button">Cancel</button>
            </>}
            onClose={() => { if (!installing) setConfirmUninstall(false); }}
            title={`Uninstall ${app.name}?`}
          >
            <Notice title="Uninstalling deletes this app's data" variant="warning"><p>MOS removes the app's containers, web address, Homepage shortcut, settings, secrets, and data volumes. Anything stored in {app.name} is deleted with it &mdash; only a backup made beforehand can bring it back.</p></Notice>
            <p className="suite-meta">If you only want the app offline, use Stop instead &mdash; it keeps all data and settings.</p>
          </Dialog> : null}
          {homepageAvailable && !ready && !disabled && !uninstalled ? <label className="suite-app-homepage-option">
            <input checked={showOnHomepage} disabled={installing} onChange={(event) => setShowOnHomepage(event.currentTarget.checked)} type="checkbox" />
            <span>Add shortcut to Homepage</span>
          </label> : null}
          {setupOpen && needsPreparation ? <AppSetupPanel
            disabled={installing}
            fields={inputFields}
            onChange={(id, value) => setSetupConfig((current) => ({ ...current, [id]: value }))}
            values={setupConfig}
          /> : null}
        </div>
      </header>
      {app.instance?.updateRecovery ? <Notice title="App update needs attention" variant="warning">
        <p>{app.instance.updateRecovery.state === 'retry-safe'
          ? 'The update stopped before changing the running app. Review the latest update and try again.'
          : app.instance.updateRecovery.state === 'rollback-required'
            ? 'The update stopped after changing the running app. Restore the previous version, then update again when ready.'
            : 'The update installed its new version but stopped before recording it. Finish the update to bring this record in line with what is running.'}</p>
        {app.instance.updateRecovery.state !== 'retry-safe' ? <p>
          <button className="mos-btn mos-btn-secondary" disabled={recovering} onClick={() => void recoverUpdate()} type="button">
            {recovering ? 'Recovering...' : app.instance.updateRecovery.state === 'rollback-required' ? 'Restore previous version' : 'Finish update'}
          </button>
        </p> : null}
        {recoverError ? <p role="alert">{recoverError}</p> : null}
        <details className="suite-advanced"><summary>Advanced details</summary><code>{app.instance.updateRecovery.errorCode}</code></details>
      </Notice> : null}

      <div className="suite-app-detail-scroll">
        <InstallProgress error={installError} steps={installSteps} />

        {!app.validation.valid ? <Notice title="This package cannot be installed yet" variant="warning"><ul>{app.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul></Notice> : null}
        {missingUsefulPeers.length ? <Notice title="Needs a compatible app" variant="info"><p>{missingUsefulPeers[0]!.message}</p></Notice> : null}
        {ready && isCompanionApp(app) && !installedCompatiblePeers.length ? <Notice title="Companion app" variant="info"><p>{app.capabilities.usefulness.emptyState || 'Install a compatible app to use this service.'}</p></Notice> : null}
        {app.external ? <Notice title="Unverified external package" variant="warning">
          <p>You installed this app from a repository you pasted, not the verified MOS catalog. MOS has not reviewed its code and cannot vouch for any privacy claims it makes. It runs with a restricted profile: only its own named storage and its own web addresses.</p>
        </Notice> : null}

        {app.catalogUpdate?.status === 'update-available' && app.catalogUpdate.available ? <section className="suite-app-update-summary">
          <div><span>Installed</span><strong>{app.catalogUpdate.installed?.packageVersion}</strong></div>
          <div><span>Available</span><strong>{app.catalogUpdate.available.packageVersion}</strong></div>
          <div><span>Compatibility</span><strong>{app.catalogUpdate.available.compatibility === 'compatible' ? 'Ready for this MOS version' : `Requires MOS ${app.catalogUpdate.available.minimumMosVersion}`}</strong></div>
          {updateWaiting ? null : <button className="mos-btn mos-btn-secondary" disabled={comparisonLoading} onClick={() => void prepareUpdate()} type="button">{comparisonLoading ? 'Checking update...' : 'Review update'}</button>}
          {comparisonError ? <p role="alert">{comparisonError}</p> : null}
        </section> : null}

        {app.catalogUpdate?.status === 'external-source' ? <section className="suite-app-update-summary">
          <div><span>Installed</span><strong>{app.catalogUpdate.installed?.packageVersion}</strong></div>
          <div><span>Source</span><strong>The repository you pasted</strong></div>
          <p>This app did not come from the verified MOS catalog, so MOS does not track its versions. Checking asks its repository directly what it publishes now.</p>
          <button className="mos-btn mos-btn-secondary" disabled={comparisonLoading} onClick={() => void prepareUpdate()} type="button">{comparisonLoading ? 'Checking...' : 'Check for updates'}</button>
          {comparisonError ? <p role="alert">{comparisonError}</p> : null}
        </section> : null}

        <section aria-label="App overview" className={`suite-app-tiles${app.catalog.screenshots.length ? ' has-screens' : ''}`}>
          {app.catalog.screenshots.length ? <button aria-label={`Preview ${app.catalog.screenshots.length === 1 ? '1 screen' : `${app.catalog.screenshots.length} screens`} of ${app.name}`} className="suite-app-screens-tile" onClick={() => { setSlideIdx(0); setGalleryOpen(true); }} type="button">
            <img alt="" src={app.catalog.screenshots[0]!.src} />
            <span aria-hidden="true" className="suite-app-screens-head">
              <span className="suite-app-tile-label">Screens</span>
              <span className="suite-app-screens-count">({app.catalog.screenshots.length})</span>
            </span>
          </button> : null}
          <PrivacyFactsTile advisories={app.advisories} onOpen={() => setPrivacyOpen(true)} privacy={app.privacy} />
          <button className="suite-app-resources-tile" onClick={() => setResourcesOpen(true)} type="button">
            <span className="suite-app-tile-label">Resources</span>
            <span className="suite-app-resources-line">
              <ResourceMeter level={app.catalog.resourceHint.level} />
              <strong>{resourceLabel(app)}</strong>
            </span>
            <span className="suite-app-tile-meta">
              {app.services.length === 1 ? 'Runs as 1 service' : app.services.length ? `Runs as ${app.services.length} services` : 'Details unavailable'}
              <Icon name="chevron-right" />
            </span>
          </button>
        </section>

        <p className="suite-app-detail-description">{descriptionFor(app)}</p>

        {app.catalog.features.length ? <section className="suite-app-detail-section">
          <h3>Best for</h3>
          <div className="suite-app-feature-list">
            {app.catalog.features.map((feature) => <article key={feature.title}>
              <span aria-hidden="true" className="suite-app-feature-check"><Icon name="check" /></span>
              <div>
                <strong>{feature.title}</strong>
                {feature.body ? <p>{feature.body}</p> : null}
              </div>
            </article>)}
          </div>
        </section> : null}

        {app.catalog.privacy.summary || app.catalog.privacy.notes.length ? <section className="suite-app-detail-section suite-app-privacy">
          <h3>Package-provided privacy notes</h3>
          <p className="suite-app-help">These claims come from the package metadata and have not been independently verified by MOS. See the Privacy Posture above for the evidence-backed MOS assessment.</p>
          {app.catalog.privacy.summary ? <p>{app.catalog.privacy.summary}</p> : null}
          {app.catalog.privacy.notes.length ? <ul>{app.catalog.privacy.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
        </section> : null}

        {connections.length ? <section className="suite-app-detail-section">
          <h3>Connections</h3>
          <div className="suite-app-connection-list">
            {connections.map((connection) => {
              const status = connection.relationship?.status || (connection.provider.installStatus === 'not-installed' ? 'Install first' : connection.provider.runtimeState === 'running' ? 'Ready to connect' : 'Start both apps first');
              const busy = connectingId === `${connection.consumerPackageId}:${connection.provider.id}:${connection.slotId}:${connection.capabilityId}`;
              // The provider is drawn as the app that plugs in, the app on
              // screen as the one holding the socket, matching the direction
              // the public site draws the same pairing.
              const providerPackage = packages.find((item) => item.id === connection.provider.id);
              return <article className="suite-app-connection" key={`${connection.provider.id}-${connection.slotId}-${connection.capabilityId}`}>
                <AppConnect
                  size="sm"
                  source={{ iconUrl: providerPackage?.iconUrl, name: connection.provider.name }}
                  target={{ iconUrl: app.iconUrl, name: app.name }}
                />
                <div className="suite-app-connection-copy">
                  <strong>{connection.title}</strong>
                  <small>{connection.provider.name} - {status}</small>
                </div>
                <button className="mos-btn mos-btn-primary" disabled={!connection.ready || busy || installing} onClick={() => onConnect(connection)} type="button">
                  {busy ? 'Connecting...' : connection.ready ? connection.actionLabel : 'Unavailable'}
                </button>
              </article>;
            })}
          </div>
        </section> : null}

        {(Object.keys(app.catalog.links).length || related.length) ? <section className="suite-app-detail-section">
          <h3>Links and related apps</h3>
          {Object.keys(app.catalog.links).length ? <div className="suite-app-link-row">
            {Object.entries(app.catalog.links).map(([key, href]) => <a className="mos-btn mos-btn-secondary" href={href} key={key} rel="noreferrer" target="_blank">{key === 'repository' ? 'Repository' : key === 'website' ? 'Website' : 'Docs'}<Icon name="external" /></a>)}
          </div> : null}
          {related.length ? <div className="suite-app-related-list">{related.map((item) => <button key={item.id} onClick={() => onSelect(item)} type="button"><AppIcon app={item} /><span><strong>{item.name}</strong><small>{descriptionFor(item)}</small></span></button>)}</div> : null}
        </section> : null}

        <AdvancedDetails app={app} />
      </div>
    </aside>
    {privacyOpen ? <PrivacyPostureDialog advisories={app.advisories} appName={app.name} onClose={() => setPrivacyOpen(false)} packageVersion={app.instance?.packageVersion || app.version} privacy={app.privacy} /> : null}
    {galleryOpen && app.catalog.screenshots.length ? <Dialog className="suite-app-gallery-dialog" closeOnBackdrop onClose={() => setGalleryOpen(false)} title={`${app.name} screens`}>
      <figure className="suite-app-gallery">
        <div className="suite-app-gallery-frame">
          <img alt={app.catalog.screenshots[slideIdx]?.alt || `${app.name} screenshot ${slideIdx + 1}`} src={app.catalog.screenshots[slideIdx]?.src || app.catalog.screenshots[0]!.src} />
        </div>
        <div className="suite-app-gallery-nav">
          {app.catalog.screenshots.length > 1 ? <button aria-label="Previous screen" className="suite-icon-button is-back" onClick={() => setSlideIdx((current) => (current - 1 + app.catalog.screenshots.length) % app.catalog.screenshots.length)} type="button"><Icon name="chevron-right" /></button> : null}
          <figcaption>
            {app.catalog.screenshots[slideIdx]?.caption || app.catalog.screenshots[slideIdx]?.alt ? <strong>{app.catalog.screenshots[slideIdx]?.caption || app.catalog.screenshots[slideIdx]?.alt}</strong> : null}
            {app.catalog.screenshots.length > 1 ? <span className="suite-app-gallery-dots">
              {app.catalog.screenshots.map((shot, index) => <button aria-label={`Go to screen ${index + 1}`} className={index === slideIdx ? 'is-active' : ''} key={shot.src} onClick={() => setSlideIdx(index)} type="button" />)}
            </span> : null}
          </figcaption>
          {app.catalog.screenshots.length > 1 ? <button aria-label="Next screen" className="suite-icon-button" onClick={() => setSlideIdx((current) => (current + 1) % app.catalog.screenshots.length)} type="button"><Icon name="chevron-right" /></button> : null}
        </div>
      </figure>
    </Dialog> : null}
    {resourcesOpen ? <Dialog
      className="suite-app-resources-dialog"
      closeOnBackdrop
      footer={<button className="mos-btn mos-btn-secondary" onClick={() => setResourcesOpen(false)} type="button">Close</button>}
      onClose={() => setResourcesOpen(false)}
      title="What runs on your server"
    >
      <div className="suite-app-resources-summary">
        <ResourceMeter level={app.catalog.resourceHint.level} />
        <strong>{resourceLabel(app)}</strong>
      </div>
      {app.catalog.resourceHint.description ? <p className="suite-app-resources-note">{app.catalog.resourceHint.description}</p> : null}
      {app.services.length ? <div className="suite-app-service-list">
        {/* Manifests declare dependencies before the app they serve, which
            would bury the service the owner actually recognises at the bottom.
            The exposed app leads; the stable sort keeps the rest in order. */}
        {[...app.services].sort((left, right) => Number(serviceExposed(app, right.id)) - Number(serviceExposed(app, left.id))).map((service) => {
          const exposed = serviceExposed(app, service.id);
          return <article className={exposed ? 'is-exposed' : ''} key={service.id}>
            <span aria-hidden="true" className="suite-app-service-dot" />
            <span className="suite-app-service-copy">
              <span className="suite-app-service-role"><strong>{serviceRoleLabel(app, service.id)}</strong><code>{service.id}</code></span>
              <small>{service.volumes.length ? 'Keeps its data in private app storage.' : 'Holds nothing permanent.'}</small>
            </span>
            <span className="suite-app-service-tag">{exposed ? 'Exposed via HTTPS' : 'Internal only'}</span>
          </article>;
        })}
      </div> : null}
      <p className="suite-meta">{app.services.some((service) => serviceExposed(app, service.id))
        ? 'MOS installs, updates, and backs these up together as one app. Only the exposed service is reachable from outside — everything else stays internal to this app.'
        : 'MOS installs, updates, and backs these up together as one app. Nothing is exposed publicly — compatible apps reach it internally once you connect them.'}</p>
    </Dialog> : null}
    {comparison ? <Dialog
      footer={<>
        <button className="mos-btn mos-btn-secondary" disabled={applying} onClick={() => setComparison(null)} type="button">{comparison.updateStatus === 'update-available' ? 'Cancel' : 'Close'}</button>
        {comparison.updateStatus === 'update-available' ? <button className="mos-btn mos-btn-primary" disabled={!canApplyUpdate} onClick={() => void applyUpdate()} type="button">{applying ? 'Updating...' : 'Update'}</button> : null}
      </>}
      onClose={() => { if (!applying) setComparison(null); }}
      title={`Review ${app.name} update`}
    >
      <div className="suite-app-update-dialog">
        <Notice title={updateNoticeTitle(comparison)} variant={comparison.compatibility === 'unsupported' ? 'warning' : 'info'}>
          <p>{comparison.updateStatus === 'current'
            ? `${app.name} is already running the newest package its source offers.`
            : comparison.updateStatus === 'installed-newer'
              ? `The source offers version ${comparison.candidate.packageVersion}, which is older than the installed ${comparison.installed.packageVersion}. MOS does not downgrade apps.`
              : `Version ${comparison.installed.packageVersion} to ${comparison.candidate.packageVersion}.`}</p>
        </Notice>
        {comparison.validation.errors.length ? <Notice title="This update cannot be applied" variant="warning">
          <ul>{comparison.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>
        </Notice> : null}
        {app.external && comparison.updateStatus === 'update-available' ? <Notice title="Updating runs the publisher's build" variant="warning">
          <p>Updating rebuilds this package&apos;s Dockerfiles on your server, which runs commands the publisher wrote &mdash; with network access &mdash; before MOS&apos;s runtime restrictions apply. Update only if you still trust the repository this app came from.</p>
        </Notice> : null}
        {comparison.permissions.added.length ? <Notice title="This update asks for more access" variant="warning">
          <p>The installed version does not have this access today. Updating grants it.</p>
          <ul className="suite-app-permission-list">
            {comparison.permissions.added.map((permission) => {
              const described = permissionLabel(permission);
              return <li key={permission}><strong>{described.label}</strong>{described.detail ? <small>{described.detail}</small> : null}</li>;
            })}
          </ul>
        </Notice> : null}
        <PrivacyChangeRow candidate={comparison.candidate.privacy} candidateVersion={comparison.candidate.packageVersion} installed={comparison.installed.privacy} installedVersion={comparison.installed.packageVersion} />
        <dl><dt>Backup</dt><dd>{comparison.metadata.backupRequired ? 'Required' : 'Not declared as required'}</dd><dt>Downtime</dt><dd>{comparison.metadata.downtime}</dd><dt>Rollback</dt><dd>{comparison.metadata.rollback}</dd></dl>
        {comparison.changes.length ? <ul>{comparison.changes.map((change, index) => <li key={`${change.area}-${index}`}><strong>{change.area}</strong>: {change.summary}</li>)}</ul> : <p>No structural changes detected.</p>}
        {comparison.requiredInput.map((field) => <TextInput autoComplete={field.secret ? 'new-password' : 'off'} disabled={applying} key={field.id} label={field.label} onChange={(event) => setUpdateInput((current) => ({ ...current, [field.id]: event.currentTarget.value }))} type={field.secret ? 'password' : field.type === 'email' ? 'email' : 'text'} value={updateInput[field.id] || ''} />)}
        {comparison.requiredInput.length ? <p className="suite-meta">{app.name} needs these values before it can start on the new version. They are stored with this app the same way its other settings are.</p> : null}
        {applyError ? <Notice title="The update did not finish" variant="warning"><p>{applyError}</p></Notice> : null}
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

function externalSourceLabel(repository: string) {
  try { return new URL(repository).hostname; } catch { return 'External repository'; }
}

function externalDescription(card: ExternalCard) {
  return card.summary || card.homepage?.description || card.catalog.description || 'External MOS app package.';
}

function updateNoticeTitle(comparison: UpdateComparison): string {
  if (comparison.updateStatus === 'current') return 'No update available';
  if (comparison.updateStatus === 'installed-newer') return 'The source offers an older version';
  if (comparison.compatibility === 'unsupported') return 'This update cannot be applied safely';
  return comparison.compatibility === 'owner-action-required' ? 'Review this before updating' : 'Ready to update';
}

// Plain-language explanation of one requested permission key, so an owner can see
// exactly what a package would be granted before installing it and exactly what
// an update would add to that.
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

function ExternalAppDetail({ installError, installing, onClose, onInstall, owner, resolved }: {
  installError: string;
  installing: boolean;
  onClose: () => void;
  onInstall: (resolved: ExternalResolveResponse, config: Record<string, string>) => void;
  owner: Owner;
  resolved: ExternalResolveResponse;
}) {
  const { card, permissions, source } = resolved;
  const [setupConfig, setSetupConfig] = useState<Record<string, string>>(() => initialSetupConfig(card, owner));
  const inputFields = setupFieldsNeedInput(card);
  const canInstall = card.validation.valid && !requiredSetupMissing(card, setupConfig) && !installing;
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
          <button className="mos-btn mos-btn-primary" disabled={!canInstall} onClick={() => onInstall(resolved, { ...setupConfig })} type="button">{installing ? 'Installing...' : 'Install'}</button>
          {inputFields.length ? <AppSetupPanel
            disabled={installing}
            fields={inputFields}
            onChange={(id, value) => setSetupConfig((current) => ({ ...current, [id]: value }))}
            values={setupConfig}
          /> : null}
        </div>
      </header>

      <div className="suite-app-detail-scroll">
        {installError ? <Notice title="This package could not be installed" variant="warning"><p>{installError}</p></Notice> : null}

        <Notice title="Unverified external package" variant="warning">
          <p>This package comes from a repository you pasted, not the verified MOS catalog. MOS has not reviewed its code or checked any privacy claims. Installing it builds its Dockerfiles on your server, which runs commands the publisher wrote &mdash; with network access &mdash; before any of MOS&apos;s runtime restrictions apply. Install it only if you trust whoever publishes that repository. Once running, it is restricted to its own named storage and the web addresses listed below &mdash; no privileged access, host folders, or Docker socket.</p>
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
          <div><span>Source</span><strong>{externalSourceLabel(source.repository)}</strong></div>
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
  const [externalInstalling, setExternalInstalling] = useState(false);
  const [externalInstallError, setExternalInstallError] = useState('');

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

  useEffect(() => {
    void load();
    // Opening Apps signals intent to see the current catalog, so nudge the
    // backend refresh once in the background. Failures stay silent: the page
    // keeps serving the last verified catalog and the stale-catalog notice
    // already covers persistent refresh trouble.
    void (async () => {
      try {
        const response = await fetch('/suite-manager/api/apps/catalog/refresh', { method: 'POST' });
        if (response.ok) await load({ silent: true });
      } catch {}
    })();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load({ silent: true });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // The catalog and advisory feed refresh is a convenience on top of the signed
  // catalog that already ships in the release, so a stale or failed fetch is not
  // worth interrupting normal users with a banner. It is logged to the console
  // instead, where anyone debugging still sees it and real users never do.
  useEffect(() => {
    if (!catalogStatus) return;
    if (catalogStatus.freshness === 'stale' || catalogStatus.error) {
      console.warn('[apps] official catalog refresh is not fresh:', catalogStatus.error?.code || catalogStatus.freshness, catalogStatus.error?.message || '');
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

  const selected = packages.find((app) => app.id === selectedId) || null;

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

  // Installing a pasted repository is the only point where an external package
  // is persisted. The backend re-resolves and re-validates the URL, so what is
  // installed is whatever passes the gate right now rather than the previewed
  // card. Once it is installed it is an ordinary app instance under its
  // namespaced id, so the normal install flow finishes runtime and Homepage.
  async function performExternalInstall(resolved: ExternalResolveResponse, config: Record<string, string> = {}) {
    if (!resolved.card.validation.valid) return;
    setExternalInstalling(true);
    setExternalInstallError('');
    try {
      const installed = await jsonResponse<{ packageId: string }>(
        await fetch('/suite-manager/api/apps/sources/install', {
          body: JSON.stringify({ config, url: resolved.source.repository }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
        `Unable to install ${resolved.card.name}.`,
      );
      const refreshed = await jsonResponse<{ catalog: CatalogStatus; packages: AppPackageSummary[] }>(
        await fetch('/suite-manager/api/apps/packages'),
        'Unable to load app packages.',
      );
      setPackages(refreshed.packages);
      setCatalogStatus(refreshed.catalog);
      const app = refreshed.packages.find((item) => item.id === installed.packageId);
      setExternalOpen(false);
      setQuery('');
      // Forward the collected setup values: the package is installed by now, but
      // performInstall still needs them to pass its required-field check before
      // it applies the runtime. Without them it returns silently and the app
      // never starts.
      if (app) await performInstall(app, { config });
    } catch (caught) {
      setExternalInstallError(caught instanceof Error ? caught.message : `Unable to install ${resolved.card.name}.`);
    } finally {
      setExternalInstalling(false);
    }
  }

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
    </div>

    <div className="suite-app-search">
      <input aria-label="Search apps" onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or what you want to do..." value={query} />
    </div>

    {error ? <Notice title="Apps unavailable" variant="error"><p>{error}</p></Notice> : null}
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

    {externalOpen && externalResolved ? <ExternalAppDetail
      installError={externalInstallError}
      installing={externalInstalling}
      onClose={() => setExternalOpen(false)}
      onInstall={(resolved, config) => { void performExternalInstall(resolved, config); }}
      owner={owner}
      resolved={externalResolved}
    /> : null}

    {selected ? <AppDetail app={selected} connectingId={connectingId} guideUpdating={guideUpdatingId === selected.id} installing={installingId === selected.id || connectingId.startsWith(`${selected.id}:`)} installError={installError} installSteps={installingId === selected.id || connectingId.startsWith(`${selected.id}:`) || installError ? installSteps : []} onClose={() => { setSelectedId(''); setInstallError(''); setInstallSteps([]); }} onConnect={(connection) => void connectPackages(connection)} onGuideStatus={(target, status) => void updateGuideStatus(target, status)} onInstall={(target, options) => void performInstall(target, options)} onLifecycle={(target, action) => void performLifecycle(target, action)} onSelect={(target) => { setSelectedId(target.id); setInstallError(''); setInstallSteps([]); }} onUpdated={() => load()} owner={owner} packages={packages} /> : null}
  </section>;
}
