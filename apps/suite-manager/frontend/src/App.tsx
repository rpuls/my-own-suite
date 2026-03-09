import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Eye, EyeOff, LockKeyhole } from 'lucide-react';

import type { CurrentActionSection, OnboardingModel, OnboardingStep, OnboardingStepStatus } from './types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; model: OnboardingModel }
  | { kind: 'error'; message: string };

async function loadModel(token: string): Promise<OnboardingModel> {
  const headers = token ? { 'x-bootstrap-token': token } : undefined;
  const response = await fetch('/api/onboarding', { headers });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : 'Unable to load onboarding state.');
  }

  return body as OnboardingModel;
}

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [token, setToken] = useState(() => window.sessionStorage.getItem('suite-manager-bootstrap-token') || '');
  const [tokenDraft, setTokenDraft] = useState(token);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [copiedActionId, setCopiedActionId] = useState<string | null>(null);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [importContents, setImportContents] = useState<Record<string, string>>({});
  const [revealedActionIds, setRevealedActionIds] = useState<Record<string, boolean>>({});

  const model = state.kind === 'loaded' ? state.model : null;
  const steps = model?.steps ?? [];

  async function refreshModel(activeToken: string): Promise<void> {
    const nextModel = await loadModel(activeToken);
    setState({ kind: 'loaded', model: nextModel });
  }

  useEffect(() => {
    let cancelled = false;

    void loadModel(token)
      .then((model) => {
        if (!cancelled) {
          setState({ kind: 'loaded', model });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Unable to load onboarding state.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

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
  }, [state, token]);

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

  function unlock(): void {
    window.sessionStorage.setItem('suite-manager-bootstrap-token', tokenDraft);
    setToken(tokenDraft);
  }

  function lock(): void {
    window.sessionStorage.removeItem('suite-manager-bootstrap-token');
    setToken('');
    setTokenDraft('');
  }

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

  async function downloadFile(downloadPath: string): Promise<void> {
    const headers: Record<string, string> = {};

    if (token) {
      headers['x-bootstrap-token'] = token;
    }

    const response = await fetch(downloadPath, { headers });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Unable to download import file.' }));
      throw new Error(typeof body.error === 'string' ? body.error : 'Unable to download import file.');
    }

    const blob = await response.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'my-own-suite-vaultwarden-import.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(objectUrl);
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

  function statusLabel(status: OnboardingStepStatus): string {
    if (status === 'completed') {
      return 'Completed';
    }

    if (status === 'locked') {
      return 'Waiting';
    }

    return 'Current';
  }

  function statusIcon(status: OnboardingStepStatus) {
    if (status === 'completed') {
      return <CheckCircle2 aria-hidden="true" className="suite-step-status-icon" />;
    }

    if (status === 'locked') {
      return <LockKeyhole aria-hidden="true" className="suite-step-status-icon" />;
    }

    return null;
  }

  function renderSection(section: CurrentActionSection, index: number) {
    return (
      <section className="suite-sequence-step" key={section.id}>
        <h3>
          {index + 1}. {section.title}
        </h3>

        {section.field ? (
          <div className="suite-field">
            <div className="suite-field-header">
              <span className="suite-field-label">{section.field.label}</span>
              <button className="suite-copy-button" onClick={() => void copyValue(section.field!.value)} type="button">
                <Copy aria-hidden="true" className="suite-inline-icon" />
                {copiedField === section.field.value ? 'Copied' : 'Copy'}
              </button>
            </div>
            <span className="suite-field-value">{section.field.value}</span>
          </div>
        ) : null}

        {section.action?.kind === 'link' && section.action.href ? (
          <div className="suite-actions">
            <a className="mos-btn mos-btn-primary" href={section.action.href} rel="noreferrer" target="_blank">
              {section.action.label}
            </a>
          </div>
        ) : null}

        {section.action?.kind === 'download' && section.action.downloadPath ? (
          <div className="suite-actions">
            <button
              className="mos-btn mos-btn-primary"
              onClick={() => void downloadFile(section.action!.downloadPath!)}
              type="button"
            >
              {section.action.label}
            </button>
          </div>
        ) : null}

        {section.action?.kind === 'copy' && section.action.copyPath ? (
          <div className="suite-field">
            <div className="suite-field-header">
              <span className="suite-field-label">Credentials</span>
              <div className="suite-field-actions">
                <button
                  className="suite-copy-button"
                  onClick={() => void toggleImportVisibility(section.action!.copyPath!, section.id)}
                  type="button"
                >
                  {revealedActionIds[section.id] ? (
                    <EyeOff aria-hidden="true" className="suite-inline-icon" />
                  ) : (
                    <Eye aria-hidden="true" className="suite-inline-icon" />
                  )}
                  {revealedActionIds[section.id] ? 'Hide' : 'View'}
                </button>
                <button
                  className="suite-copy-button"
                  onClick={() => void copyImportContents(section.action!.copyPath!, section.id)}
                  type="button"
                >
                  <Copy aria-hidden="true" className="suite-inline-icon" />
                  {copiedActionId === section.id ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <span className={`suite-field-value suite-field-secret-value${revealedActionIds[section.id] ? ' is-revealed' : ''}`}>
              {revealedActionIds[section.id] ? importContents[section.id] || '' : '••••••••••••••••'}
            </span>
          </div>
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

  function renderStep(step: OnboardingStep) {
    const expanded = step.status !== 'locked' && expandedStepId === step.id;
    const cardClassName = [
      'suite-step-card',
      `is-${step.status}`,
      expanded ? 'is-expanded' : 'is-collapsed',
    ].join(' ');

    return (
      <article className={cardClassName} key={step.id}>
        <button
          className="suite-step-header"
          disabled={step.status === 'locked'}
          onClick={() => toggleStep(step)}
          type="button"
        >
          <div className="suite-step-heading">
            <h2>{step.title}</h2>
          </div>
          <span className={`suite-step-status is-${step.status}`}>
            {statusIcon(step.status)}
            {statusLabel(step.status)}
          </span>
        </button>

        <div className="suite-step-body">
          <div className="suite-step-body-inner">
            <p className="suite-meta">{step.summary}</p>
            {step.sections.length ? (
              <div className="suite-sequence">{step.sections.map((section, index) => renderSection(section, index))}</div>
            ) : null}
          </div>
        </div>
      </article>
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
          </div>

          <div className="mos-panel suite-card suite-current">
            {model.requiresToken ? (
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
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
