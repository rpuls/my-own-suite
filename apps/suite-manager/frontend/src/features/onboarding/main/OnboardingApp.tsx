import { useState } from 'react';

import { withSetupPath } from '../../../lib/base-path';
import { DeviceGuide } from '../radicale/DeviceGuide';
import { DeviceSelector, type RadicaleDevice } from '../radicale/DeviceSelector';
import { StepCard } from '../shared/components/StepCard';
import { ValueField } from '../shared/components/ValueField';
import type { CurrentActionSection, OnboardingStepView } from '../shared/types';
import { CredentialsField } from '../vaultwarden/CredentialsField';
import { useOnboardingView } from './useOnboardingView';

export default function OnboardingApp() {
  const { expandedStepId, isUiSettling, notifyStepAction, refreshModel, setExpandedStepId, state, view } =
    useOnboardingView();
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [copiedActionId, setCopiedActionId] = useState<string | null>(null);
  const [importContents, setImportContents] = useState<Record<string, string>>({});
  const [revealedActionIds, setRevealedActionIds] = useState<Record<string, boolean>>({});
  const [radicaleDevice, setRadicaleDevice] = useState<RadicaleDevice | null>(null);

  async function copyValue(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    setCopiedField(value);
    window.setTimeout(() => {
      setCopiedField((current) => (current === value ? null : current));
    }, 1400);
  }

  async function fetchProtectedText(path: string): Promise<string> {
    const response = await fetch(withSetupPath(path));

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Unable to load protected content.' }));
      throw new Error(typeof body.error === 'string' ? body.error : 'Unable to load protected content.');
    }

    return response.text();
  }

  async function triggerAction(actionId: string): Promise<void> {
    const response = await fetch(withSetupPath(`/api/onboarding/actions/${actionId}`), {
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : 'Unable to run onboarding action.');
    }

    await refreshModel();
  }

  async function copyImportContents(copyPath: string, actionId: string): Promise<void> {
    const text = importContents[actionId] || (await fetchProtectedText(copyPath));
    setImportContents((current) => ({ ...current, [actionId]: text }));
    await navigator.clipboard.writeText(text);
    setCopiedActionId(actionId);
    window.setTimeout(() => {
      setCopiedActionId((current) => (current === actionId ? null : current));
    }, 1400);
  }

  async function toggleImportVisibility(copyPath: string, actionId: string): Promise<void> {
    if (!revealedActionIds[actionId] && !importContents[actionId]) {
      const text = await fetchProtectedText(copyPath);
      setImportContents((current) => ({ ...current, [actionId]: text }));
    }

    setRevealedActionIds((current) => ({
      ...current,
      [actionId]: !current[actionId],
    }));
  }

  function toggleStep(step: OnboardingStepView): void {
    if (step.status === 'locked') {
      return;
    }

    setExpandedStepId((currentExpanded) => (currentExpanded === step.id ? null : step.id));
  }

  function renderSection(step: OnboardingStepView, section: CurrentActionSection, index: number) {
    const sectionDisabled = step.detectionState === 'detecting';
    const renderedSection =
      section.id.startsWith('manual-') || section.id === 'finish-radicale'
        ? getRadicaleSection(section, radicaleDevice)
        : section;

    return (
      <section className="suite-sequence-step" key={renderedSection.id}>
        <h3>
          {index + 1}. {renderedSection.title}
        </h3>

        {renderedSection.description ? <p className="suite-section-description">{renderedSection.description}</p> : null}

        {renderedSection.field ? (
          <ValueField
            copied={copiedField === renderedSection.field.value}
            disabled={sectionDisabled}
            label={renderedSection.field.label}
            onCopy={() => void copyValue(renderedSection.field!.value)}
            qrAlt={renderedSection.field.qrAlt}
            qrValue={renderedSection.field.qrValue}
            value={renderedSection.field.value}
          />
        ) : null}

        {renderedSection.action?.kind === 'link' && renderedSection.action.href ? (
          <div className="suite-actions">
            <a
              aria-disabled={sectionDisabled}
              className={`mos-btn mos-btn-primary${sectionDisabled ? ' is-disabled' : ''}`}
              href={renderedSection.action.href}
              onClick={(event) => {
                if (sectionDisabled) {
                  event.preventDefault();
                  return;
                }

                notifyStepAction(step.id, renderedSection.id);
              }}
              rel="noreferrer"
              tabIndex={sectionDisabled ? -1 : undefined}
              target="_blank"
            >
              {renderedSection.action.label}
            </a>
          </div>
        ) : null}

        {renderedSection.action?.kind === 'copy' && renderedSection.action.copyPath ? (
          <CredentialsField
            copied={copiedActionId === renderedSection.id}
            disabled={sectionDisabled}
            onCopy={() => void copyImportContents(renderedSection.action!.copyPath!, renderedSection.id)}
            onToggleVisibility={() => void toggleImportVisibility(renderedSection.action!.copyPath!, renderedSection.id)}
            revealed={Boolean(revealedActionIds[renderedSection.id])}
            value={importContents[renderedSection.id] || ''}
          />
        ) : null}

        {renderedSection.action?.kind === 'trigger' && renderedSection.action.actionId ? (
          <div className="suite-actions">
            <button
              className="mos-btn mos-btn-primary"
              disabled={sectionDisabled}
              onClick={() => {
                if (sectionDisabled) {
                  return;
                }
                notifyStepAction(step.id, renderedSection.id);
                void triggerAction(renderedSection.action!.actionId!);
              }}
              type="button"
            >
              {renderedSection.action.label}
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  function getRadicaleSection(section: CurrentActionSection, device: RadicaleDevice | null): CurrentActionSection {
    if (!device) {
      return section;
    }

    if (section.id === 'manual-url' && section.field) {
      if (device === 'ios') {
        return {
          ...section,
          description:
            'Paste this into the Server field on the Add CalDAV Account screen. Show QR only helps move the address to your iPhone.',
          title: 'Paste this into the Server field',
        };
      }

      if (device === 'android') {
        return {
          ...section,
          description:
            'Paste this into the server address or base URL field in DAVx5. Show QR only transfers the address to your phone.',
          title: 'Paste this into the server address field',
        };
      }

      if (device === 'mac') {
        return {
          ...section,
          description: 'Paste this into the server field when Apple Calendar asks for your CalDAV account details.',
          title: 'Paste this into the Server field',
        };
      }

      return {
        ...section,
        description: 'Paste this into the location or server field in Thunderbird.',
        title: 'Paste this into the server field',
      };
    }

    if (section.id === 'manual-username') {
      return {
        ...section,
        description: 'Use this exact value when your device asks for User Name or Username.',
        title: 'Paste this into the user name field',
      };
    }

    if (section.id === 'manual-password') {
      return {
        ...section,
        description:
          'Open Vaultwarden, find the Radicale item you imported in the previous step, and copy that password when your device asks for one.',
        title: 'Use the Radicale password from Vaultwarden',
      };
    }

    if (section.id === 'finish-radicale') {
      return {
        ...section,
        title: 'Finish this step after your calendar shows up',
      };
    }

    return section;
  }

  function getRadicaleSections(step: OnboardingStepView): CurrentActionSection[] {
    if (step.id !== 'connect-radicale' || !radicaleDevice) {
      return [];
    }

    const visibleIds = ['manual-url', 'manual-username', 'manual-password', 'finish-radicale'];
    return step.sections.filter((section) => visibleIds.includes(section.id));
  }

  function renderStep(step: OnboardingStepView) {
    const expanded = step.status !== 'locked' && expandedStepId === step.id;
    const visibleSections = step.id === 'connect-radicale' ? getRadicaleSections(step) : step.sections;

    return (
      <StepCard
        detectionState={step.detectionState}
        expanded={expanded}
        key={step.id}
        onToggle={() => toggleStep(step)}
        step={step}
      >
        <p className="suite-meta">{step.summary}</p>
        {step.id === 'connect-radicale' ? (
          <>
            <DeviceSelector onSelect={setRadicaleDevice} selectedDevice={radicaleDevice} />
            {radicaleDevice ? <DeviceGuide device={radicaleDevice} /> : null}
          </>
        ) : null}
        {visibleSections.length ? (
          <div className="suite-sequence">{visibleSections.map((section, index) => renderSection(step, section, index))}</div>
        ) : null}
      </StepCard>
    );
  }

  return (
    <main className="suite-app">
      <section className="mos-shell suite-hero">
        <span className="mos-eyebrow">My Own Suite</span>
        <h1>Finish setup</h1>
        <p className="suite-lead">
          One step at a time. The onboarding flow should tell the user what matters right now, not dump the whole stack at
          once.
        </p>
      </section>

      {state.kind === 'loading' ? (
        <section className="mos-shell">
          <div className="mos-panel suite-card">
            <p className="suite-empty">Loading suite state...</p>
          </div>
        </section>
      ) : null}

      {state.kind === 'error' ? (
        <section className="mos-shell">
          <div className="mos-panel suite-card">
            <p className="suite-error">{state.message}</p>
          </div>
        </section>
      ) : null}

      {view ? (
        <section className="mos-shell suite-grid">
          {view.snackbarNotice ? (
            <div className="suite-snackbar" role="status" aria-live="polite">
              {view.snackbarNotice.message}
            </div>
          ) : null}

          <div className="suite-steps">
            {view.steps.map((step) => renderStep(step))}

            <div className="suite-onboarding-footer">
              <button
                className="suite-subtle-button"
                disabled={isUiSettling}
                onClick={() => {
                  if (
                    window.confirm(
                      'Leave onboarding and go to Homepage? Only do this if you already know how to finish the remaining setup manually.',
                    )
                  ) {
                    window.location.assign(view.homepageUrl);
                  }
                }}
                type="button"
              >
                Skip onboarding
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
