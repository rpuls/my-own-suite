import { useEffect, useState } from 'react';

import { Dialog, Notice, Row, RowAction, RowTrailing, Rows } from '../../../components/ui';
import { SourceTokenDialog, tokenLine } from './AiParts';
import { aiRequest, LEVEL_WORDS, levelOf, type AiClient, type AiSource, type AiStatus } from './model';

const AI_SETTINGS_PATH = '/suite-manager/settings#set-ai';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function RemoveTokenDialog({ allowed, busy, onClose, onRemove, source }: { allowed: AiClient[]; busy: boolean; onClose: () => void; onRemove: () => void; source: AiSource }) {
  const who = allowed.map((client) => client.name).join(', ');
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-danger" disabled={busy} onClick={onRemove} type="button">{busy ? 'Removing...' : 'Remove'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Remove the ${source.name} token?`}
  >
    <p>{allowed.length ? `${who} can no longer use ${source.name} until you add a new token.` : `No AI can use ${source.name} until you add a new token.`} To stop it working in {source.name} too, delete the token there as well.</p>
  </Dialog>;
}

// On an app's own page: which AI may use it, and the token the app let MOS in
// with. What each AI may do is still chosen under Settings.
export function AiAppAccess({ packageId }: { packageId: string }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    aiRequest('GET', '', 'Unable to load AI access.').then(setStatus, () => setStatus(null));
  }, [packageId]);

  const source = status?.sources.find((candidate) => candidate.id === packageId);
  if (!status || !source) return null;
  const allowed = status.clients.filter((client) => client.enabled && levelOf(client, source.id) !== 'off');

  async function change(action: () => Promise<AiStatus>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      setStatus(await action());
      setReplacing(false);
      setRemoving(false);
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(false);
    }
  }

  const tokenPath = `/sources/${encodeURIComponent(source.id)}/token`;
  return <section className="suite-app-detail-section">
    <h3>AI access</h3>
    <Rows lead>
      <Row help={<a className="mos-link" href={AI_SETTINGS_PATH}>Change in Settings</a>} label={`Who may use ${source.name}`}>
        <span className="suite-meta">{allowed.length ? allowed.map((client) => `${client.name} · ${LEVEL_WORDS[levelOf(client, source.id)]}`).join(', ') : 'No AI yet'}</span>
      </Row>
      {source.token?.configured ? <Row help={tokenLine(source)} label={`${source.name} access token`}>
        <RowTrailing>
          <RowAction disabled={busy} icon="key" label={`Replace the ${source.name} token`} onClick={() => { setError(''); setReplacing(true); }} />
          <RowAction danger disabled={busy} icon="x" label={`Remove the ${source.name} token`} onClick={() => { setError(''); setRemoving(true); }} />
        </RowTrailing>
      </Row> : null}
    </Rows>
    {error && !replacing ? <Notice title="Something went wrong" variant="error"><p>{error}</p></Notice> : null}
    {replacing ? <SourceTokenDialog busy={busy} error={error} onClose={() => setReplacing(false)} onSave={(token) => void change(() => aiRequest('PUT', tokenPath, 'The token could not be saved.', { token }), 'The token could not be saved.')} source={source} /> : null}
    {removing ? <RemoveTokenDialog allowed={allowed} busy={busy} onClose={() => setRemoving(false)} onRemove={() => void change(() => aiRequest('DELETE', tokenPath, 'The token could not be removed.'), 'The token could not be removed.')} source={source} /> : null}
  </section>;
}
