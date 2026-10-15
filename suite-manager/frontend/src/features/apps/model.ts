import type { AdvancedFact } from '../../components/ui';
import { sourceCheckedLabel } from '../../lib/app-sources';
import type { AppJob, AppPackageSummary, CatalogStatus, ExternalCard, InstallStep, ServiceRequires, UpdateComparison, UpdateStep } from './types';

const UPDATE_STEPS: UpdateStep[] = [
  { detail: 'Making sure both versions are still the ones you reviewed.', id: 'check', label: 'Checking the update', status: 'pending' },
  { detail: 'Building the new version on your server. This is the long part.', id: 'build', label: 'Building the new version', status: 'pending' },
  { detail: 'Starting the new version in place of the current one and checking it works. The app is briefly unavailable.', id: 'switch', label: 'Switching over', status: 'pending' },
  { detail: 'Recording the new version.', id: 'finish', label: 'Finishing', status: 'pending' },
];

export function updateJobSteps(job: AppJob<UpdateStep> | null | undefined): UpdateStep[] {
  return job ? job.steps.map((step) => ({ ...UPDATE_STEPS.find((template) => template.id === step.id)!, seconds: step.seconds, status: step.status })) : [];
}

const INSTALL_STEP_MIN_MS = 1000;

const CATEGORY_LABELS: Record<string, string> = {
  files: 'Files',
  office: 'Office',
  photos: 'Photos',
  security: 'Security',
  tools: 'Tools',
};

export function categoryLabel(category: string) {
  return CATEGORY_LABELS[category] || category.replace(/-/gu, ' ').replace(/\b\w/gu, (match) => match.toUpperCase());
}

// A manifest may list every product an app stands in for, ranked most-known
// first. The detail hero has room for the two that identify it; the app's page
// on the public docs site carries the whole list. Cousin of shortReplaces() in
// the site's src/lib/app-catalog.ts.
export function shortReplaces(replaces: string[]) {
  return replaces.slice(0, 2).join(' / ');
}

export function primaryCategory(app: AppPackageSummary) {
  return Array.isArray(app.category) ? app.category[0] || 'apps' : app.category;
}

function homepageApplied(app: AppPackageSummary) {
  const projection = app.instance?.projections.find((item) => item.kind === 'homepage');
  return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
}

export function hasHomepageContribution(app: AppPackageSummary) {
  return Boolean(app.homepage);
}

export function isCompanionApp(app: AppPackageSummary) {
  return app.role === 'companion' || app.role === 'capability-provider' || app.role === 'integration-helper';
}

export function hasPrimaryAppDestination(app: AppPackageSummary) {
  return !isCompanionApp(app) && app.routes[0]?.kind === 'web';
}

export function runtimeApplied(app: AppPackageSummary) {
  const required = ['compose', 'caddy', 'health'];
  return required.every((kind) => {
    const projection = app.instance?.projections.find((item) => item.kind === kind);
    return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
  });
}

export function runtimeRouteApplied(app: AppPackageSummary) {
  const required = ['compose', 'caddy'];
  return required.every((kind) => {
    const projection = app.instance?.projections.find((item) => item.kind === kind);
    return Boolean(projection?.appliedDigest && projection.appliedDigest === projection.digest && projection.status === 'applied');
  });
}

function healthFailed(app: AppPackageSummary) {
  return app.instance?.projections.some((item) => item.kind === 'health' && item.status === 'failed') === true;
}

