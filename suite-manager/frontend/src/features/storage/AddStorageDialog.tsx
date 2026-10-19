import { useState } from 'react';

import { Dialog, Icon, Notice, Spinner, TextInput } from '../../components/ui';
import { postJson } from '../../lib/api';
import { EMPTY_BUCKET_DRAFT, type BucketDraft, type ConnectionTest } from './model';

type Step = 'choose' | 'drive' | 'online';

// Reachable and empty, and reachable but holding another server's backups, are
// both connections that worked. Only the second needs a recovery key later, and
// that is a thing to do on the backup destination, not a reason to refuse it here.
function connected(result: ConnectionTest) {
  return Boolean(result && (result.ok || result.locked));
}

// Adding storage, from Settings → Storage or from any picker that offers it. A
// drive needs no form: MOS finds it when it is plugged in. Connecting a bucket
// stores how to reach it and nothing else; backups go there only once it is
// picked as a backup destination.
export function AddStorageDialog({ editing = null, initialStep = 'choose', onClose, onConnected }: {
  editing?: BucketDraft | null;
  initialStep?: Step;
  onClose: () => void;
  onConnected: (storageId: string) => void;
}) {
  const [step, setStep] = useState<Step>(editing ? 'online' : initialStep);
  const [draft, setDraft] = useState<BucketDraft>(editing || { ...EMPTY_BUCKET_DRAFT });
  const [test, setTest] = useState<ConnectionTest>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const [error, setError] = useState('');
  const field = (key: keyof BucketDraft) => (event: { currentTarget: { value: string } }) => { setDraft({ ...draft, [key]: event.currentTarget.value }); setTest(null); };
  const complete = Boolean(draft.endpoint.trim() && draft.bucket.trim() && draft.accessKeyId.trim() && (draft.secretAccessKey.trim() || editing));

  async function tryIt() {
    setBusy('test');
    setError('');
    try {
      const answer = await postJson<{ result: ConnectionTest }>('/suite-manager/api/storage/buckets/test', draft, 'MOS could not reach this storage.');
      setTest(answer.result);
      return answer.result;
    } catch (caught) {
      const failed = { message: caught instanceof Error ? caught.message : 'MOS could not reach this storage.', ok: false };
      setTest(failed);
      return failed;
    } finally {
      setBusy('');
    }
  }

  // Connecting tries the storage first, so a wrong key is caught here and not by
  // a backup at three in the morning.
  async function connect() {
    const result = connected(test) ? test : await tryIt();
    if (!connected(result)) return;
    setBusy('save');
    try {
      const saved = await postJson<{ destination: { id: string } }>('/suite-manager/api/storage/buckets', draft, 'MOS could not save this connection.');
      onConnected(saved.destination.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not save this connection.');
    } finally {
      setBusy('');
    }
  }

  const title = editing ? 'Edit connection' : step === 'online' ? 'Connect storage online' : 'Add storage';
  const footer = step === 'online' ? <>
    {!editing && initialStep === 'choose' ? <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => setStep('choose')} type="button">Back</button> : null}
    <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || !complete} onClick={() => void tryIt()} type="button">{busy === 'test' ? <><Spinner />Trying it</> : test ? 'Test again' : 'Test connection'}</button>
    <button className="mos-btn mos-btn-primary" disabled={Boolean(busy) || !complete} onClick={() => void connect()} type="button">{busy === 'save' ? <><Spinner />Connecting</> : editing ? 'Save' : 'Connect'}</button>
  </> : step === 'drive' ? <button className="mos-btn mos-btn-primary" onClick={onClose} type="button">Done</button> : null;

  return <Dialog footer={footer} onClose={() => { if (!busy) onClose(); }} title={title}>
    {step === 'choose' ? <>
      <p className="suite-meta">Added storage appears everywhere storage is picked — for apps and for backups.</p>
      <div className="suite-bk-kinds">
        <button className="suite-bk-kind-card" onClick={() => setStep('drive')} type="button">
          <span><Icon name="usb-drive" /><strong>Use a drive</strong></span>
          <span>Plug a USB drive into this server — it appears here by itself, nothing to set up.</span>
        </button>
        <button className="suite-bk-kind-card" onClick={() => setStep('online')} type="button">
          <span><Icon name="cloud-storage" /><strong>Connect storage online</strong><span className="suite-bk-chip">S3-compatible</span></span>
          <span>A bucket you rent from a provider such as Backblaze B2, Wasabi or Cloudflare R2. Survives a fire or a theft at home.</span>
        </button>
        <button className="suite-bk-kind-card" disabled type="button">
          <span><Icon name="network-drive" /><strong>A folder on another machine</strong><span className="suite-bk-chip">Later</span></span>
          <span>A shared folder on a NAS or another computer at home.</span>
        </button>
      </div>
    </> : null}

    {step === 'drive' ? <>
      <p>Plug the drive into one of the server&apos;s USB ports. It appears in the list within a few seconds, with what it can hold.</p>
      <p className="suite-meta">Drives formatted as exFAT, NTFS or FAT32 can hold app files and backups and open on any computer. A drive formatted for Linux can hold backups.</p>
    </> : null}

    {step === 'online' ? <>
      <p className="suite-meta">Any S3-compatible storage works. Your provider gives you these when you create the bucket. Copy them across exactly; MOS tries them before it connects.</p>
      <div className="suite-form-grid">
        <TextInput disabled={Boolean(busy)} helperText="The name you will see for it in MOS." label="Name" onChange={field('label')} placeholder="Family backups" value={draft.label} />
        <TextInput disabled={Boolean(busy)} helperText="Your provider's S3 address, for example https://s3.eu-central-003.backblazeb2.com." label="Endpoint" onChange={field('endpoint')} placeholder="https://s3.example.com" value={draft.endpoint} />
        <TextInput disabled={Boolean(busy)} helperText="A bucket that already exists. MOS does not create one." label="Bucket" onChange={field('bucket')} placeholder="my-backups" value={draft.bucket} />
        <TextInput disabled={Boolean(busy)} helperText="Optional. Lets one bucket hold the backups of more than one server." label="Folder (optional)" onChange={field('folder')} placeholder="home-server" value={draft.folder} />
        <TextInput disabled={Boolean(busy)} helperText="Optional. Some providers need it; leave it empty if yours does not." label="Region (optional)" onChange={field('region')} placeholder="eu-central-1" value={draft.region} />
        <TextInput disabled={Boolean(busy)} helperText="Use a key that can only reach this bucket." label="Access key ID" onChange={field('accessKeyId')} placeholder="AKIA…" value={draft.accessKeyId} />
        <TextInput disabled={Boolean(busy)} helperText={editing ? 'Leave empty to keep the key already saved.' : 'Stored on this server only, readable by root.'} label="Secret access key" onChange={field('secretAccessKey')} placeholder={editing ? 'Unchanged' : '••••••••'} type="password" value={draft.secretAccessKey} />
      </div>
      {test && connected(test) ? <Notice title={test.locked ? 'It works, and it already holds backups' : 'It works'} variant={test.locked ? 'info' : 'success'}><p>{test.message}</p></Notice> : null}
      {test && !connected(test) ? <Notice title="That did not work" variant="error"><p>{test.message}</p></Notice> : null}
      {error ? <Notice title="Not connected" variant="error"><p>{error}</p></Notice> : null}
    </> : null}
  </Dialog>;
}
