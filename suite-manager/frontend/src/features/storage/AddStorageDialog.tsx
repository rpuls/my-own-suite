import { useState } from 'react';

import { ChoiceRow, Dialog, Notice, Panel, PanelItem, PanelList, Spinner, TextInput } from '../../components/ui';
import { postJson } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import { EMPTY_BUCKET_DRAFT, EMPTY_SHARE_DRAFT, type BucketDraft, type ConnectionTest, type ShareDraft } from './model';

type Step = 'choose' | 'drive' | 'online' | 'share';

// Reachable and holding another server's backups is a connection that worked;
// the recovery key is asked for later, under Backups.
function connected(result: ConnectionTest) {
  return Boolean(result && (result.ok || result.locked));
}

function TestOutcome({ test }: { test: ConnectionTest }) {
  if (!test) return null;
  if (!connected(test)) return <Notice title="That did not work" variant="error"><p>{test.message}</p></Notice>;
  const free = typeof test.availableBytes === 'number' ? ` ${formatBytes(test.availableBytes)} free.` : '';
  const holds = test.locked || test.holdsBackups;
  return <Notice title={holds ? 'It works, and it already holds backups' : 'It works'} variant={holds ? 'info' : 'success'}><p>{test.message}{free}</p></Notice>;
}

// Adding storage, from Settings → Storage or from any picker. A drive needs no
// form; storage online and a shared folder store how to reach them, nothing else.
export function AddStorageDialog({ editing = null, editingShare = null, onClose, onConnected }: {
  editing?: BucketDraft | null;
  editingShare?: ShareDraft | null;
  onClose: () => void;
  onConnected: (storageId: string) => void;
}) {
  const [step, setStep] = useState<Step>(editing ? 'online' : editingShare ? 'share' : 'choose');
  const [draft, setDraft] = useState<BucketDraft>(editing || { ...EMPTY_BUCKET_DRAFT });
  const [shareDraft, setShareDraft] = useState<ShareDraft>(editingShare || { ...EMPTY_SHARE_DRAFT });
  const [test, setTest] = useState<ConnectionTest>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const [error, setError] = useState('');
  const isEdit = Boolean(editing || editingShare);
  const field = (key: keyof BucketDraft) => (event: { currentTarget: { value: string } }) => { setDraft({ ...draft, [key]: event.currentTarget.value }); setTest(null); };
  const shareField = (key: keyof ShareDraft) => (event: { currentTarget: { value: string } }) => { setShareDraft({ ...shareDraft, [key]: event.currentTarget.value }); setTest(null); };
  const complete = step === 'share'
    ? Boolean(shareDraft.address.trim() && shareDraft.username.trim() && (shareDraft.password || editingShare))
    : Boolean(draft.endpoint.trim() && draft.bucket.trim() && draft.accessKeyId.trim() && (draft.secretAccessKey.trim() || editing));
  const api = step === 'share' ? '/suite-manager/api/storage/shares' : '/suite-manager/api/storage/buckets';
  const body = step === 'share' ? shareDraft : draft;

  async function tryIt() {
    setBusy('test');
    setError('');
    try {
      const answer = await postJson<{ result: ConnectionTest }>(`${api}/test`, body, 'MOS could not reach this storage.');
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

  // Tried first, so a wrong key is caught here and not by a backup at three in the morning.
  async function connect() {
    const result = connected(test) ? test : await tryIt();
    if (!connected(result)) return;
    setBusy('save');
    try {
      const saved = await postJson<{ destination?: { id: string }; id?: string }>(api, body, 'MOS could not save this connection.');
      onConnected(saved.destination?.id || saved.id || '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not save this connection.');
    } finally {
      setBusy('');
    }
  }

  const title = isEdit ? 'Edit connection' : step === 'online' ? 'Connect storage online' : step === 'share' ? 'Connect a shared folder' : 'Add storage';
  const footer = step === 'online' || step === 'share' ? <>
    {!isEdit ? <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => { setStep('choose'); setTest(null); setError(''); }} type="button">Back</button> : null}
    <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || !complete} onClick={() => void tryIt()} type="button">{busy === 'test' ? <><Spinner />Trying it</> : test ? 'Test again' : 'Test connection'}</button>
    <button className="mos-btn mos-btn-primary" disabled={Boolean(busy) || !complete} onClick={() => void connect()} type="button">{busy === 'save' ? <><Spinner />Connecting</> : isEdit ? 'Save' : 'Connect'}</button>
  </> : step === 'drive' ? <button className="mos-btn mos-btn-primary" onClick={onClose} type="button">Done</button> : null;

  return <Dialog footer={footer} onClose={() => { if (!busy) onClose(); }} title={title}>
    {step === 'choose' ? <>
      <p className="suite-meta">Added storage appears everywhere storage is picked — for apps and for backups.</p>
      <Panel density="tight">
        <PanelList>
          <PanelItem flush>
            <ChoiceRow icon="usb-drive" onPick={() => setStep('drive')}>
              <strong>Use a drive</strong>
              <span className="suite-meta">Plug a USB drive into this server — it appears here by itself, nothing to set up.</span>
            </ChoiceRow>
          </PanelItem>
          <PanelItem flush>
            <ChoiceRow icon="network-drive" onPick={() => setStep('share')}>
              <strong>A shared folder on your network <span className="mos-chip">SMB</span></strong>
              <span className="suite-meta">A folder shared from a NAS or another computer at home, such as TrueNAS, Synology or a Windows PC.</span>
            </ChoiceRow>
          </PanelItem>
          <PanelItem flush>
            <ChoiceRow icon="cloud-storage" onPick={() => setStep('online')}>
              <strong>Connect storage online <span className="mos-chip">S3-compatible</span></strong>
              <span className="suite-meta">Storage you rent from a provider such as Backblaze B2, Wasabi or Cloudflare R2. Survives a fire or a theft at home.</span>
            </ChoiceRow>
          </PanelItem>
        </PanelList>
      </Panel>
    </> : null}

    {step === 'drive' ? <>
      <p>Plug the drive into one of the server&apos;s USB ports. It appears in the list within a few seconds, with what it can hold.</p>
      <p className="suite-meta">Drives formatted as exFAT, NTFS or FAT32 can hold app files and backups and open on any computer. A drive formatted for Linux can hold backups.</p>
    </> : null}

    {step === 'share' ? <>
      <p className="suite-meta">Make a shared folder and a user for MOS on your NAS first. MOS signs in as that user and tries it before it connects.</p>
      <div className="suite-form-grid">
        <TextInput disabled={Boolean(busy)} helperText="The name you will see for it in MOS." label="Name" onChange={shareField('label')} placeholder="NAS backups" value={shareDraft.label} />
        <TextInput disabled={Boolean(busy)} helperText="As your NAS or Windows shows it, for example \\nas\backups or smb://192.168.1.20/backups." label="Shared folder address" onChange={shareField('address')} placeholder="\\nas\backups" value={shareDraft.address} />
        <TextInput disabled={Boolean(busy)} helperText="Optional. Lets the same shared folder hold more than one server's files." label="Folder inside it (optional)" onChange={shareField('folder')} placeholder="home-server" value={shareDraft.folder} />
        <TextInput autoComplete="off" disabled={Boolean(busy)} helperText="Use a user that can reach only this shared folder." label="Username" onChange={shareField('username')} placeholder="mos-backup" value={shareDraft.username} />
        <TextInput autoComplete="new-password" disabled={Boolean(busy)} helperText={editingShare ? 'Leave empty to keep the password already saved.' : 'Stored on this server only, readable by root.'} label="Password" onChange={shareField('password')} placeholder={editingShare ? 'Unchanged' : '••••••••'} type="password" value={shareDraft.password} />
      </div>
      <TestOutcome test={test} />
      {error ? <Notice title="Not connected" variant="error"><p>{error}</p></Notice> : null}
      <p className="suite-meta">This server can change and delete what it keeps in this folder. Snapshots on your NAS are what keep an older copy if that ever happens.</p>
    </> : null}

    {step === 'online' ? <>
      <p className="suite-meta">Any S3-compatible storage works. Your provider gives you these when you create the storage. Copy them across exactly; MOS tries them before it connects.</p>
      <div className="suite-form-grid">
        <TextInput disabled={Boolean(busy)} helperText="The name you will see for it in MOS." label="Name" onChange={field('label')} placeholder="Family backups" value={draft.label} />
        <TextInput disabled={Boolean(busy)} helperText="Your provider's S3 address, for example https://s3.eu-central-003.backblazeb2.com." label="Endpoint" onChange={field('endpoint')} placeholder="https://s3.example.com" value={draft.endpoint} />
        <TextInput disabled={Boolean(busy)} helperText="A bucket that already exists. MOS does not create one." label="Bucket" onChange={field('bucket')} placeholder="my-backups" value={draft.bucket} />
        <TextInput disabled={Boolean(busy)} helperText="Optional. Lets the same storage hold the backups of more than one server." label="Folder (optional)" onChange={field('folder')} placeholder="home-server" value={draft.folder} />
        <TextInput disabled={Boolean(busy)} helperText="Optional. Some providers need it; leave it empty if yours does not." label="Region (optional)" onChange={field('region')} placeholder="eu-central-1" value={draft.region} />
        <TextInput disabled={Boolean(busy)} helperText="Use a key that can only reach this storage." label="Access key ID" onChange={field('accessKeyId')} placeholder="AKIA…" value={draft.accessKeyId} />
        <TextInput disabled={Boolean(busy)} helperText={editing ? 'Leave empty to keep the key already saved.' : 'Stored on this server only, readable by root.'} label="Secret access key" onChange={field('secretAccessKey')} placeholder={editing ? 'Unchanged' : '••••••••'} type="password" value={draft.secretAccessKey} />
      </div>
      <TestOutcome test={test} />
      {error ? <Notice title="Not connected" variant="error"><p>{error}</p></Notice> : null}
    </> : null}
  </Dialog>;
}