// A title and one sentence per failure, in the owner's terms and ending in what
// to do about it. Both, because the two are not interchangeable: an app that is
// running but unreachable and an app that never started need different headings,
// and a single "did not start" would have contradicted half of these bodies. The
// agent's own message says what broke and stays in the panel below with the
// code; this is the half a person who did not build MOS can act on.
const FAILURE_COPY: Record<string, { detail: string; title: string }> = {
  APP_AGENT_TIMEOUT: { detail: 'Heavy apps can need around ten minutes the first time they start, so try again before assuming it is broken.', title: 'This app took too long to start' },
  APP_AGENT_UNAVAILABLE: { detail: 'The part of MOS that starts apps is not responding. Restarting the server usually clears this.', title: 'MOS could not reach its own app service' },
  APP_BUILD_FAILED: { detail: 'This is most often the server running out of disk space, or a download that failed part way.', title: 'This app could not be prepared' },
  APP_CADDY_RELOAD_FAILED: { detail: 'The app itself is running, and other apps are unaffected. Applying it again usually publishes the address.', title: 'This app is running but has no web address' },
  APP_CADDY_VALIDATION_FAILED: { detail: 'The address came out wrong, so MOS left it unpublished rather than risk the addresses that already work.', title: 'This app is running but has no web address' },
  APP_HEALTH_FAILED: { detail: 'It started but never reported itself ready, which usually means it needs more memory than this server has free.', title: 'This app started but never became ready' },
  APP_NETWORK_CONNECT_FAILED: { detail: 'This app could not be connected to the app it depends on. Check that the other app is running.', title: 'This app could not reach the app it depends on' },
  APP_PACKAGE_SNAPSHOT_FAILED: { detail: 'The app package could not be saved to disk. Check that the server has free space.', title: 'This app could not be saved to disk' },
  APP_ROUTE_WRITE_FAILED: { detail: 'The app itself is running. Applying it again usually publishes the address.', title: 'This app is running but has no web address' },
  APP_RUNTIME_REMOVE_FAILED: { detail: 'Parts of it may still be on the server. Removing it again is safe.', title: 'This app was not fully removed' },
  APP_RUNTIME_STOP_FAILED: { detail: 'It may still be running. Stopping it again is safe.', title: 'This app did not stop cleanly' },
  APP_RUN_FAILED: { detail: 'It was prepared successfully but would not start.', title: 'This app did not start' },
  APP_VOLUME_STALE: { detail: 'Data from an earlier installation is still on the server. Restore it or remove it before installing again.', title: 'This app has data from a previous install' },
};

const UNKNOWN_FAILURE = {
  detail: 'MOS did not finish what it was asked to do. Trying again is safe.',
  title: 'Something went wrong with this app',
};

// A failed update that needed no recovery left the old version running, which
// is the one fact every one of these has to lead with: the install copy above
// would tell the owner of a running app that it "did not start".
const UPDATE_FAILURE_COPY: Record<string, { detail: string; title: string }> = {
  APP_BUILD_FAILED: { detail: 'The new version could not be prepared, most often because the server ran out of disk space or a download failed part way. The installed version keeps running.', title: 'The update could not be prepared' },
  APP_UPDATE_ACTIVATION_FAILED: { detail: 'The new version would not start or never became ready, so the version you had was put back and keeps running.', title: 'The new version did not start' },
  APP_UPDATE_IDENTITY_CHANGED: { detail: 'What the source offers changed while the update was being applied. The installed version keeps running; review the update again.', title: 'The update changed underneath MOS' },
  APP_UPDATE_PROMOTION_FAILED: { detail: 'The new version ran but could not be saved as the installed one, so the version you had was put back.', title: 'The update could not be saved to disk' },
};

const UNKNOWN_UPDATE_FAILURE = {
  detail: 'The installed version keeps running. Trying the update again is safe.',
  title: 'This app could not be updated',
};

export function failureCopy({ errorCode, kind }: { errorCode: string | null; kind: string }) {
  if (kind === 'update') return (errorCode && UPDATE_FAILURE_COPY[errorCode]) || UNKNOWN_UPDATE_FAILURE;
  return (errorCode && FAILURE_COPY[errorCode]) || UNKNOWN_FAILURE;
}

