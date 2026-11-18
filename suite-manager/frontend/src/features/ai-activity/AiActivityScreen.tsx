import { useEffect, useState } from 'react';

import { Notice, Panel, PanelBody, PanelHead, PanelItem, PanelList, Select } from '../../components/ui';
import { whenWords } from '../../lib/dates';
import { aiActivity, aiRequest, OUTCOME_WORDS, type AiActivityEntry, type AiClient } from '../settings/ai/model';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function ActivityRow({ entry }: { entry: AiActivityEntry }) {
  const when = whenWords(entry.at);
  const who = entry.clientRemoved ? `${entry.clientName}, since removed` : entry.clientName;
  return <PanelItem quiet={entry.clientRemoved}>
    <div className="suite-source-row">
      <div className="suite-source-main">
        <strong>{entry.toolTitle || entry.tool} · {entry.sourceName}</strong>
        <span className="suite-meta">{who} · {when.charAt(0).toLowerCase() + when.slice(1)}</span>
      </div>
      <span className="suite-source-trailing">
        {entry.outcome === 'ok' ? <span className="suite-meta">{OUTCOME_WORDS.ok}</span> : <span className="mos-pill mos-pill-warning">{OUTCOME_WORDS[entry.outcome] ?? 'Failed'}</span>}
      </span>
    </div>
  </PanelItem>;
}

// A log, not a queue: which tool an assistant used and how it went, never what
// was read or written.
export function AiActivityScreen() {
  const [clients, setClients] = useState<AiClient[]>([]);
  const [clientId, setClientId] = useState('');
  const [entries, setEntries] = useState<AiActivityEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    aiRequest('GET', '', 'Unable to load AI assistants.').then((status) => setClients(status.clients), () => setClients([]));
  }, []);

  async function load(before: number | null) {
    setLoading(true);
    setError('');
    try {
      const page = await aiActivity({ before, clientId });
      setEntries((current) => (before ? [...(current ?? []), ...page.entries] : page.entries));
      setNextBefore(page.nextBefore);
    } catch (caught) {
      setError(errorText(caught, 'Unable to load AI activity.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(null); }, [clientId]);

  return <section className="mos-shell mos-page">
    <div className="suite-hero">
      <h1>AI activity</h1>
      <p className="suite-lead mos-body-lg">What your AI assistants did in your apps. MOS records which tool was used, never what was read or written.</p>
    </div>
    <Panel>
      <PanelHead actions={<Select aria-label="Show activity for" onChange={(event) => setClientId(event.target.value)} value={clientId}>
        <option value="">All assistants</option>
        {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
      </Select>} heading="h2" title="History">
        <p>Kept for 90 days.</p>
      </PanelHead>
      {error ? <PanelBody><Notice title="Something went wrong" variant="error"><p>{error}</p></Notice></PanelBody> : null}
      {entries?.length ? <PanelList>{entries.map((entry) => <ActivityRow entry={entry} key={entry.id} />)}</PanelList> : null}
      {entries && !entries.length ? <PanelBody><p className="suite-meta">Nothing yet.</p></PanelBody> : null}
      {nextBefore ? <PanelBody>
        <div><button className="mos-btn mos-btn-ghost" disabled={loading} onClick={() => void load(nextBefore)} type="button">{loading ? 'Loading...' : 'Show older'}</button></div>
      </PanelBody> : null}
    </Panel>
  </section>;
}
