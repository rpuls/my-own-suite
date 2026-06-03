import { AlertTriangle, CheckCircle2, Clipboard, RefreshCcw, RotateCcw, Save, SearchCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { withSetupPath } from '../../lib/base-path';
import CodeEditor from './CodeEditor';
import type {
  HomepageCaddyApplyResponse,
  HomepageCaddyProxyPreviewError,
  HomepageCaddyProxyPreviewResponse,
  HomepageConfigCapabilitiesResponse,
  HomepageConfigFile,
  HomepageConfigFileResponse,
  HomepageConfigListResponse,
  HomepageConfigValidationResponse,
  HomepageRestartResponse,
} from './types';

type EditorState =
  | { kind: 'loading' }
  | {
      content: string;
      dirty: boolean;
      errorMessage: string | null;
      file: HomepageConfigFile;
      files: HomepageConfigFile[];
      kind: 'loaded';
      restartCapabilities: HomepageConfigCapabilitiesResponse;
      restartMessage: string | null;
      savedAt: string | null;
    }
  | { kind: 'error'; message: string };

type ValidationState =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'loading' }
  | { kind: 'valid'; result: HomepageConfigValidationResponse }
  | { kind: 'invalid'; result: HomepageConfigValidationResponse }
  | { kind: 'error'; message: string };

async function readJson<T extends object>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({ error: fallback }))) as T | { error?: string };
  if (!response.ok) {
    throw new Error('error' in body && typeof body.error === 'string' ? body.error : fallback);
  }
  return body as T;
}

async function loadFile(name: string): Promise<HomepageConfigFileResponse> {
  const response = await fetch(withSetupPath(`/api/homepage-config/files/${encodeURIComponent(name)}`));
  return readJson<HomepageConfigFileResponse>(response, 'Unable to load Homepage config.');
}

async function loadFiles(): Promise<HomepageConfigFile[]> {
  const response = await fetch(withSetupPath('/api/homepage-config'));
  const body = await readJson<HomepageConfigListResponse>(response, 'Unable to load Homepage config files.');
  return body.files;
}

async function loadCapabilities(): Promise<HomepageConfigCapabilitiesResponse> {
  const response = await fetch(withSetupPath('/api/homepage-config/capabilities'));
  return readJson<HomepageConfigCapabilitiesResponse>(response, 'Unable to load Homepage restart capability.');
}