// Where the app list and its update offers came from. A catalog that will not
// refresh is deliberately not a banner — the list falls back to the packages
// this MOS version shipped with, so nothing is broken — but the reason for it
// existed only in the browser console, which is not a place an owner can be
// asked to look.
export function catalogFacts(status: CatalogStatus): AdvancedFact[] {
  const facts: AdvancedFact[] = [
    { label: 'Source', value: status.repository },
    { label: 'Branch', value: status.ref || 'not resolved' },
    { label: 'State', value: status.freshness },
    { label: 'Last fetched', value: status.fetchedAt ? new Date(status.fetchedAt).toLocaleString() : 'never' },
    { code: true, label: 'Revision', value: status.revision ? status.revision.slice(0, 12) : 'none' },
  ];
  if (status.error) facts.push({ code: true, label: 'Error', value: status.error.code });
  if (status.advisories) facts.push({ label: 'Advisories', value: status.advisories.error ? status.advisories.error.code : status.advisories.freshness });
  return facts;
}

export function initialsFor(name: string) {
  const words = name.split(/\s+/u).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)).toUpperCase();
}

// The address as it is spoken and typed, which is what the settings dialog
// shows; publicUrl is for following, this is for reading and copying.
export function appAddress(app: AppPackageSummary) {
  return app.publicUrl ? new URL(app.publicUrl).host : '';
}

export function hasGuide(app: AppPackageSummary) {
  return Boolean(app.onboarding && (app.onboarding.sections?.length || 0) > 0);
}

export function guideStatusLabel(app: AppPackageSummary) {
  const status = app.instance?.guideState?.status;
  if (status === 'completed') return 'Guide complete';
  if (status === 'skipped') return 'Setup guide';
  if (status === 'viewed') return 'Continue guide';
  return 'Setup guide';
}

export function statusFor(app: AppPackageSummary) {
  if (!app.validation.valid) return { className: 'is-attention', label: 'Unavailable', tone: 'warning' };
  if (app.instance?.status === 'disabled') return { className: 'is-progress', label: 'Stopped', tone: 'info' };
  if (healthFailed(app)) return { className: 'is-attention', label: 'Needs attention', tone: 'error' };
  if (app.installJob?.status === 'running') return { className: 'is-progress', label: 'Installing', tone: 'info' };
  if (app.updateJob?.status === 'running') return { className: 'is-progress', label: 'Updating', tone: 'info' };
  if (runtimeApplied(app)) return { className: 'is-ready', label: 'Running', tone: 'success' };
  if (app.installStatus === 'installed') return { className: 'is-progress', label: 'Finishing setup', tone: 'info' };
  return { className: 'is-available', label: 'Available', tone: 'info' };
}

export function resourceLabel(app: AppPackageSummary) {
  return app.catalog.resourceHint.label || (app.catalog.resourceHint.level ? `${app.catalog.resourceHint.level[0]!.toUpperCase()}${app.catalog.resourceHint.level.slice(1)} resources` : 'Resource use varies');
}

export function serviceExposed(app: AppPackageSummary, serviceId: string) {
  return app.routes.some((route) => route.service === serviceId);
}

// Plain-language role for one package service. Manifests do not describe their
// services for humans, so this reads the service id the way an owner would:
// the routed service is the app itself, the rest are recognisable supporting
// parts (database, cache, machine learning).
// COUSIN LOGIC — the public site's app drawer duplicates this heuristic in
// site/src/lib/app-catalog.ts (serviceRole); if wording or matching changes
// here, change it there too.
export function serviceRoleLabel(app: AppPackageSummary, serviceId: string) {
  if (serviceExposed(app, serviceId)) return isCompanionApp(app) ? `The ${app.name} service` : `The ${app.name} app you open`;
  const id = serviceId.toLowerCase();
  if (/postgres|mysql|mariadb|database|\bdb\b/u.test(id)) return 'Database';
  if (/valkey|redis|memcache|cache/u.test(id)) return 'Cache';
  if (/machine-learning/u.test(id)) return 'Machine learning';
  return 'Support service';
}

// Two different jobs, two different fields. `summary` is the one-line pitch a
// catalog row has space for; `catalog.description` is the paragraph the detail
// view exists to show. Rendering the paragraph in a row turns the list into a
// wall of text, so nothing here may fall back from the short to the long form.
export function summaryFor(app: AppPackageSummary) {
  return app.summary || app.homepage?.description || '';
}

