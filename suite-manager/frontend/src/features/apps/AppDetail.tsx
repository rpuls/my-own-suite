import { useEffect, useState } from 'react';

import { ActionMenu, AdvancedPanel, AppConnect, Dialog, Icon, Notice, TextInput, Tooltip } from '../../components/ui';
import { AppConfigDialog, ownerDefault } from './AppConfigDialog';
import { PrivacyChangeRow, PrivacyFactsTile, PrivacyPostureDialog } from './PrivacyPosture';
import { ProgressSteps } from './ProgressSteps';
import { isNotAssessed } from './privacy-posture';
import type { Owner } from '../setup/types';
import { jsonResponse, postJson } from '../../lib/api';
import { appSourceLabel, sourceCheckedLabel } from '../../lib/app-sources';
import { AppHealthIndicator, AppIcon } from './AppCard';
import { appAddress, appAdvancedFacts, appIconSrc, capabilityLabel, categoryLabel, descriptionFor, failureCopy, formatCores, formatMemory, guideStatusLabel, hasGuide, hasHomepageContribution, hasPrimaryAppDestination, isCompanionApp, permissionLabel, primaryCategory, requirementsFor, resolveGuideValue, resourceLabel, runtimeApplied, runtimeRouteApplied, serviceExposed, serviceRoleLabel, shortReplaces, summaryFor, updateHeadline, updateJobSteps, updateNoticeTitle } from './model';
import type { AppJob, AppPackageSummary, InstallStep, UnmetRequirement, UpdateComparison, UpdateStep } from './types';

