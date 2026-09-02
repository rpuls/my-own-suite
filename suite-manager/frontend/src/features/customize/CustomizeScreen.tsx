import { useEffect, useMemo, useState } from 'react';
import { parseDocument } from 'yaml';
import { CustomizeYamlNotice } from '../../components/disclaimers';
import { AdvancedPanel, Notice } from '../../components/ui';
import { AddHomepageItemDialog } from './AddHomepageItemDialog';
import { CodeEditor } from './CodeEditor';

const API = '/suite-manager/api/customize';
const FILES = [
  { description: 'Dashboard bookmarks and quick links.', name: 'bookmarks.yaml' },
  { description: 'Dashboard groups, links, and home services.', name: 'services.template.yaml' },
  { description: 'Homepage title, theme, layout, and behavior.', name: 'settings.yaml' },
  { description: 'Header widgets such as search and system information.', name: 'widgets.yaml' },
];

type ApiError = Error & { code?: string; details?: string[] };

// A validation error's details are sentences for the owner: which line, which
// field. An apply failure's details are what caddy or systemd wrote, which
// belong behind the disclosure the rest of Suite Manager uses for such output.
const APPLY_FAILURE = /^HOMEPAGE_[A-Z_]*_FAILED$/u;
type FileResult = { content: string; file: string; revision: string };
type ApplyResult = { revision: string; steps?: string[] };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, method: 'POST' });
  const payload = await response.json().catch(() => ({ error: 'The operation failed.' }));
  if (!response.ok) throw Object.assign(new Error(payload.error || 'The operation failed.'), payload);
  return payload as T;
}

function createRequestId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function groupsFrom(content: string) {
  try {
    const value = parseDocument(content).toJS();
    if (!Array.isArray(value)) return ['Home services'];
    const groups: string[] = [];
    const walk = (items: unknown[]) => {
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const [name, children] of Object.entries(item)) {
          if (!Array.isArray(children)) continue;
          groups.push(name);
          walk(children);
        }
      }
    };
    walk(value);
    return groups.length ? [...new Set(groups)] : ['Home services'];
  } catch { return ['Home services']; }
}

export function CustomizeScreen() {
  const [file, setFile] = useState('services.template.yaml');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [revision, setRevision] = useState('');
  const [agentAvailable, setAgentAvailable] = useState(true);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const dirty = content !== savedContent;
  const selected = FILES.find((item) => item.name === file)!;
  const groups = useMemo(() => groupsFrom(file === 'services.template.yaml' ? content : savedContent), [content, file, savedContent]);

  async function load(selectedFile = file) {
    setBusy(true); setError(null); setSteps([]);
    try {
      const value = await api<FileResult>('/file/read', { file: selectedFile });
      setFile(selectedFile); setContent(value.content); setSavedContent(value.content); setRevision(value.revision);
    } catch (caught) { setError(caught as ApiError); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    void api<{ agentAvailable: boolean }>('/status').then((status) => setAgentAvailable(status.agentAvailable)).catch(() => setAgentAvailable(false));
    void load();
  }, []);

  // Validating is not a decision worth asking the owner to make: the agent
  // validates before it writes anything, so the errors that used to need a
  // separate Validate click now arrive from the one button that was ever going
  // to be pressed, and an invalid file never reaches the dashboard either way.
  async function save() {
    if (!dirty) return;
    setBusy(true); setError(null); setSteps([]);
    try {
      const value = await api<ApplyResult>('/file/apply', { content, expectedRevision: revision, file });
      setRevision(value.revision); setSavedContent(content); setSteps(value.steps || ['written']);
    } catch (caught) { setError(caught as ApiError); }
    finally { setBusy(false); }
  }

  async function add(kind: 'link' | 'service', entry: Record<string, unknown>) {
    let expectedRevision = revision;
    if (file !== 'services.template.yaml') expectedRevision = (await api<FileResult>('/file/read', { file: 'services.template.yaml' })).revision;
    const value = await api<ApplyResult>(kind === 'service' ? '/add-home-service' : '/add-link', { entry, expectedRevision, requestId: createRequestId() });
    setSteps(value.steps || ['written']); setAddOpen(false); await load('services.template.yaml'); setSteps(value.steps || ['written']);
  }

  return <section className="mos-shell suite-customize">
    <div className="suite-hero"><h1>Customize</h1><p className="suite-lead mos-body-lg">Edit dashboard files or add links and services already running on your home network.</p></div>
    {!agentAvailable ? <Notice title="Homepage agent unavailable" variant="warning"><p>Editing requires the installed MOS Homepage system agent.</p></Notice> : null}
    <section className="mos-panel suite-card suite-customize-panel">
      <header className="suite-customize-header"><div><h2>{selected.name}</h2><p className="suite-meta">{selected.description}</p></div>{file === 'services.template.yaml' ? <button className="mos-btn mos-btn-primary" disabled={busy || !agentAvailable} onClick={() => setAddOpen(true)} type="button">Add to Homepage</button> : null}</header>
      <div className="suite-customize-layout">
        <div className="suite-customize-sidebar">
          <nav className="suite-file-list" aria-label="Homepage config files">{FILES.map((item) => <button aria-current={item.name === file ? 'page' : undefined} disabled={busy} key={item.name} onClick={() => { if (!dirty || window.confirm('Discard unsaved changes?')) void load(item.name); }} type="button"><span>{item.name.replace('.template', '').replace('.yaml', '')}</span><small>YAML</small></button>)}</nav>
          {/* Out of the way of the save path. It explains the whole screen
              rather than the file in front of you, so it belongs beside the
              editor in the column's dead space, not stacked between the
              save button and what the button just said. */}
          <CustomizeYamlNotice />
        </div>
        <div className="suite-editor-column">
          {error ? <Notice title="Could not save" variant="error">
            <p>{error.message}</p>
            {!APPLY_FAILURE.test(error.code || '') ? error.details?.map((detail) => <p key={detail}>{detail}</p>) : null}
            {/* The only way this file changes underneath the editor is something
                else writing it — installing an app adds its Homepage tile — so
                the way out of a conflict is offered here, when it happens,
                rather than as a button that sits on the screen forever. */}
            {error.code === 'HOMEPAGE_REVISION_CONFLICT' ? <div className="suite-editor-actions">
              <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={() => void load()} type="button">Discard my changes and reload</button>
            </div> : null}
            {APPLY_FAILURE.test(error.code || '') && error.details?.length
              ? <AdvancedPanel facts={[{ label: 'Error code', value: error.code || '' }]} output={error.details.join('\n\n')} reveal="on-failure" />
              : null}
          </Notice> : null}
          {steps.length ? <><Notice title="Homepage updated" variant="success"><p>The saved dashboard configuration is active.</p></Notice><AdvancedPanel output={steps.join('\n')} reveal="technical-mode" /></> : null}
          <div className="suite-editor-actions"><button className="mos-btn mos-btn-primary" disabled={busy || !dirty || !agentAvailable} onClick={() => void save()} type="button">{busy ? 'Saving...' : 'Save and apply'}</button></div>
          {busy && !content ? <p className="suite-meta">Loading Homepage configuration...</p> : <CodeEditor key={file} value={content} onChange={(value) => { setContent(value); setError(null); setSteps([]); }} />}
        </div>
      </div>
    </section>
    {addOpen ? <AddHomepageItemDialog groups={groups} onAdd={add} onClose={() => setAddOpen(false)} previewHomeService={(input) => api('/home-service-preview', input)} /> : null}
  </section>;
}
