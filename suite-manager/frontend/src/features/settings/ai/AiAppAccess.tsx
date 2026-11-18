import { useEffect, useState } from 'react';

import { Row, RowAction, RowTrailing, Rows } from '../../../components/ui';
import { SourceTokenDialog, tokenLine } from './AiParts';
import { aiRequest, LEVEL_WORDS, levelOf, type AiStatus } from './model';

const AI_SETTINGS_PATH = '/suite-manager/settings#set-ai';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

// On an app's own page: which AI may use it, and the token the app let MOS in
// with. What each AI may do is still chosen under Settings.
export function AiAppAccess({ packageId }: { packageId: string }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    aiRequest('GET', '', 'Unable to load AI access.').then(setStatus, () => setStatus(null));
  }, [packageId]);

  const source = status?.sources.find((candidate) => candidate.id === packageId);
  if (!status || !source) return null;
  const allowed = status.clients.filter((client) => client.enabled && levelOf(client, source.id) !== 'off');

  async function saveToken(token: string) {
    setBusy(true);
    setError('');
    try {
      setStatus(await aiRequest('PUT', `/sources/${encodeURIComponent(source!.id)}/token`, 'The token could not be saved.', { token }));
      setReplacing(false);
    } catch (caught) {
      setError(errorText(caught, 'The token could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function removeToken() {
    setBusy(true);
    try {
      setStatus(await aiRequest('DELETE', `/sources/${encodeURIComponent(source!.id)}/token`, 'The token could not be removed.'));
    } finally {
      setBusy(false);
    }
  }

  return <section className="suite-app-detail-section">
    <h3>AI access</h3>
    <Rows lead>
      <Row help={<a className="mos-link" href={AI_SETTINGS_PATH}>Change in Settings</a>} label={allowed.length ? 'Your AI that may use it' : `No AI may use ${source.name} yet`}>
        {allowed.length ? <span className="suite-meta">{allowed.map((client) => `${client.name} · ${LEVEL_WORDS[levelOf(client, source.id)]}`).join(', ')}</span> : null}
      </Row>
      {source.token?.configured ? <Row help={tokenLine(source)} label={`${source.name} access token`}>
        <RowTrailing>
          <RowAction disabled={busy} icon="key" label={`Replace the ${source.name} token`} onClick={() => { setError(''); setReplacing(true); }} />
          <RowAction danger disabled={busy} icon="x" label={`Remove the ${source.name} token`} onClick={() => void removeToken()} />
        </RowTrailing>
      </Row> : null}
    </Rows>
    {replacing ? <SourceTokenDialog busy={busy} error={error} onClose={() => setReplacing(false)} onSave={(token) => void saveToken(token)} source={source} /> : null}
  </section>;
}