async function validateConfigFile(name: string, content: string): Promise<HomepageConfigValidationResponse> {
  const response = await fetch(withSetupPath(`/api/homepage-config/files/${encodeURIComponent(name)}/validate`), {
    body: JSON.stringify({ content }),
    headers: {
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  return readJson<HomepageConfigValidationResponse>(response, 'Unable to validate Homepage config.');
}

async function applyCaddyProxyPreview(): Promise<HomepageCaddyApplyResponse> {
  const response = await fetch(withSetupPath('/api/homepage-config/caddy-preview/apply'), {
    method: 'POST',
  });
  return readJson<HomepageCaddyApplyResponse>(response, 'Unable to apply external service config.');
}

async function restartHomepage(): Promise<HomepageRestartResponse> {
  const response = await fetch(withSetupPath('/api/homepage-config/restart-homepage'), {
    method: 'POST',
  });
  return readJson<HomepageRestartResponse>(response, 'Unable to restart Homepage.');
}

async function tryAutoRestartHomepage(shouldRestart: boolean): Promise<{
  errorMessage: string | null;
  restartMessage: string | null;
}> {
  if (!shouldRestart) {
    return {
      errorMessage: null,
      restartMessage: null,
    };
  }

  try {
    await restartHomepage();
    return {
      errorMessage: null,
      restartMessage: 'Homepage restart requested.',
    };
  } catch (error: unknown) {
    return {
      errorMessage: `Saved, but Homepage restart failed: ${
        error instanceof Error ? error.message : 'Unable to restart Homepage.'
      }`,
      restartMessage: null,
    };
  }
}

async function tryAutoApplyCaddyProxyRoutes(shouldApply: boolean): Promise<{
  applyMessage: string | null;
  errorMessage: string | null;
  preview: HomepageCaddyProxyPreviewResponse | null;
}> {
  if (!shouldApply) {
    return {
      applyMessage: null,
      errorMessage: null,
      preview: null,
    };
  }

  try {
    const result = await applyCaddyProxyPreview();
    return {
      applyMessage: 'External service links updated.',
      errorMessage: null,
      preview: result.preview,
    };
  } catch (error: unknown) {
    return {
      applyMessage: null,
      errorMessage: `Saved, but external service links could not be updated: ${
        error instanceof Error ? error.message : 'Unable to apply external service config.'
      }`,
      preview: null,
    };
  }
}

function combineErrorMessages(...messages: Array<string | null>): string | null {
  const visibleMessages = messages.filter((message): message is string => Boolean(message));
  return visibleMessages.length > 0 ? visibleMessages.join(' ') : null;
}

function labelForFile(name: string): string {
  return name.replace('.template', '').replace(/\.(yaml|css|js)$/u, '');
}

function humanizeValidationMessage(error: HomepageCaddyProxyPreviewError): string {
  return error.message
    .replace(/`href`/gu, 'The link URL')
    .replace(/`mos\.proxy\.upstream`/gu, 'The internal address')
    .replace(/`mos\.proxy` annotations/gu, 'external service settings')
    .replace(/Raw Caddy fields/gu, 'Advanced routing fields');
}

function validationSummary(result: HomepageConfigValidationResponse): string {
  if (!result.caddyPreview) {
    return 'No errors found.';
  }

  if (result.caddyPreview.routes.length === 0) {
    return 'No errors found. No external service links need updating.';
  }

  return `No errors found. ${result.caddyPreview.routes.length} external service link${
    result.caddyPreview.routes.length === 1 ? '' : 's'
  } ready to update.`;
}

function validationPreview(validationState: ValidationState): HomepageCaddyProxyPreviewResponse | null {
  if (validationState.kind === 'valid' || validationState.kind === 'invalid') {
    return validationState.result.caddyPreview;
  }

  return null;
}

function validationErrors(validationState: ValidationState): HomepageCaddyProxyPreviewError[] {
  if (validationState.kind === 'invalid') {
    return validationState.result.errors;
  }

  return [];
}

function buildAdvancedDetailsText(
  errors: HomepageCaddyProxyPreviewError[],
  preview: HomepageCaddyProxyPreviewResponse | null,
): string {
  const parts = ['Homepage config advanced details'];

  if (errors.length > 0) {
    parts.push(
      '',
      'Validation errors:',
      ...errors.map((error) => `- ${error.path}: ${error.message}`),
    );
  }

  if (preview) {
    parts.push(
      '',
      `Generated routes: ${preview.routes.length}`,
      `Status: ${preview.valid ? 'valid' : 'invalid'}`,
      '',
      'Generated Caddy config:',
      preview.caddyfile || '(none)',
    );
  }

  return parts.join('\n');
}

export default function HomepageConfigApp() {
  const [selectedFileName, setSelectedFileName] = useState('services.template.yaml');
  const [state, setState] = useState<EditorState>({ kind: 'loading' });
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [autoRestartHomepage, setAutoRestartHomepage] = useState(true);
  const [validationState, setValidationState] = useState<ValidationState>({ kind: 'idle' });
  const [externalLinksMessage, setExternalLinksMessage] = useState<string | null>(null);
  const [savedPreview, setSavedPreview] = useState<HomepageCaddyProxyPreviewResponse | null>(null);
  const [advancedDetailsOpen, setAdvancedDetailsOpen] = useState(false);
  const [advancedDetailsCopied, setAdvancedDetailsCopied] = useState(false);

  const selectedFile = useMemo(() => {
    if (state.kind !== 'loaded') {
      return null;
    }
    return state.files.find((file) => file.name === selectedFileName) || state.file;
  }, [selectedFileName, state]);

  const canSave = state.kind === 'loaded' && state.dirty && validationState.kind === 'valid' && !isSaving && !isResetting;
  const canValidate = state.kind === 'loaded' && state.dirty && validationState.kind !== 'loading' && !isSaving && !isResetting;
  const currentPreview = validationPreview(validationState) || savedPreview;
  const currentValidationErrors = validationErrors(validationState);

  async function refresh(nextFileName = selectedFileName): Promise<void> {
    setState({ kind: 'loading' });
    setValidationState({ kind: 'idle' });
    setExternalLinksMessage(null);
    setSavedPreview(null);
    try {
      const files = await loadFiles();
      const restartCapabilities = await loadCapabilities();
      const fileName = files.some((file) => file.name === nextFileName) ? nextFileName : files[0]?.name;
      if (!fileName) {
        throw new Error('No Homepage config files are available.');
      }
      const file = await loadFile(fileName);
      setSelectedFileName(fileName);
      setState({
        content: file.content,
        dirty: false,
        errorMessage: null,
        file: file.file,
        files,
        kind: 'loaded',
        restartCapabilities,
        restartMessage: null,
        savedAt: null,
      });
    } catch (error: unknown) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to load Homepage config.',
      });
    }
  }

  async function selectFile(name: string): Promise<void> {
    setSelectedFileName(name);
    setValidationState({ kind: 'idle' });
    setExternalLinksMessage(null);
    setSavedPreview(null);
    await refresh(name);
  }

  async function validateCurrentFile(): Promise<void> {
    if (state.kind !== 'loaded') {
      return;
    }

    setValidationState({ kind: 'loading' });
    setExternalLinksMessage(null);
    setSavedPreview(null);
    try {
      const result = await validateConfigFile(state.file.name, state.content);
      setValidationState(result.valid ? { kind: 'valid', result } : { kind: 'invalid', result });
    } catch (error: unknown) {
      setValidationState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to validate Homepage config.',
      });
    }
  }

  async function save(): Promise<void> {
    if (state.kind !== 'loaded' || !canSave) {
      return;
    }

    setIsSaving(true);
    setExternalLinksMessage(null);
    try {
      const response = await fetch(withSetupPath(`/api/homepage-config/files/${encodeURIComponent(state.file.name)}`), {
        body: JSON.stringify({ content: state.content }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'PUT',
      });
      const body = await readJson<HomepageConfigFileResponse>(response, 'Unable to save Homepage config.');
      const restart = await tryAutoRestartHomepage(
        state.restartCapabilities.homepageRestartAvailable && autoRestartHomepage,
      );
      const caddyApply = await tryAutoApplyCaddyProxyRoutes(
        state.file.name === 'services.template.yaml' &&
          state.restartCapabilities.caddyExternalProxyApplyAvailable,
      );
      setSavedPreview(caddyApply.preview);
      setExternalLinksMessage(caddyApply.applyMessage);
      setValidationState({ kind: 'idle' });
      setState({
        ...state,
        content: body.content,
        dirty: false,
        errorMessage: combineErrorMessages(restart.errorMessage, caddyApply.errorMessage),
        file: body.file,
        restartMessage: restart.restartMessage,
        savedAt: new Date().toLocaleTimeString(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to save Homepage config.';
      setState({
        ...state,
        errorMessage: message,
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function reset(): Promise<void> {
    if (state.kind !== 'loaded') {
      return;
    }

    const confirmed = window.confirm(
      `Reset ${state.file.name} to the bundled default?\n\nThis will overwrite the current saved Homepage config file.`,
    );
    if (!confirmed) {
      return;
    }

    setIsResetting(true);
    setExternalLinksMessage(null);
    setSavedPreview(null);
    try {
      const response = await fetch(
        withSetupPath(`/api/homepage-config/files/${encodeURIComponent(state.file.name)}/reset`),
        {
          method: 'POST',
        },
      );
      const body = await readJson<HomepageConfigFileResponse>(response, 'Unable to reset Homepage config.');
      const restart = await tryAutoRestartHomepage(
        state.restartCapabilities.homepageRestartAvailable && autoRestartHomepage,
      );
      const caddyApply = await tryAutoApplyCaddyProxyRoutes(
        state.file.name === 'services.template.yaml' &&
          state.restartCapabilities.caddyExternalProxyApplyAvailable,
      );
      setSavedPreview(caddyApply.preview);
      setExternalLinksMessage(caddyApply.applyMessage);
      setValidationState({ kind: 'idle' });
      setState({
        ...state,
        content: body.content,
        dirty: false,
        errorMessage: combineErrorMessages(restart.errorMessage, caddyApply.errorMessage),
        file: body.file,
        restartMessage: restart.restartMessage,
        savedAt: new Date().toLocaleTimeString(),
      });
    } catch (error: unknown) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to reset Homepage config.',
      });
    } finally {
      setIsResetting(false);
    }
  }

  async function copyAdvancedDetails(): Promise<void> {
    await navigator.clipboard.writeText(buildAdvancedDetailsText(currentValidationErrors, currentPreview));
    setAdvancedDetailsCopied(true);
    window.setTimeout(() => setAdvancedDetailsCopied(false), 1600);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <main className="suite-app">
      <section className="mos-shell suite-hero">
        <span className="mos-eyebrow">Homepage</span>
        <h1 className="mos-page-title">Customize</h1>
      </section>

      <section className="mos-shell suite-homepage-config-shell">
        <div className="mos-panel suite-card suite-homepage-config-card">
          {state.kind === 'loading' ? <p className="suite-empty">Loading Homepage config...</p> : null}

          {state.kind === 'error' ? (
            <div className="suite-homepage-config-error">
              <p className="suite-error">{state.message}</p>
              <button className="suite-copy-button" onClick={() => void refresh()} type="button">
                <RefreshCcw aria-hidden="true" className="suite-inline-icon" />
                Reload
              </button>
            </div>
          ) : null}

          {state.kind === 'loaded' ? (
            <>
              <div className="suite-homepage-config-header">
                <div>
                  <h2 className="mos-card-title">{state.file.name}</h2>
                  <p className="suite-meta mos-meta">{state.file.description}</p>
                </div>
              </div>

              <div className="suite-homepage-config-layout">
                <nav className="suite-homepage-config-file-list" aria-label="Homepage config files">
                  {state.files.map((file) => (
                    <button
                      className={`suite-homepage-config-file ${file.name === selectedFile?.name ? 'is-active' : ''}`}
                      key={file.name}
                      onClick={() => void selectFile(file.name)}
                      type="button"
                    >
                      <span>{labelForFile(file.name)}</span>
                      <small>{file.language}</small>
                    </button>
                  ))}
                </nav>

                <div className="suite-homepage-config-editor">
                  {validationState.kind === 'valid' ? (
                    <div className="suite-homepage-validation-banner is-valid">
                      <CheckCircle2 aria-hidden="true" className="suite-validation-icon" />
                      <div className="suite-homepage-validation-copy">
                        <strong>Ready to save</strong>
                        <p>{validationSummary(validationState.result)}</p>
                        {state.restartCapabilities.homepageRestartAvailable ? (
                          <label className="suite-checkbox-row">
                            <input
                              checked={autoRestartHomepage}
                              disabled={isSaving || isResetting}
                              onChange={(event) => setAutoRestartHomepage(event.currentTarget.checked)}
                              type="checkbox"
                            />
                            <span>Restart Homepage after saving</span>
                          </label>
                        ) : (
                          <p className="suite-warning">Please restart Homepage after saving for changes to take effect.</p>
                        )}
                        {validationState.result.caddyPreview ? (
                          <button
                            className="suite-subtle-button suite-advanced-details-link"
                            onClick={() => setAdvancedDetailsOpen(true)}
                            type="button"
                          >
                            Advanced details
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {validationState.kind === 'invalid' ? (
                    <div className="suite-homepage-validation-banner is-invalid">
                      <AlertTriangle aria-hidden="true" className="suite-validation-icon" />
                      <div className="suite-homepage-validation-copy">
                        <strong>Fix these before saving</strong>
                        <ul className="suite-homepage-validation-errors">
                          {validationState.result.errors.map((error: HomepageCaddyProxyPreviewError) => (
                            <li key={`${error.path}:${error.message}`}>
                              <span>{error.path}</span>
                              <p>{humanizeValidationMessage(error)}</p>
                            </li>
                          ))}
                        </ul>
                        {validationState.result.caddyPreview ? (
                          <button
                            className="suite-subtle-button suite-advanced-details-link"
                            onClick={() => setAdvancedDetailsOpen(true)}
                            type="button"
                          >
                            Advanced details
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {validationState.kind === 'error' ? (
                    <div className="suite-homepage-validation-banner is-invalid">
                      <AlertTriangle aria-hidden="true" className="suite-validation-icon" />
                      <div className="suite-homepage-validation-copy">
                        <strong>Validation failed</strong>
                        <p>{validationState.message}</p>
                      </div>
                    </div>
                  ) : null}

                  {externalLinksMessage || state.restartMessage ? (
                    <div className="suite-homepage-validation-banner is-valid">
                      <CheckCircle2 aria-hidden="true" className="suite-validation-icon" />
                      <div className="suite-homepage-validation-copy">
                        <strong>Saved</strong>
                        {state.restartMessage ? <p>{state.restartMessage}</p> : null}
                        {externalLinksMessage ? <p>{externalLinksMessage}</p> : null}
                        {currentPreview ? (
                          <button
                            className="suite-subtle-button suite-advanced-details-link"
                            onClick={() => setAdvancedDetailsOpen(true)}
                            type="button"
                          >
                            Advanced details
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  <div className="suite-homepage-config-editorbar">
                    <span className="suite-field-label">{state.file.language}</span>
                    <div className="suite-homepage-config-savebar">
                      <button
                        className="suite-copy-button"
                        disabled={!canValidate}
                        onClick={() => void validateCurrentFile()}
                        type="button"
                      >
                        <SearchCheck aria-hidden="true" className="suite-inline-icon" />
                        {validationState.kind === 'loading' ? 'Checking...' : 'Validate'}
                      </button>
                      <button
                        className="suite-copy-button"
                        disabled={!canSave}
                        onClick={() => void save()}
                        type="button"
                      >
                        <Save aria-hidden="true" className="suite-inline-icon" />
                        {isSaving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                  <CodeEditor
                    ariaLabel="Homepage config editor"
                    language={state.file.language}
                    value={state.content}
                    onChange={(value: string) => {
                      setValidationState({ kind: 'dirty' });
                      setExternalLinksMessage(null);
                      setSavedPreview(null);
                      setState({
                        ...state,
                        content: value,
                        dirty: true,
                        errorMessage: null,
                        restartMessage: null,
                        savedAt: null,
                      });
                    }}
                  />
                </div>
              </div>

              <div className="suite-homepage-config-footer">
                {state.savedAt ? <span className="suite-meta mos-meta">Updated {state.savedAt}</span> : <span></span>}
                <div className="suite-homepage-config-actions">
                  <button
                    className="suite-copy-button"
                    disabled={isSaving || isResetting}
                    onClick={() => void refresh(state.file.name)}
                    type="button"
                  >
                    <RefreshCcw aria-hidden="true" className="suite-inline-icon" />
                    Reload
                  </button>
                  <button
                    className="suite-copy-button suite-danger-button"
                    disabled={isSaving || isResetting}
                    onClick={() => void reset()}
                    type="button"
                  >
                    <RotateCcw aria-hidden="true" className="suite-inline-icon" />
                    {isResetting ? 'Resetting...' : 'Reset to default'}
                  </button>
                </div>
              </div>
              {state.errorMessage ? <p className="suite-error">{state.errorMessage}</p> : null}
            </>
          ) : null}
        </div>
      </section>

      {advancedDetailsOpen ? (
        <div className="suite-modal-backdrop" role="presentation">
          <section aria-modal="true" className="suite-advanced-modal mos-panel" role="dialog">
            <div className="suite-advanced-modal-header">
              <div>
                <h2>Advanced details</h2>
                <p className="suite-meta mos-meta">For troubleshooting or support.</p>
              </div>
              <button
                aria-label="Close advanced details"
                className="suite-copy-button"
                onClick={() => setAdvancedDetailsOpen(false)}
                type="button"
              >
                <X aria-hidden="true" className="suite-inline-icon" />
              </button>
            </div>

            <button className="suite-copy-button suite-advanced-copy" onClick={() => void copyAdvancedDetails()} type="button">
              <Clipboard aria-hidden="true" className="suite-inline-icon" />
              {advancedDetailsCopied ? 'Copied' : 'Copy details'}
            </button>

            {currentValidationErrors.length > 0 ? (
              <div>
                <h3 className="mos-card-title">Validation errors</h3>
                <ul className="suite-homepage-caddy-preview-errors">
                  {currentValidationErrors.map((error: HomepageCaddyProxyPreviewError) => (
                    <li key={`${error.path}:${error.message}`}>
                      <strong>{error.path}</strong>
                      <span>{error.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {currentPreview ? (
              <>
                <div className="suite-advanced-facts">
                  <div>
                    <span className="suite-field-label">Generated routes</span>
                    <strong>{currentPreview.routes.length}</strong>
                  </div>
                  <div>
                    <span className="suite-field-label">Status</span>
                    <strong>{currentPreview.valid ? 'Valid' : 'Invalid'}</strong>
                  </div>
                </div>
                <div>
                  <h3 className="mos-card-title">Generated Caddy config</h3>
                  {currentPreview.caddyfile ? (
                    <pre className="suite-homepage-caddy-preview-code">
                      <code>{currentPreview.caddyfile}</code>
                    </pre>
                  ) : (
                    <p className="suite-meta mos-meta">No generated Caddy config.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="suite-meta mos-meta">No advanced routing details are available for this file.</p>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}
