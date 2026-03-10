import { useEffect, useState } from 'react';

import { StepCard } from '../shared/components/StepCard';
import { ValueField } from '../shared/components/ValueField';
import type { CurrentActionSection, OnboardingStep } from '../shared/types';
import { DeviceGuide } from '../radicale/DeviceGuide';
import { DeviceSelector, type RadicaleDevice } from '../radicale/DeviceSelector';
import { CredentialsField } from '../vaultwarden/CredentialsField';
import { useOnboarding } from './useOnboarding';

export default function OnboardingApp() {
  const { lock, refreshModel, setTokenDraft, state, token, tokenDraft, unlock } = useOnboarding();
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [copiedActionId, setCopiedActionId] = useState<string | null>(null);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [importContents, setImportContents] = useState<Record<string, string>>({});
  const [revealedActionIds, setRevealedActionIds] = useState<Record<string, boolean>>({});
  const [radicaleDevice, setRadicaleDevice] = useState<RadicaleDevice | null>(null);

  const model = state.kind === 'loaded' ? state.model : null;
  const steps = model?.steps ?? [];

  useEffect(() => {
    if (state.kind !== 'loaded' || state.model.currentStepId !== 'activate-vaultwarden') {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void refreshModel(token).catch(() => undefined);
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [refreshModel, state, token]);

  useEffect(() => {
    if (state.kind !== 'loaded' || !state.model.currentStepId) {
      return;
    }

    if (document.visibilityState === 'visible') {
      const timer = window.setTimeout(() => {
        setExpandedStepId(state.model.currentStepId);
      }, 1000);

      return () => {
        window.clearTimeout(timer);
      };
    }

    return;
  }, [state]);

  useEffect(() => {
    let timer: number | null = null;

    function handleVisibilityChange(): void {
      if (document.visibilityState !== 'visible') {
        return;
      }

      const targetStepId = state.kind === 'loaded' ? state.model.currentStepId : null;
      if (!targetStepId) {
        return;
      }

      timer = window.setTimeout(() => {
        setExpandedStepId(targetStepId);
      }, 1000);
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [state]);

  async function copyValue(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    setCopiedField(value);
    window.setTimeout(() => {
      setCopiedField((current) => (current === value ? null : current));
    }, 1400);
  }

  async function fetchProtectedText(path: string): Promise<string> {
    const headers = token ? { 'x-bootstrap-token': token } : undefined;
    const response = await fetch(path, { headers });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Unable to load protected content.' }));
      throw new Error(typeof body.error === 'string' ? body.error : 'Unable to load protected content.');
    }

    return response.text();
  }

  async function triggerAction(actionId: string): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['x-bootstrap-token'] = token;
    }

    const response = await fetch(`/api/onboarding/actions/${actionId}`, {
      method: 'POST',
      headers,
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : 'Unable to run onboarding action.');
    }

    await refreshModel(token);
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

  function toggleStep(step: OnboardingStep): void {
    if (step.status === 'locked') {
      return;
    }

    setExpandedStepId((currentExpanded) => (currentExpanded === step.id ? null : step.id));
  }

  function renderSection(section: CurrentActionSection, index: number) {
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
            label={renderedSection.field.label}
            onCopy={() => void copyValue(renderedSection.field!.value)}
            qrAlt={renderedSection.field.qrAlt}
            qrValue={renderedSection.field.qrValue}
            value={renderedSection.field.value}
          />
        ) : null}

        {renderedSection.action?.kind === 'link' && renderedSection.action.href ? (
          <div className="suite-actions">
            <a className="mos-btn mos-btn-primary" href={renderedSection.action.href} rel="noreferrer" target="_blank">
              {renderedSection.action.label}
            </a>
          </div>
        ) : null}

        {renderedSection.action?.kind === 'copy' && renderedSection.action.copyPath ? (
          <CredentialsField
            copied={copiedActionId === renderedSection.id}
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
              onClick={() => void triggerAction(renderedSection.action!.actionId!)}
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

  function getRadicaleSections(step: OnboardingStep): CurrentActionSection[] {
    if (step.id !== 'connect-radicale' || !radicaleDevice) {
      return [];
    }

    const commonIds = ['manual-url', 'manual-username', 'manual-password', 'finish-radicale'];

    const visibleIds =
      radicaleDevice === 'android' ? commonIds : commonIds;

    return step.sections.filter((section) => visibleIds.includes(section.id));
  }

  function renderStep(step: OnboardingStep) {
    const expanded = step.status !== 'locked' && expandedStepId === step.id;
    const visibleSections = step.id === 'connect-radicale' ? getRadicaleSections(step) : step.sections;

    return (
      <StepCard expanded={expanded} key={step.id} onToggle={() => toggleStep(step)} step={step}>
        <p className="suite-meta">{step.summary}</p>
        {step.id === 'connect-radicale' ? (
          <>
            <DeviceSelector onSelect={setRadicaleDevice} selectedDevice={radicaleDevice} />
            {radicaleDevice ? <DeviceGuide device={radicaleDevice} /> : null}
          </>
        ) : null}
        {visibleSections.length ? (
          <div className="suite-sequence">{visibleSections.map((section, index) => renderSection(section, index))}</div>
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
            <p className="suite-empty">Loading suite state…</p>
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

      {model ? (
        <section className="mos-shell suite-grid">
          <div className="suite-steps">
            {steps.map((step) => renderStep(step))}

            <div className="suite-onboarding-footer">
              <button
                className="suite-subtle-button"
                onClick={() => {
                  if (
                    window.confirm(
                      'Leave onboarding and go to Homepage? Only do this if you already know how to finish the remaining setup manually.',
                    )
                  ) {
                    window.location.assign(model.homepageUrl);
                  }
                }}
                type="button"
              >
                Skip onboarding
              </button>
            </div>
          </div>

          {model.requiresToken ? (
            <div className="mos-panel suite-card suite-current">
              <div className="suite-token-block">
                <h3>Bootstrap token</h3>
                <p className="suite-meta">Use this only when a current action needs access to generated credentials.</p>
                <div className="suite-token-form">
                  <input
                    onChange={(event) => setTokenDraft(event.target.value)}
                    placeholder="Bootstrap token"
                    type="password"
                    value={tokenDraft}
                  />
                  <div className="suite-token-actions">
                    <button className="mos-btn mos-btn-primary" onClick={unlock} type="button">
                      Unlock
                    </button>
                    {token ? (
                      <button className="mos-btn mos-btn-secondary" onClick={lock} type="button">
                        Lock
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