export function descriptionFor(app: AppPackageSummary) {
  return app.catalog.description || app.homepage?.description || app.summary;
}

export function formatMemory(mb: number) {
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${Number(gb.toFixed(gb < 10 ? 1 : 0))} GB`;
}

export function formatCores(cores: number) {
  return cores === 1 ? '1 core' : `${Number(cores.toFixed(2))} cores`;
}

// A package's declared needs, added up across the services it runs. Its own
// services can be busy at the same moment, so their peaks add up here; across
// separate apps a peak is headroom to keep free, not a running cost, which is
// why nothing outside this package total sums them.
export function requirementsFor(app: AppPackageSummary) {
  const declared = app.services.map((service) => service.requires).filter((requires): requires is ServiceRequires => requires !== null);
  if (!declared.length || declared.length !== app.services.length) return null;
  const cpuCores = declared.reduce((total, requires) => total + requires.cpuCores, 0);
  const memoryMb = declared.reduce((total, requires) => total + requires.memoryMb, 0);
  const cpuPeakCores = declared.reduce((total, requires) => total + (requires.cpuPeakCores ?? requires.cpuCores), 0);
  const memoryPeakMb = declared.reduce((total, requires) => total + (requires.memoryPeakMb ?? requires.memoryMb), 0);
  return {
    cpuCores,
    cpuPeakCores: cpuPeakCores > cpuCores ? cpuPeakCores : null,
    memoryMb,
    memoryPeakMb: memoryPeakMb > memoryMb ? memoryPeakMb : null,
  };
}

function defaultInstallSteps(showOnHomepage = true): InstallStep[] {
  return [
    { detail: 'Saving the app choice and generating any safe defaults.', id: 'prepare', label: 'Preparing app', status: 'pending' },
    { detail: 'Building and starting the app. Its first start can take a few minutes.', id: 'runtime', label: 'Starting app', status: 'pending' },
    { detail: 'Waiting until its web address opens, certificate included.', id: 'address', label: 'Web address', status: 'pending' },
    ...(showOnHomepage ? [{
      detail: showOnHomepage ? 'Adding a clean shortcut to your private Homepage.' : 'Leaving Homepage unchanged for now.',
      id: 'homepage',
      label: 'Homepage shortcut',
      status: 'pending',
    } satisfies InstallStep] : []),
    { detail: 'The app is ready to open.', id: 'ready', label: 'Ready', status: 'pending' },
  ];
}

// The server runs the install, so a reload or a second tab draws the same
// progress. A finished job has nothing left to show; a failed one keeps its steps.
export function installJobSteps(app: AppPackageSummary): InstallStep[] {
  const job = app.installJob;
  if (!job || job.status === 'succeeded') return [];
  const templates = defaultInstallSteps(true);
  return job.steps.map((step) => ({ ...templates.find((template) => template.id === step.id)!, seconds: step.seconds, status: step.status }));
}

export function installJobError(app: AppPackageSummary) {
  return app.installJob?.status === 'failed' ? app.installJob.error?.message || `Unable to install ${app.name}.` : '';
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function withMinimumInstallStep<T>(work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    const remaining = INSTALL_STEP_MIN_MS - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  }
}

export function resolveGuideValue(app: AppPackageSummary, value: string) {
  const config = new Map((app.instance?.config || [])
    .filter((item) => !item.secret)
    .map((item) => [item.key, String(item.value ?? '')]));
  return value
    .replace(/\$\{app\.publicUrl\}/gu, (match) => app.publicUrl || match)
    .replace(/\$\{config\.([a-z][A-Za-z0-9]*)\}/gu, (match, key) => config.get(key) || match);
}

// An update is described by the app's own version; the MOS package version never
// appears outside Advanced details. Either side may be undeclared on an
// external package.
export function updateHeadline(name: string, from: string | null, to: string | null): string {
  if (!from || !to) return 'A newer package of this app is available.';
  if (from === to) return `${name} stays on ${from}. This update changes how MOS runs it, not the app itself.`;
  return `${name} ${from} to ${to}.`;
}

export function appAdvancedFacts(app: AppPackageSummary): AdvancedFact[] {
  const projections = app.instance?.projections || [];
  return [
    { label: 'Package id', value: app.id },
    { label: 'MOS package version', value: app.version },
    { label: 'Service', value: app.services.map((service) => `${service.id}:${service.internalPort ?? '?'}`).join(', ') || 'None' },
    { label: 'Route', value: app.routes.map((route) => `${route.host} -> ${route.service}${route.kind === 'api' ? ' (api)' : ''}`).join(', ') || 'None' },
    { label: 'Volumes', value: app.services.flatMap((service) => service.volumes).join(', ') || 'None' },
    { label: 'Health', value: app.health ? `${app.health.type}: ${app.health.url}` : 'None' },
    { label: 'Projections', value: projections.length ? projections.map((projection) => `${projection.kind}: ${projection.status}`).join(', ') : 'Rendered during install' },
    ...(app.catalogUpdate?.available?.sourceChannel === 'added-source'
      ? [{
        code: true,
        label: 'Offered from commit',
        value: `${app.catalogUpdate.available.sourceRevision?.slice(0, 12) || 'unresolved'} · read ${sourceCheckedLabel(app.catalogUpdate.sourceCheckedAt)}`,
      }]
      : []),
    ...(app.instance?.config?.length
      ? [{ label: 'Config', value: app.instance.config.map((item) => `${item.key}: ${item.secret ? item.redactedLabel || 'secret stored' : item.value}`).join(', ') }]
      : []),
  ];
}

// An app a source offers has no icon file on this server to fetch: the source's
// download is discarded once its packages are read, so its icon travels inlined
// on the card instead of as a URL. Installed apps keep the served URL.
export function appIconSrc(app: Pick<AppPackageSummary, 'iconDataUrl' | 'iconUrl'>) {
  return app.iconUrl || app.iconDataUrl || undefined;
}

// A search query is treated as an external package source only when it is a full
// HTTPS repository URL (host plus at least owner/repo). The backend enforces the
// real host allowlist; this only avoids resolving on every ordinary keystroke.
export function repoUrlFromQuery(raw: string): string | null {
  const value = raw.trim();
  if (!/^https:\/\//iu.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.includes('.')) return null;
    if (url.pathname.split('/').filter(Boolean).length < 2) return null;
    return value;
  } catch { return null; }
}

export function externalDescription(card: ExternalCard) {
  return card.summary || card.homepage?.description || card.catalog.description || 'External MOS app package.';
}

export function updateNoticeTitle(comparison: UpdateComparison): string {
  if (comparison.updateStatus === 'current') return 'No update available';
  if (comparison.updateStatus === 'installed-newer') return 'The source offers an older version';
  if (comparison.compatibility === 'unsupported') return 'This update cannot be applied safely';
  return comparison.compatibility === 'owner-action-required' ? 'Review this before updating' : 'Ready to update';
}

// The app that would carry a human title is by definition not installed.
export function capabilityLabel(type: string): string {
  return type.replace(/[-_]+/gu, ' ').trim() || type;
}

// Plain-language explanation of one requested permission key, so an owner can see
// exactly what a package would be granted before installing it and exactly what
// an update would add to that.
export function permissionLabel(permission: string): { detail: string; label: string } {
  const separator = permission.indexOf(':');
  const kind = separator === -1 ? permission : permission.slice(0, separator);
  const value = separator === -1 ? '' : permission.slice(separator + 1);
  if (kind === 'route') return { detail: 'Gets its own HTTPS address under your MOS domain.', label: `Web address: ${value}` };
  if (kind === 'volume') return { detail: 'Reads and writes its own private, named storage volume.', label: `Storage: ${value}` };
  if (kind === 'integration') return { detail: 'Can connect to a compatible app you choose. Nothing connects automatically.', label: `Integration: ${value}` };
  if (permission === 'provides-capability') return { detail: 'Other installed apps can connect to this one.', label: 'Provides a capability to other apps' };
  return { detail: '', label: permission };
}