// The pasted-external install keeps its own boxed setup form: that flow is
// deliberately a different, more cautious thing than installing a reviewed
// catalog app, and it has no instance to show settings for afterwards.
export function AppSetupPanel({ disabled, fields, onChange, values }: {
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

// SIBLING VISUAL — the public site's app drawer renders the same meter
// (see the `meter` helper in site/src/components/AppCatalog.astro); keep the
// level mapping and look in sync.
function ResourceMeter({ level }: { level: string }) {
  const filled = level === 'high' ? 3 : level === 'medium' ? 2 : level === 'low' ? 1 : 0;
  return <span aria-hidden="true" className={`suite-app-resource-meter${level === 'high' ? ' is-high' : ''}`}>
    {[1, 2, 3].map((bar) => <span className={bar <= filled ? 'is-filled' : ''} key={bar} />)}
  </span>;
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
  const sections = app.onboarding?.sections || [];
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

export function InstallButton({ disabled, installing, onClick, unmet = [] }: { disabled: boolean; installing: boolean; onClick: () => void; unmet?: UnmetRequirement[] }) {
  const button = <button className="mos-btn mos-btn-primary" disabled={disabled || unmet.length > 0} onClick={onClick} type="button">{installing ? 'Installing...' : 'Install'}</button>;
  return unmet.length ? <Tooltip label={unmet.map((item) => item.reason).join(' ')}>{button}</Tooltip> : button;
}

export function AppDetail({
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
  const [guideOpen, setGuideOpen] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  // One dialog for install and for settings afterwards, so an app is configured
  // in a single place rather than in a "Prepare" panel before and a separate
  // technical dialog after.
  const [configOpen, setConfigOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [slideIdx, setSlideIdx] = useState(0);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [comparison, setComparison] = useState<UpdateComparison | null>(null);
  const [comparisonError, setComparisonError] = useState('');
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [updateInput, setUpdateInput] = useState<Record<string, string>>({});
  const [startingUpdate, setStartingUpdate] = useState(false);
  const [updateStartedAt, setUpdateStartedAt] = useState('');
  const [applyError, setApplyError] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState('');
  const ready = runtimeApplied(app);
  const requirements = requirementsFor(app);
  const updateRunning = app.updateJob?.status === 'running';
  const updating = startingUpdate || updateRunning;
  // The job this dialog started, as opposed to one begun in another tab or before a reload.
  const dialogJob = updateStartedAt && app.updateJob?.startedAt === updateStartedAt ? app.updateJob : null;
  const homepageAvailable = hasHomepageContribution(app);
  const primaryDestination = hasPrimaryAppDestination(app);
  const disabled = app.instance?.status === 'disabled';
  const url = app.publicUrl;
  const screenshots = app.catalog.screenshots;
  const cover = screenshots[0];
  const guideCompleted = app.instance?.guideState?.status === 'completed';
  const relatedIds = app.catalog.related.length
    ? app.catalog.related
    : packages.filter((item) => primaryCategory(item) === primaryCategory(app) && item.id !== app.id).slice(0, 3).map((item) => item.id);
  const related = relatedIds.map((id) => packages.find((item) => item.id === id)).filter(Boolean) as AppPackageSummary[];
  // An update applies only when there is a newer package to apply, MOS can apply
  // it safely, and every value the new version newly requires has been given.
  const canApplyUpdate = Boolean(comparison)
    && comparison!.updateStatus === 'update-available'
    && comparison!.compatibility !== 'unsupported'
    && comparison!.requiredInput.every((field) => (updateInput[field.id] || '').trim())
    && !updating;
  const ownerChanges = comparison ? comparison.changes.filter((change) => change.classification !== 'automatically-handled') : [];
  const handledChanges = comparison ? comparison.changes.filter((change) => change.classification === 'automatically-handled') : [];
  const connections = app.compatibility?.connections || [];
  const connectedBy = app.compatibility?.connectedBy || [];
  const missingUsefulPeers = app.compatibility?.missingUsefulPeers || [];
  const installedCompatiblePeers = packages.filter((item) => item.id !== app.id && item.instance && item.capabilities.exports.some((capability) => app.capabilities.usefulness.requiresOneOf.includes(capability.type)));

  useEffect(() => {
    setGuideOpen(false);
    setPrivacyOpen(false);
    setConfigOpen(false);
    setGalleryOpen(false);
    setSlideIdx(0);
    setResourcesOpen(false);
    setComparison(null);
    setComparisonError('');
    setUpdateInput({});
    setUpdateStartedAt('');
    setApplyError('');
    setRecoverError('');
  }, [app.id, owner]);

  useEffect(() => {
    if (dialogJob?.status !== 'succeeded') return;
    setComparison(null);
    setUpdateInput({});
    setUpdateStartedAt('');
  }, [dialogJob?.status]);

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
  // The server runs the update and the dialog follows it through the app list.
  async function applyUpdate() {
    if (!comparison) return;
    setStartingUpdate(true);
    setApplyError('');
    try {
      const { updateJob } = await postJson<{ updateJob: AppJob<UpdateStep> }>(
        `/suite-manager/api/apps/packages/${encodeURIComponent(app.id)}/update-job`,
        { config: updateInput, confirmationToken: comparison.confirmationToken },
        `Unable to update ${app.name}.`,
      );
      setUpdateStartedAt(updateJob.startedAt);
      await onUpdated();
    } catch (caught) {
      setApplyError(caught instanceof Error ? caught.message : `Unable to update ${app.name}.`);
    } finally { setStartingUpdate(false); }
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

  // The dialog hands over what the owner filled in and closes; progress belongs
  // on the detail page behind it, where it stays visible for the whole install.
  function submitInstall(options: { config: Record<string, string>; showOnHomepage: boolean }) {
    setConfigOpen(false);
    onInstall(app, options);
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
  // Null means no listing at all — removed, paused, never reached — not an unticked clock.
  const sourceReadAt = app.catalogUpdate?.sourceCheckedAt || null;
  const canRestartRuntime = Boolean(runtimeRouteApplied(app) && !disabled);
  const ownerEnv = app.instance?.env || [];
  const maintenanceActions = [
    ...(ready && hasGuide(app) && guideCompleted ? [{ label: 'Setup guide', onSelect: openGuide }] : []),
    // Unconditional: the dialog now leads with what the owner was asked for
    // when the app was created, in plain language. The technical half — MOS's
    // generated values and the environment editor — is behind an AdvancedPanel
    // inside it, which gates itself.
    ...(app.instance ? [{ label: 'Settings', onSelect: () => setConfigOpen(true) }] : []),
    ...(canRestartRuntime ? [{ label: 'Restart', onSelect: () => onLifecycle(app, 'restart') }] : []),
    ...(ready ? [{ label: 'Stop (keeps data)', onSelect: () => onLifecycle(app, 'stop') }] : []),
    ...(disabled ? [{ label: 'Start', onSelect: () => onLifecycle(app, 'enable') }] : []),
    ...(app.instance ? [{ label: 'Uninstall', onSelect: () => setConfirmUninstall(true) }] : []),
  ];

  return <div className={`suite-app-detail-layer${guideOpen ? ' has-guide' : ''}`}>
    <button aria-label="Close app details" className="suite-app-detail-backdrop" onClick={onClose} tabIndex={-1} type="button" />
    {guideOpen && hasGuide(app) ? <AppGuidePanel app={app} onClose={() => setGuideOpen(false)} onStatus={(status) => onGuideStatus(app, status)} updating={guideUpdating} /> : null}
    <aside aria-label={`${app.name} details`} aria-modal="true" className="suite-app-detail" role="dialog">
      {/* The first package screenshot is the hero backdrop, fading into the
          drawer surface behind the name. A package without screenshots keeps
          the same arrangement on the plain drawer surface. */}
      <header className={`suite-app-detail-hero${cover ? ' has-cover' : ''}`}>
        {cover ? <img alt="" className="suite-app-detail-cover" src={cover.src} /> : null}
        <div className="suite-app-detail-hero-top">
          {screenshots.length ? <button className="suite-app-hero-pill" onClick={() => { setSlideIdx(0); setGalleryOpen(true); }} type="button">
            <Icon name="screens" />
            {screenshots.length === 1 ? '1 screen' : `${screenshots.length} screens`}
          </button> : null}
          <button aria-label="Close app details" className="suite-app-hero-pill is-round" onClick={onClose} type="button"><Icon name="x" /></button>
        </div>
        <div className="suite-app-detail-hero-bottom">
          <AppIcon app={app} large />
          <div className="suite-app-detail-heading">
            <div className="suite-app-detail-title-row">
              <h2>{app.name}</h2>
              {app.appVersion ? <span className="suite-app-detail-version">{app.appVersion}</span> : null}
              <AppHealthIndicator app={app} />
            </div>
            <p className="suite-app-detail-replaces">
              {app.catalog.replaces.length ? <><span className="suite-app-detail-replaces-label">Replaces</span><strong>{shortReplaces(app.catalog.replaces)}</strong></> : null}
              <span className="suite-app-category-pill">{categoryLabel(primaryCategory(app))}</span>
              {app.external ? <span className="suite-app-external-pill">External &middot; Unverified</span> : null}
            </p>
          </div>
        </div>
        {/* The app's own front door, on the faded end of the screenshot. The
            hero never scrolls, so these stay reachable however far down the
            owner has read. */}
        <div className="suite-app-action-bar">
          {updateWaiting ? <>
            <button className="mos-btn mos-btn-primary" disabled={comparisonLoading || updateRunning} onClick={() => void prepareUpdate()} type="button">{updateRunning ? 'Updating...' : comparisonLoading ? 'Checking update...' : 'Review update'}</button>
            {primaryDestination ? <a className="mos-btn mos-btn-secondary" href={url}>Open {app.name}</a> : null}
          </> : ready && primaryDestination ? <a className="mos-btn mos-btn-primary" href={url}>Open {app.name}</a> : ready && isCompanionApp(app) && installedCompatiblePeers.length ? <button className="mos-btn mos-btn-primary" onClick={() => onSelect(installedCompatiblePeers[0]!)} type="button">View compatible app</button> : ready && isCompanionApp(app) ? <button className="mos-btn mos-btn-primary" disabled type="button">Install compatible app</button> : disabled ? <button className="mos-btn mos-btn-primary" disabled={installing} onClick={() => onLifecycle(app, 'enable')} type="button">{installing ? 'Starting...' : 'Start'}</button> : <InstallButton disabled={!app.validation.valid || installing} installing={installing} onClick={() => setConfigOpen(true)} unmet={app.unmetRequirements} />}
          {ready && hasGuide(app) && !guideCompleted ? <button className="mos-btn mos-btn-secondary" disabled={guideUpdating} onClick={openGuide} type="button">{guideStatusLabel(app)}</button> : null}
          <span className="suite-app-action-spacer" />
          {maintenanceActions.length ? <ActionMenu ariaLabel="More app actions" disabled={installing || guideUpdating || updateRunning} items={maintenanceActions} /> : null}
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
        </div>
      </header>

      <div className="suite-app-detail-scroll">
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
          {/* The failed update is the latest operation on record, so its
              diagnostics are the reason this notice exists. */}
          <AdvancedPanel
            facts={[
              { label: 'Error code', value: app.instance.updateRecovery.errorCode },
              ...(app.instance.lastFailure?.kind === 'update' ? [{ label: 'When', value: app.instance.lastFailure.completedAt || app.instance.lastFailure.startedAt }] : []),
            ]}
            output={app.instance.lastFailure?.kind === 'update' ? app.instance.lastFailure.diagnostics || undefined : undefined}
            reveal="on-failure"
          />
        </Notice> : null}

        {/* Only while the failure is still the last word on this app: the store
            stops reporting it as soon as anything succeeds, so a notice can
            never outlive the problem it describes. The plain sentence is the
            whole message for most owners; the code and the agent's own output
            sit in the panel, which is where a bug report copies them from.
            Suppressed while `installError` is set, because a failed install
            reloads the app and would otherwise say the same thing twice — once
            live in the stepper above and once from the record it just wrote. */}
        {app.instance?.lastFailure && !app.instance.updateRecovery && !installError ? <Notice title={failureCopy(app.instance.lastFailure).title} variant="warning">
          <p>{failureCopy(app.instance.lastFailure).detail}</p>
          <AdvancedPanel
            facts={[
              ...(app.instance.lastFailure.errorCode ? [{ label: 'Error code', value: app.instance.lastFailure.errorCode }] : []),
              { label: 'Operation', value: app.instance.lastFailure.kind },
              { label: 'When', value: app.instance.lastFailure.completedAt || app.instance.lastFailure.startedAt },
            ]}
            output={app.instance.lastFailure.diagnostics || undefined}
            reveal="on-failure"
          />
        </Notice> : null}

        <ProgressSteps error={installError} errorTitle="Install needs attention" steps={installSteps} />
        {app.installJob?.status === 'succeeded' && app.installJob.notice ? <Notice title="Its web address is not open yet" variant="warning">
          <p>{app.installJob.notice.message}</p>
          <AdvancedPanel facts={[{ label: 'Address check', value: app.installJob.notice.detail }]} reveal="technical-mode" />
        </Notice> : null}
        {/* An update left running when its dialog closed, or begun before a reload. */}
        {!comparison && updateRunning ? <ProgressSteps error="" errorTitle="" steps={updateJobSteps(app.updateJob)} /> : null}

        {!app.validation.valid ? <Notice title="This package cannot be installed yet" variant="warning"><ul>{app.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul></Notice> : null}
        {app.packageErrors?.length ? <Notice title="This package cannot be installed" variant="warning">
          <p>The source publishes this app, but MOS refuses it for the reasons below. Only its publisher can fix these.</p>
          <ul>{app.packageErrors.map((item) => <li key={item}>{item}</li>)}</ul>
        </Notice> : null}
        {missingUsefulPeers.length ? <Notice title="Needs a compatible app" variant="info"><p>{missingUsefulPeers[0]!.message}</p></Notice> : null}
        {ready && isCompanionApp(app) && !installedCompatiblePeers.length ? <Notice title="Companion app" variant="info"><p>{app.capabilities.usefulness.emptyState || 'Install a compatible app to use this service.'}</p></Notice> : null}
        {/* The same warning before and after installing, because the risk is the
            same one: an added source's app is not reviewed either way. */}
        {app.external ? <Notice title="Unverified external package" variant="warning">
          <p>{app.instance
            ? 'You installed this app from a source you added, not the verified MOS catalog. MOS has not reviewed its code and cannot vouch for any privacy claims it makes. It runs with a restricted profile: only its own named storage and its own web addresses.'
            : 'This app comes from a source you added, not the verified MOS catalog. MOS has not reviewed its code or checked any privacy claims. Installing it builds its Dockerfiles on your server, which runs commands the publisher wrote — with network access — before any of MOS’s runtime restrictions apply. Once running, it is restricted to its own named storage and its own web addresses.'}</p>
        </Notice> : null}

        {app.catalogUpdate?.status === 'update-available' && app.catalogUpdate.available ? <section className="suite-app-update-summary">
          {/* An added source's package need not declare appVersion, and the MOS
              package number is never shown to an owner. */}
          {!app.appVersion || !app.catalogUpdate.available.appVersion ? <div className="suite-app-update-unchanged">
            <span>{app.name}</span>
            <strong>A newer version is available</strong>
            <small>Its publisher does not state a version number, so MOS has none to show. Reviewing the update lists what changes.</small>
          </div> : app.appVersion === app.catalogUpdate.available.appVersion ? <div className="suite-app-update-unchanged">
            <span>{app.name} version</span>
            <strong>{app.appVersion}</strong>
            <small>Stays the same. This update changes how MOS runs it, not the app itself.</small>
          </div> : <>
            <div><span>Installed</span><strong>{app.appVersion}</strong></div>
            <div><span>Available</span><strong>{app.catalogUpdate.available.appVersion}</strong></div>
          </>}
          <div><span>Compatibility</span><strong>{app.catalogUpdate.available.compatibility === 'compatible' ? 'Ready for this MOS version' : `Requires MOS ${app.catalogUpdate.available.minimumMosVersion}`}</strong></div>
          {app.catalogUpdate.available.sourceChannel === 'added-source' ? <p>
            {`A source you added publishes this${sourceReadAt ? `, as MOS read its list ${sourceCheckedLabel(sourceReadAt)}` : ''}. MOS re-reads each source every few hours, and reviewing the update asks the repository directly. Nothing here has been reviewed by MOS.`}
          </p> : null}
          {updateWaiting ? null : <button className="mos-btn mos-btn-secondary" disabled={comparisonLoading} onClick={() => void prepareUpdate()} type="button">{comparisonLoading ? 'Checking update...' : 'Review update'}</button>}
          {comparisonError ? <p role="alert">{comparisonError}</p> : null}
        </section> : null}

        {/* An offered package carries the same status, and without the instance
            guard its card called the version on offer "Installed". */}
        {app.instance && app.catalogUpdate?.status === 'external-source' ? <section className="suite-app-update-summary">
          {app.appVersion ? <div><span>Installed</span><strong>{app.appVersion}</strong></div> : null}
          <div><span>Source</span><strong>A source you added</strong></div>
          <p>{sourceReadAt
            ? `MOS read what this source publishes ${sourceCheckedLabel(sourceReadAt)}, and it offers nothing newer than what you have. Checking asks its repository directly, right now.`
            : 'MOS has no current list of what this source publishes, so it cannot say whether a newer version exists — the source may have been removed or paused, or it may no longer publish this app. Checking asks its repository directly, right now.'}</p>
          <button className="mos-btn mos-btn-secondary" disabled={comparisonLoading} onClick={() => void prepareUpdate()} type="button">{comparisonLoading ? 'Checking...' : 'Check for updates'}</button>
          {comparisonError ? <p role="alert">{comparisonError}</p> : null}
        </section> : null}

        <section aria-label="App overview" className="suite-app-tiles">
          <PrivacyFactsTile advisories={app.advisories} onOpen={() => setPrivacyOpen(true)} privacy={app.privacy} />
          <button className="suite-app-resources-tile" onClick={() => setResourcesOpen(true)} type="button">
            <span className="suite-app-tile-label">Resources</span>
            <span className="suite-app-resources-line">
              <ResourceMeter level={app.catalog.resourceHint.level} />
              <strong>{resourceLabel(app)}</strong>
            </span>
            <span className="suite-app-tile-meta">
              {requirements ? `${formatMemory(requirements.memoryMb)} memory` : app.services.length === 1 ? 'Runs as 1 service' : app.services.length ? `Runs as ${app.services.length} services` : 'Details unavailable'}
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
          <p className="suite-app-help">{app.external
            ? 'These claims come from the package metadata. They are its publisher’s word about their own app: MOS has not verified them, and does not assess apps from sources you added.'
            : 'These claims come from the package metadata and have not been independently verified by MOS. See the Privacy Posture above for the evidence-backed MOS assessment.'}</p>
          {app.catalog.privacy.summary ? <p>{app.catalog.privacy.summary}</p> : null}
          {app.catalog.privacy.notes.length ? <ul>{app.catalog.privacy.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
        </section> : null}

        {connectedBy.length ? <section className="suite-app-detail-section">
          <h3>Connected to this app</h3>
          <div className="suite-app-connection-list">
            {connectedBy.map((peer) => {
              const peerPackage = packages.find((item) => item.id === peer.id);
              return <article className="suite-app-connection" key={peer.id}>
                <AppConnect
                  size="sm"
                  source={{ iconUrl: peerPackage ? appIconSrc(peerPackage) : undefined, name: peer.name }}
                  target={{ iconUrl: appIconSrc(app), name: app.name }}
                />
                <div className="suite-app-connection-copy">
                  <strong>{peer.name}</strong>
                  <small>Shares this app's network - {peer.status}</small>
                </div>
                {peerPackage ? <button className="mos-btn mos-btn-secondary" onClick={() => onSelect(peerPackage)} type="button">Open</button> : null}
              </article>;
            })}
          </div>
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
                  source={{ iconUrl: providerPackage ? appIconSrc(providerPackage) : undefined, name: connection.provider.name }}
                  target={{ iconUrl: appIconSrc(app), name: app.name }}
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
          {related.length ? <div className="suite-app-related-list">{related.map((item) => <button key={item.id} onClick={() => onSelect(item)} type="button"><AppIcon app={item} /><span><strong>{item.name}</strong><small>{summaryFor(item)}</small></span></button>)}</div> : null}
        </section> : null}

        <AdvancedPanel className="suite-app-advanced" facts={appAdvancedFacts(app)} reveal="technical-mode" />
      </div>
    </aside>
    {privacyOpen ? <PrivacyPostureDialog
      advisories={app.advisories}
      appName={app.name}
      onClose={() => setPrivacyOpen(false)}
      // A published assessment describes the app as MOS ships it. Owner-set
      // environment can change what leaves the server, so an instance that has
      // any says so — a fact about this owner's own data, which is why it is not
      // behind technical controls.
      overrideNotice={ownerEnv.length ? 'You have changed this app’s configuration. The assessment below describes it as MOS ships it.' : null}
      appVersion={app.appVersion}
      packageId={app.id}
      privacy={app.privacy}
      sourceLabel={app.source ? app.source.publisher || appSourceLabel(app.source.repository) : null}
    /> : null}
    {configOpen ? <AppConfigDialog
      appName={app.name}
      config={app.instance?.config || []}
      entries={ownerEnv}
      fields={app.setup.fields}
      homepageAvailable={homepageAvailable}
      installed={Boolean(app.instance)}
      installing={installing}
      onClose={() => setConfigOpen(false)}
      onInstall={submitInstall}
      onSaved={onUpdated}
      owner={owner}
      packageId={app.id}
      running={ready}
      service={app.routes[0]?.service || app.services[0]?.id || app.id}
      webAddress={appAddress(app)}
      webAddressKind={app.routes[0]?.kind || 'web'}
    /> : null}
    {galleryOpen && app.catalog.screenshots.length ? <Dialog className="suite-app-gallery-dialog" onClose={() => setGalleryOpen(false)} title={`${app.name} screens`}>
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
      footer={<button className="mos-btn mos-btn-secondary" onClick={() => setResourcesOpen(false)} type="button">Close</button>}
      onClose={() => setResourcesOpen(false)}
      title="What runs on your server"
    >
      <div className="suite-app-resources-summary">
        <ResourceMeter level={app.catalog.resourceHint.level} />
        <strong>{resourceLabel(app)}</strong>
      </div>
      {app.catalog.resourceHint.description ? <p className="suite-app-resources-note">{app.catalog.resourceHint.description}</p> : null}
      {requirements ? <>
        <dl className="suite-app-requirements">
          <div>
            <dt>Memory</dt>
            <dd><strong>{formatMemory(requirements.memoryMb)}</strong>{requirements.memoryPeakMb ? <span>up to {formatMemory(requirements.memoryPeakMb)} while it works</span> : <span>steady</span>}</dd>
          </div>
          <div>
            <dt>Processor</dt>
            <dd><strong>{formatCores(requirements.cpuCores)}</strong>{requirements.cpuPeakCores ? <span>up to {formatCores(requirements.cpuPeakCores)} while it works</span> : <span>steady</span>}</dd>
          </div>
        </dl>
        <p className="suite-meta">Figures the package declares, not a limit MOS enforces. The steady figure is what this app holds all day and is what to add up when deciding whether another app fits; the peak is headroom that only has to be free while the app is busy.</p>
      </> : null}
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
              {/* Only worth splitting out when there is more than one share to
                  account for; on a single-service app it would just restate
                  the package total printed above. */}
              {app.services.length > 1 && service.requires ? <small className="suite-app-service-requires">
                {formatMemory(service.requires.memoryMb)} memory{service.requires.memoryPeakMb ? ` (${formatMemory(service.requires.memoryPeakMb)} at peak)` : ''} &middot; {formatCores(service.requires.cpuCores)}
              </small> : null}
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
        <button className="mos-btn mos-btn-secondary" disabled={startingUpdate} onClick={() => setComparison(null)} type="button">{comparison.updateStatus === 'update-available' && !updating ? 'Cancel' : 'Close'}</button>
        {comparison.updateStatus === 'update-available' ? <button className="mos-btn mos-btn-primary" disabled={!canApplyUpdate} onClick={() => void applyUpdate()} type="button">{updating ? 'Updating...' : 'Update'}</button> : null}
      </>}
      onClose={() => { if (!startingUpdate) setComparison(null); }}
      title={`Review ${app.name} update`}
    >
      <div className="suite-app-update-dialog">
        <Notice title={updateNoticeTitle(comparison)} variant={comparison.compatibility === 'unsupported' ? 'warning' : 'info'}>
          <p>{comparison.updateStatus === 'current'
            ? `${app.name} is already running the newest package its source offers.`
            : comparison.updateStatus === 'installed-newer'
              ? 'The source offers an older package than the one installed. MOS does not downgrade apps.'
              : updateHeadline(app.name, comparison.installed.appVersion, comparison.candidate.appVersion)}</p>
        </Notice>
        {comparison.validation.errors.length ? <Notice title="This update cannot be applied" variant="warning">
          <ul>{comparison.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>
        </Notice> : null}
        {app.external && comparison.updateStatus === 'update-available' ? <Notice title="Updating runs the publisher's build" variant="warning">
          <p>Updating rebuilds this package&apos;s Dockerfiles on your server, which runs commands the publisher wrote &mdash; with network access &mdash; before MOS&apos;s runtime restrictions apply. Update only if you still trust the repository this app came from.</p>
        </Notice> : null}
        {comparison.requirements.length ? <Notice title="This version needs another app first" variant="warning">
          <p>{`${app.name} declares that it cannot do its job without ${comparison.requirements.length === 1 ? 'an app providing' : 'an app providing one of'} ${comparison.requirements.map((item) => capabilityLabel(item.type)).join(' or ')}. Nothing installed provides that today, so updating now leaves ${app.name} running with nothing to hand its work to.`}</p>
          {comparison.requirements.flatMap((item) => item.providers).length ? <>
            <p>Do this first:</p>
            <ul>{comparison.requirements.flatMap((item) => item.providers.map((provider) => <li key={`${item.type}-${provider.id}`}>
              <strong>{provider.action === 'update' ? `Update ${provider.name}` : `Install ${provider.name}`}</strong>
              {provider.version ? ` (${provider.version})` : ''}
              {provider.action === 'update' ? ' — it is installed, but the version you have does not provide this yet.' : ' — it provides what this update needs.'}
            </li>))}</ul>
          </> : <p className="suite-meta">No app available on this server provides it, so there is nothing to install first. Updating is still allowed; {app.name} will simply have nothing to work with until one exists.</p>}
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
        {/* Nothing to compare where neither side was ever assessed. */}
        {isNotAssessed(comparison.installed.privacy) || isNotAssessed(comparison.candidate.privacy)
          ? null
          : <PrivacyChangeRow candidate={comparison.candidate.privacy} candidateVersion={comparison.candidate.appVersion} installed={comparison.installed.privacy} installedVersion={comparison.installed.appVersion} />}
        <dl><dt>Backup</dt><dd>{comparison.metadata.backupRequired ? 'Required' : 'Not declared as required'}</dd><dt>Downtime</dt><dd>{comparison.metadata.downtime}</dd><dt>Rollback</dt><dd>{comparison.metadata.rollback}</dd></dl>
        {comparison.changes.length ? <>
          {ownerChanges.length ? <div className="suite-app-update-changes">
            <p>What this changes for you</p>
            <ul>{ownerChanges.map((change, index) => <li key={`owner-${change.area}-${index}`}><strong>{change.area}</strong>: {change.summary}</li>)}</ul>
          </div> : null}
          {handledChanges.length ? <div className="suite-app-update-changes">
            <p>MOS applies these for you</p>
            <ul>{handledChanges.map((change, index) => <li key={`auto-${change.area}-${index}`}><strong>{change.area}</strong>: {change.summary}</li>)}</ul>
          </div> : null}
        </> : <p>No structural changes detected.</p>}
        {comparison.requiredInput.map((field) => <TextInput autoComplete={field.secret ? 'new-password' : 'off'} disabled={updating} key={field.id} label={field.label} onChange={(event) => { const { value } = event.currentTarget; setUpdateInput((current) => ({ ...current, [field.id]: value })); }} type={field.secret ? 'password' : field.type === 'email' ? 'email' : 'text'} value={updateInput[field.id] || ''} />)}
        {comparison.requiredInput.length ? <p className="suite-meta">{app.name} needs these values before it can start on the new version. They are stored with this app the same way its other settings are.</p> : null}
        {applyError ? <Notice title="The update did not finish" variant="warning"><p>{applyError}</p></Notice> : null}
        {dialogJob ? <>
          <ProgressSteps error={dialogJob.error?.message || (dialogJob.status === 'failed' ? `Unable to update ${app.name}.` : '')} errorTitle="The update did not finish" steps={updateJobSteps(dialogJob)} />
          {dialogJob.status === 'running' ? <p className="suite-meta">You can close this window. The update carries on, and its progress stays on this page.</p> : null}
        </> : null}
        <AdvancedPanel output={JSON.stringify(comparison, null, 2)} reveal="technical-mode" />
      </div>
    </Dialog> : null}
  </div>;
}
