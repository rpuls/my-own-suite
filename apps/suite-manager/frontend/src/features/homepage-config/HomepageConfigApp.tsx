import { RefreshCcw, RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { withSetupPath } from '../../lib/base-path';
import CodeEditor from './CodeEditor';
import type {
  HomepageConfigFile,
  HomepageConfigFileResponse,
  HomepageConfigListResponse,
} from './types';

type EditorState =
  | { kind: 'loading' }
  | {
      content: string;
      dirty: boolean;
      file: HomepageConfigFile;
      files: HomepageConfigFile[];
      kind: 'loaded';
      savedAt: string | null;
    }
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

function labelForFile(name: string): string {
  return name.replace('.template', '').replace(/\.(yaml|css|js)$/u, '');
}

export default function HomepageConfigApp() {
  const [selectedFileName, setSelectedFileName] = useState('services.template.yaml');
  const [state, setState] = useState<EditorState>({ kind: 'loading' });
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const selectedFile = useMemo(() => {
    if (state.kind !== 'loaded') {
      return null;
    }
    return state.files.find((file) => file.name === selectedFileName) || state.file;
  }, [selectedFileName, state]);

  async function refresh(nextFileName = selectedFileName): Promise<void> {
    setState({ kind: 'loading' });
    try {
      const files = await loadFiles();
      const fileName = files.some((file) => file.name === nextFileName) ? nextFileName : files[0]?.name;
      if (!fileName) {
        throw new Error('No Homepage config files are available.');
      }
      const file = await loadFile(fileName);
      setSelectedFileName(fileName);
      setState({
        content: file.content,
        dirty: false,
        file: file.file,
        files,
        kind: 'loaded',
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
    await refresh(name);
  }

  async function save(): Promise<void> {
    if (state.kind !== 'loaded') {
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(withSetupPath(`/api/homepage-config/files/${encodeURIComponent(state.file.name)}`), {
        body: JSON.stringify({ content: state.content }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'PUT',
      });
      const body = await readJson<HomepageConfigFileResponse>(response, 'Unable to save Homepage config.');
      setState({
        ...state,
        content: body.content,
        dirty: false,
        file: body.file,
        savedAt: new Date().toLocaleTimeString(),
      });
    } catch (error: unknown) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to save Homepage config.',
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function reset(): Promise<void> {
    if (state.kind !== 'loaded') {
      return;
    }

    setIsResetting(true);
    try {
      const response = await fetch(
        withSetupPath(`/api/homepage-config/files/${encodeURIComponent(state.file.name)}/reset`),
        {
          method: 'POST',
        },
      );
      const body = await readJson<HomepageConfigFileResponse>(response, 'Unable to reset Homepage config.');
      setState({
        ...state,
        content: body.content,
        dirty: false,
        file: body.file,
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

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <main className="suite-app">
      <section className="mos-shell suite-hero">
        <span className="mos-eyebrow">Homepage</span>
        <h1 className="mos-page-title">Customize</h1>
      </section>

      <section className="mos-shell">
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
                    className="suite-copy-button"
                    disabled={isSaving || isResetting}
                    onClick={() => void reset()}
                    type="button"
                  >
                    <RotateCcw aria-hidden="true" className="suite-inline-icon" />
                    Reset
                  </button>
                  <button
                    className="suite-copy-button"
                    disabled={!state.dirty || isSaving || isResetting}
                    onClick={() => void save()}
                    type="button"
                  >
                    <Save aria-hidden="true" className="suite-inline-icon" />
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
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
                  <span className="suite-field-label">{state.file.language}</span>
                  <CodeEditor
                    ariaLabel="Homepage config editor"
                    language={state.file.language}
                    value={state.content}
                    onChange={(value) =>
                      setState({
                        ...state,
                        content: value,
                        dirty: true,
                        savedAt: null,
                      })
                    }
                  />
                </div>
              </div>

              <div className="suite-homepage-config-footer">
                <span className={`mos-pill ${state.dirty ? 'is-active' : 'is-completed'}`}>
                  {state.dirty ? 'Unsaved' : 'Saved'}
                </span>
                {state.savedAt ? <span className="suite-meta mos-meta">Updated {state.savedAt}</span> : null}
              </div>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
