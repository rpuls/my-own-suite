import { useMemo, useState } from 'react';
import { Dialog, Notice, Select, Stepper, TextArea, TextInput } from '../../components/ui';

type AddKind = 'link' | 'service';
type Preview = { publicUrl: string; upstream: string };

function subdomainFromName(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 63);
}

function parseUpstream(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use only an HTTP or HTTPS address with a host and optional port.');
  return { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), protocol: url.protocol.slice(0, -1) };
}

export function AddHomepageItemDialog({ groups, onAdd, onClose, previewHomeService }: {
  groups: string[];
  onAdd: (kind: AddKind, entry: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  previewHomeService: (input: { host: string; port: number; protocol: string; subdomain: string }) => Promise<Preview>;
}) {
  const [kind, setKind] = useState<AddKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [customSubdomain, setCustomSubdomain] = useState(false);
  const [form, setForm] = useState({ description: '', group: groups[0] || 'Home services', icon: '', name: '', subdomain: '', upstream: '', url: '' });
  const subdomain = customSubdomain ? form.subdomain : subdomainFromName(form.name);
  const canSubmit = Boolean(kind && form.name && form.description && form.icon && form.group && (kind === 'link' ? form.url : form.upstream && subdomain));

  const parsedUpstream = useMemo(() => {
    try { return form.upstream ? parseUpstream(form.upstream) : null; } catch { return null; }
  }, [form.upstream]);

  async function updatePreview() {
    setError(''); setPreview(null);
    try {
      if (!parsedUpstream || !subdomain) throw new Error('Add an app name and a valid home-network address first.');
      setPreview(await previewHomeService({ ...parsedUpstream, subdomain }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to preview this address.'); }
  }

  async function save() {
    if (!kind || !canSubmit) return;
    setBusy(true); setError('');
    try {
      if (kind === 'link') await onAdd(kind, { description: form.description, group: form.group, icon: form.icon, name: form.name, url: form.url });
      else {
        if (!parsedUpstream) throw new Error('Enter a valid home-network app address.');
        await onAdd(kind, { description: form.description, group: form.group, icon: form.icon, name: form.name, subdomain, ...parsedUpstream });
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to add this item.'); }
    finally { setBusy(false); }
  }

  return <Dialog title="Add to Homepage" onClose={onClose} footer={<><button className="mos-btn mos-btn-secondary" disabled={busy} onClick={kind ? () => { setKind(null); setError(''); } : onClose} type="button">{kind ? 'Back' : 'Cancel'}</button>{kind ? <button className="mos-btn mos-btn-primary" disabled={busy || !canSubmit} onClick={() => void save()} type="button">{busy ? 'Adding...' : 'Add'}</button> : null}</>}>
    <Stepper currentStepIndex={kind ? 1 : 0} steps={['Type', 'Details']} />
    {!kind ? <section className="suite-decision-step" aria-labelledby="add-homepage-question"><h3 id="add-homepage-question">What do you want to add?</h3><div className="suite-choice-grid" role="group" aria-label="Item type">
      <button className="suite-choice-card" disabled type="button"><span><strong>MOS app</strong><small>Install a packaged app from the future MOS catalog.</small></span></button>
      <button className="suite-choice-card" onClick={() => { setKind('service'); setForm((current) => ({ ...current, group: groups.includes('Home services') ? 'Home services' : current.group })); }} type="button"><span><strong>Home network app</strong><small>Link an app already running on your LAN and give it a friendly MOS address.</small></span></button>
      <button className="suite-choice-card" onClick={() => setKind('link')} type="button"><span><strong>Website</strong><small>Add a normal dashboard link without proxying or managing it.</small></span></button>
    </div>
    </section> : null}
    {error ? <Notice title="Could not add this" variant="error"><p>{error}</p></Notice> : null}
    {kind === 'link' ? <div className="suite-form-grid">
      <TextInput autoFocus label="Name" placeholder="Firefox" value={form.name} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} />
      <TextInput label="Website address" placeholder="https://www.mozilla.org/" type="url" value={form.url} onChange={(event) => setForm({ ...form, url: event.currentTarget.value })} />
      <TextInput helperText="Use a Homepage icon name, such as firefox." label="Icon" placeholder="firefox" value={form.icon} onChange={(event) => setForm({ ...form, icon: event.currentTarget.value })} />
      <TextArea helperText="A short note shown under the name." label="Description" rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} />
      <Select label="Placement" value={form.group} onChange={(event) => setForm({ ...form, group: event.currentTarget.value })}>{groups.map((group) => <option key={group}>{group}</option>)}</Select>
    </div> : null}
    {kind === 'service' ? <><div className="suite-form-grid"><TextInput autoFocus helperText="Use the name you already use for this app." label="Name" placeholder="Home Assistant" value={form.name} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} /><TextInput helperText="The address you already use at home." label="App address" placeholder="http://192.168.1.20:8123" type="url" value={form.upstream} onChange={(event) => { setForm({ ...form, upstream: event.currentTarget.value }); setPreview(null); }} /></div>
      <div className={`suite-homepage-address-preview ${subdomain ? '' : 'is-empty'}`}><span className="suite-field-label">App URL</span>{customSubdomain ? <span className="suite-inline-url-editor"><input aria-label="URL subdomain" className="suite-inline-url-input" value={form.subdomain} onChange={(event) => { setForm({ ...form, subdomain: event.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/gu, '') }); setPreview(null); }} /><span>.your-home-domain</span></span> : <strong>{preview?.publicUrl || (subdomain ? `${subdomain}.your-home-domain` : 'Add a name to preview the URL')}</strong>}<button className="suite-subtle-button" onClick={() => { setCustomSubdomain((current) => !current); if (!customSubdomain) setForm({ ...form, subdomain }); }} type="button">{customSubdomain ? 'Use name' : 'Edit URL subdomain'}</button><button className="mos-btn mos-btn-secondary suite-form-wide" disabled={!parsedUpstream || !subdomain} onClick={() => void updatePreview()} type="button">Preview route</button>{preview ? <p className="suite-meta suite-form-wide">MOS will route <strong>{preview.publicUrl}</strong> to <code>{preview.upstream}</code>.</p> : null}</div>
      <div className="suite-form-grid"><TextInput helperText="Use a Homepage icon name, such as home-assistant." label="Icon" placeholder="home-assistant" value={form.icon} onChange={(event) => setForm({ ...form, icon: event.currentTarget.value })} /><TextArea helperText="A short note shown under the name." label="Description" rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} /><Select label="Placement" value={form.group} onChange={(event) => setForm({ ...form, group: event.currentTarget.value })}>{groups.map((group) => <option key={group}>{group}</option>)}</Select></div></> : null}
  </Dialog>;
}
