import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Notice, Select, TextArea, TextInput } from '../../components/ui';

const API = '/suite-manager/api/customize';
const files = ['bookmarks.yaml', 'services.template.yaml', 'settings.yaml', 'widgets.yaml'];
type Mode = 'editor' | 'link' | 'service';
type Result = { revision?: string; steps?: string[]; error?: string; details?: string[] };

async function api(path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, body === undefined ? {} : {
    body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, method: 'POST',
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || 'The operation failed.'), payload);
  return payload;
}

const emptyLink = { description: '', group: 'Open Source Resources', icon: 'mdi:link', name: '', url: '' };
const emptyService = { description: '', group: 'Home services', host: '', icon: 'mdi:server-network', name: '', port: '', protocol: 'http', subdomain: '' };

export function CustomizeScreen() {
  const [mode, setMode] = useState<Mode>('editor');
  const [file, setFile] = useState('services.template.yaml');
  const [content, setContent] = useState('');
  const [revision, setRevision] = useState('');
  const [agentAvailable, setAgentAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({});
  const [link, setLink] = useState(emptyLink);
  const [service, setService] = useState(emptyService);
  const [linkRequestId, setLinkRequestId] = useState(() => crypto.randomUUID());
  const [serviceRequestId, setServiceRequestId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<{ publicUrl: string; upstream: string } | null>(null);

  async function load(selected = file) {
    setBusy(true); setResult({});
    try {
      const value = await api('/file/read', { file: selected });
      setContent(value.content); setRevision(value.revision);
    } catch (error) { setResult({ error: (error as Error).message }); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    void api('/status').then((status) => setAgentAvailable(status.agentAvailable)).catch(() => setAgentAvailable(false));
    void load();
  }, []);

  async function save() {
    setBusy(true); setResult({});
    try {
      await api('/file/validate', { content, file });
      const value = await api('/file/apply', { content, expectedRevision: revision, file });
      setRevision(value.revision); setResult({ steps: value.steps });
    } catch (error) {
      const value = error as Error & { details?: string[] };
      setResult({ details: value.details, error: value.message });
    } finally { setBusy(false); }
  }

  async function ensureServicesRevision() {
    if (file === 'services.template.yaml') return revision;
    const value = await api('/file/read', { file: 'services.template.yaml' });
    return value.revision as string;
  }

  async function addGuided(event: FormEvent, homeService: boolean) {
    event.preventDefault(); setBusy(true); setResult({});
    try {
      const expectedRevision = await ensureServicesRevision();
      const value = await api(homeService ? '/add-home-service' : '/add-link', {
        entry: homeService ? { ...service, port: Number(service.port) } : link,
        expectedRevision,
        requestId: homeService ? serviceRequestId : linkRequestId,
      });
      if (file === 'services.template.yaml') await load('services.template.yaml');
      setResult({ steps: value.steps });
      if (homeService) { setService(emptyService); setServiceRequestId(crypto.randomUUID()); }
      else { setLink(emptyLink); setLinkRequestId(crypto.randomUUID()); }
      setPreview(null);
    } catch (error) { setResult({ error: (error as Error).message }); }
    finally { setBusy(false); }
  }

  async function updatePreview() {
    try {
      setPreview(await api('/home-service-preview', { host: service.host, port: Number(service.port), protocol: service.protocol, subdomain: service.subdomain }));
      setResult({});
    } catch (error) { setPreview(null); setResult({ error: (error as Error).message }); }
  }

  return <section className="mos-shell suite-customize">
    <div className="suite-hero"><span className="mos-pill mos-pill-accent">Dashboard configuration</span><h1>Customize</h1><p className="suite-lead mos-body-lg">Edit Homepage files or add dashboard-only links and existing services on your network.</p></div>
    {!agentAvailable ? <Notice title="Homepage agent unavailable" variant="warning"><p>Editing requires the installed V2 Homepage system agent.</p></Notice> : null}
    <div className="suite-mode-tabs" role="tablist" aria-label="Customize mode">
      <button aria-selected={mode === 'editor'} onClick={() => setMode('editor')} role="tab" type="button">Files</button>
      <button aria-selected={mode === 'link'} onClick={() => setMode('link')} role="tab" type="button">Add link</button>
      <button aria-selected={mode === 'service'} onClick={() => setMode('service')} role="tab" type="button">Add home service</button>
    </div>
    <section className="mos-panel suite-card suite-customize-panel">
      {mode === 'editor' ? <>
        <Select label="Homepage file" value={file} onChange={(event) => { setFile(event.target.value); void load(event.target.value); }}>{files.map((name) => <option key={name}>{name}</option>)}</Select>
        <TextArea aria-label="Homepage YAML" className="suite-code-editor" label="YAML content" rows={20} spellCheck={false} value={content} onChange={(event) => setContent(event.target.value)} />
        <button className="mos-button mos-button-primary" disabled={busy || !agentAvailable} onClick={() => void save()} type="button">{busy ? 'Applying...' : 'Validate and apply'}</button>
      </> : mode === 'link' ? <GuidedForm values={link} setValues={setLink} onSubmit={(event: FormEvent) => void addGuided(event, false)} busy={busy} /> : <GuidedForm values={service} setValues={setService} onSubmit={(event: FormEvent) => void addGuided(event, true)} busy={busy} service onPreview={() => void updatePreview()} preview={preview} />}
      {result.error ? <Notice title="Could not apply" variant="error"><p>{result.error}</p>{result.details?.map((detail) => <p key={detail}>{detail}</p>)}</Notice> : result.steps ? <Notice title="Homepage updated" variant="success"><p>The new dashboard configuration is active.</p></Notice> : null}
      {result.steps ? <details className="suite-advanced"><summary>Advanced details</summary><pre>{result.steps.join('\n')}</pre></details> : null}
    </section>
  </section>;
}

function GuidedForm({ busy, onPreview, onSubmit, preview, service = false, setValues, values }: any) {
  const field = (name: string) => ({ value: values[name], onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues({ ...values, [name]: event.target.value }) });
  return <form className="suite-guided-form" onSubmit={onSubmit}>
    <div className="suite-form-grid"><TextInput label="Display name" required {...field('name')} /><TextInput label="Description" required {...field('description')} /><TextInput label="Icon" required {...field('icon')} /><TextInput label="Destination group" required {...field('group')} />
    {service ? <><Select label="Upstream protocol" {...field('protocol')}><option value="http">HTTP</option><option value="https">HTTPS</option></Select><TextInput label="Internal host or IP" required {...field('host')} /><TextInput label="Internal port" min="1" max="65535" required type="number" {...field('port')} /><TextInput label="Public subdomain" required {...field('subdomain')} /></> : <TextInput label="URL" required type="url" {...field('url')} />}</div>
    {service ? <><button className="mos-button" onClick={onPreview} type="button">Preview route</button>{preview ? <div className="suite-route-preview"><strong>Browser URL</strong><code>{preview.publicUrl}</code><strong>Internal upstream</strong><code>{preview.upstream}</code></div> : null}</> : <p className="suite-meta">This adds a dashboard link only. MOS will not proxy or manage the linked service.</p>}
    <button className="mos-button mos-button-primary" disabled={busy} type="submit">{busy ? 'Applying...' : service ? 'Add home service' : 'Add link'}</button>
  </form>;
}
