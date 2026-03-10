import { useEffect, useState } from 'react';

import { StepCard } from '../shared/components/StepCard';
import { ValueField } from '../shared/components/ValueField';
import type { CurrentActionSection, OnboardingStep } from '../shared/types';
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
    return (
      <section className="suite-sequence-step" key={section.id}>
        <h3>
          {index + 1}. {section.title}
        </h3>

        {section.description ? <p className="suite-section-description">{section.description}</p> : null}

        {section.field ? (
          <ValueField
            copied={copiedField === section.field.value}
            label={section.field.label}
            onCopy={() => void copyValue(section.field!.value)}
            value={section.field.value}
          />
        ) : null}

        {section.action?.kind === 'link' && section.action.href ? (
          <div className="suite-actions">
            <a className="mos-btn mos-btn-primary" href={section.action.href} rel="noreferrer" target="_blank">
              {section.action.label}
            </a>
          </div>
        ) : null}

        {section.qrCode ? (
          <div className="suite-qr-card">
            <img alt={section.qrCode.alt} className="suite-qr-image" src={section.qrCode.src} />
            {section.qrCode.caption ? <span className="suite-qr-caption">{section.qrCode.caption}</span> : null}
          </div>
        ) : null}

        {section.action?.kind === 'copy' && section.action.copyPath ? (
          <CredentialsField
            copied={copiedActionId === section.id}
            onCopy={() => void copyImportContents(section.action!.copyPath!, section.id)}
            onToggleVisibility={() => void toggleImportVisibility(section.action!.copyPath!, section.id)}
            revealed={Boolean(revealedActionIds[section.id])}
            value={importContents[section.id] || ''}
          />
        ) : null}

        {section.action?.kind === 'trigger' && section.action.actionId ? (
          <div className="suite-actions">
            <button
              className="mos-btn mos-btn-primary"
              onClick={() => void triggerAction(section.action!.actionId!)}
              type="button"
            >
              {section.action.label}
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  function getRadicaleSections(step: OnboardingStep): CurrentActionSection[] {
    if (step.id !== 'connect-radicale' || !radicaleDevice) {
      return [];
    }

    const commonIds = ['manual-url', 'manual-username', 'manual-password', 'finish-radicale'];
    const androidIds = ['android-qr', ...commonIds];

    const visibleIds =
      radicaleDevice === 'android'
        ? androidIds
        : radicaleDevice === 'apple'
          ? commonIds
          : commonIds;

    return step.sections.filter((section) => visibleIds.includes(section.id));
  }

  function renderStep(step: OnboardingStep) {
    const expanded = step.status !== 'locked' && expandedStepId === step.id;
    const visibleSections = step.id === 'connect-radicale' ? getRadicaleSections(step) : step.sections;

    return (
      <StepCard expanded={expanded} key={step.id} onToggle={() => toggleStep(step)} step={step}>
        <p className="suite-meta">{step.summary}</p>
        {step.id === 'connect-radicale' ? (
          <DeviceSelector onSelect={setRadicaleDevice} selectedDevice={radicaleDevice} />
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
          <div className="suite-steps">{steps.map((step) => renderStep(step))}</div>

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
