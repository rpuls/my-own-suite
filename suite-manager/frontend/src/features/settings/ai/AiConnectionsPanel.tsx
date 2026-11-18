import { useEffect, useState } from 'react';

import { Notice, Panel, PanelBand, PanelBody, PanelHead, PanelList, Row, RowAction, RowTrailing, RowValue, Rows } from '../../../components/ui';
import { AddAssistantDialog } from './AddAssistantDialog';
import { ClientItem, NewTokenDialog, RemoveClientDialog, SourceTokenDialog, tokenLine, type ClientActions } from './AiParts';
import { aiRequest, levelOf, type AiClient, type AiException, type AiLevel, type AiSource, type AiStatus, type IssuedToken } from './model';

const REFRESH_MS = 15_000;

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function clientPath(client: AiClient, rest = '') {
  return `/clients/${encodeURIComponent(client.id)}${rest}`;
}

function McpAddress({ url }: { url: string | null }) {
  const [copied, setCopied] = useState(false);

  // Plain HTTP has no navigator.clipboard; the address stays selectable either way.
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch { /* selectable either way */ }
  }

  return <Row help="Assistants connect to this address, each with its own token." label="Address for AI assistants">
    {url ? <RowTrailing>
      <RowValue code>{url}</RowValue>
      <RowAction icon={copied ? 'check' : 'copy'} label={copied ? 'Address copied' : 'Copy address'} onClick={() => void copy()} />
    </RowTrailing> : <RowValue>Available once your suite has an HTTPS address</RowValue>}
  </Row>;
}

function SourceTokenRow({ busy, onRemove, onReplace, source }: { busy: boolean; onRemove: () => void; onReplace: () => void; source: AiSource }) {
  return <Row help={tokenLine(source)} label={`${source.name} access token`}>
    <RowTrailing>
      <RowAction disabled={busy} icon="key" label={`Replace the ${source.name} token`} onClick={onReplace} />
      <RowAction danger disabled={busy} icon="x" label={`Remove the ${source.name} token`} onClick={onRemove} />
    </RowTrailing>
  </Row>;
}

// Lets an AI assistant use the apps the owner chooses: one level per app per
// assistant, with single tools adjusted under Customize.
export function AiConnectionsPanel() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [openClient, setOpenClient] = useState('');
  const [changedClient, setChangedClient] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [addIssued, setAddIssued] = useState<{ clientId: string; token: string } | null>(null);
  const [rotated, setRotated] = useState<{ client: AiClient; token: string } | null>(null);
  const [removing, setRemoving] = useState<AiClient | null>(null);
  const [tokenSource, setTokenSource] = useState<AiSource | null>(null);
  const [tokenError, setTokenError] = useState('');

  async function load() {
    try {
      setStatus(await aiRequest('GET', '', 'Unable to load AI assistants.'));
    } catch (caught) {
      setError(errorText(caught, 'Unable to load AI assistants.'));
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  async function run(key: string, fallback: string, action: () => Promise<AiStatus>) {
    setBusy(key);
    setError('');
    try {
      setStatus(await action());
      return true;
    } catch (caught) {
      setError(errorText(caught, fallback));
      return false;
    } finally {
      setBusy('');
    }
  }

  async function addClient(name: string) {
    setBusy('add');
    setAddError('');
    try {
      const created = await aiRequest<IssuedToken>('POST', '/clients', 'The connection could not be added.', { name });
      setStatus(created.status);
      if (created.client) setAddIssued({ clientId: created.client.id, token: created.token });
    } catch (caught) {
      setAddError(errorText(caught, 'The connection could not be added.'));
    } finally {
      setBusy('');
    }
  }

  function closeAdd() {
    if (addIssued) setOpenClient(addIssued.clientId);
    setAdding(false);
    setAddIssued(null);
  }

  async function saveSourceToken(source: AiSource, token: string) {
    setBusy(`source:${source.id}`);
    setTokenError('');
    try {
      setStatus(await aiRequest('PUT', `/sources/${encodeURIComponent(source.id)}/token`, 'The token could not be saved.', { token }));
      setTokenSource(null);
    } catch (caught) {
      setTokenError(errorText(caught, 'The token could not be saved.'));
    } finally {
      setBusy('');
    }
  }

  function removeSourceToken(source: AiSource) {
    void run(`source:${source.id}`, 'The token could not be removed.', () => aiRequest('DELETE', `/sources/${encodeURIComponent(source.id)}/token`, 'The token could not be removed.'));
  }

  function actionsFor(client: AiClient, sources: AiSource[]): ClientActions {
    const key = `client:${client.id}`;
    const change = async (fallback: string, action: () => Promise<AiStatus>) => {
      if (await run(key, fallback, action)) setChangedClient(client.id);
    };
    return {
      onAccept: (tool) => void change('The tool could not be accepted.', () => aiRequest('POST', `/tools/${encodeURIComponent(tool)}/accept`, 'The tool could not be accepted.')),
      // Apps that follow the default keep what they had: only apps added later take the new default.
      onDefaultLevel: (level) => void run(key, 'The setting could not be changed.', async () => {
        for (const source of sources.filter((candidate) => !client.levels[candidate.id])) {
          await aiRequest('PUT', clientPath(client, `/levels/${encodeURIComponent(source.id)}`), 'The setting could not be changed.', { level: levelOf(client, source.id) });
        }
        return aiRequest('PUT', clientPath(client), 'The setting could not be changed.', { defaultLevel: level });
      }),
      onException: (tool: string, exception: AiException | null) => void change('The tool could not be changed.', () => aiRequest('PUT', clientPath(client, `/exceptions/${encodeURIComponent(tool)}`), 'The tool could not be changed.', { exception })),
      onLevel: (sourceId: string, level: AiLevel) => void change('The setting could not be changed.', () => aiRequest('PUT', clientPath(client, `/levels/${encodeURIComponent(sourceId)}`), 'The setting could not be changed.', { level })),
      onRemove: () => setRemoving(client),
      onReset: (sourceId) => void change('The tools could not be reset.', () => aiRequest('DELETE', clientPath(client, `/levels/${encodeURIComponent(sourceId)}/exceptions`), 'The tools could not be reset.')),
      onRotate: () => void run(key, 'A new token could not be made.', async () => {
        const issued = await aiRequest<IssuedToken>('POST', clientPath(client, '/token'), 'A new token could not be made.');
        setRotated({ client, token: issued.token });
        return issued.status;
      }),
      onToggleEnabled: () => void run(key, 'The assistant could not be changed.', () => aiRequest('PUT', clientPath(client), 'The assistant could not be changed.', { enabled: !client.enabled })),
    };
  }

  async function removeClient(client: AiClient) {
    if (await run(`client:${client.id}`, 'The assistant could not be removed.', () => aiRequest('DELETE', clientPath(client), 'The assistant could not be removed.'))) setRemoving(null);
  }

  const sources = status?.sources ?? [];
  const clients = status?.clients ?? [];
  const missingTokens = sources.filter((source) => source.token && !source.token.configured);
  const savedTokens = sources.filter((source) => source.token?.configured);

  return <Panel>
    <PanelHead actions={status ? <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => { setAddError(''); setAdding(true); }} type="button">Add</button> : null} heading="h3" title="AI assistants">
      <p>Let an AI assistant use the apps you choose.</p>
    </PanelHead>
    {error ? <PanelBody><Notice title="Something went wrong" variant="error"><p>{error}</p></Notice></PanelBody> : null}
    {missingTokens.map((source) => <PanelBand icon="key" key={source.id} layout="row" note="MOS needs an access token from it first." title={`${source.name} can be used by an AI.`}>
      <button className="mos-btn mos-btn-ghost" disabled={Boolean(busy)} onClick={() => { setTokenError(''); setTokenSource(source); }} type="button">Add token</button>
    </PanelBand>)}
    {clients.length ? <PanelList>
      {clients.map((client) => <ClientItem
        actions={actionsFor(client, sources)}
        busy={busy === `client:${client.id}`}
        changed={changedClient === client.id}
        client={client}
        expanded={openClient === client.id}
        key={client.id}
        onToggle={() => setOpenClient(openClient === client.id ? '' : client.id)}
        sources={sources}
      />)}
    </PanelList> : status ? <PanelBody><p className="suite-meta">No assistant is connected yet.</p></PanelBody> : null}
    {status ? <PanelBody>
      <Rows lead>
        <McpAddress url={status.mcpUrl} />
        {savedTokens.map((source) => <SourceTokenRow busy={Boolean(busy)} key={source.id} onRemove={() => removeSourceToken(source)} onReplace={() => { setTokenError(''); setTokenSource(source); }} source={source} />)}
      </Rows>
    </PanelBody> : null}
    {adding && status ? <AddAssistantDialog busy={busy === 'add'} error={addError} issued={addIssued?.token ?? null} mcpUrl={status.mcpUrl} onClose={closeAdd} onCreate={(name) => void addClient(name)} onDone={closeAdd} /> : null}
    {rotated ? <NewTokenDialog client={rotated.client} mcpUrl={status?.mcpUrl ?? null} onClose={() => setRotated(null)} token={rotated.token} /> : null}
    {removing ? <RemoveClientDialog busy={busy === `client:${removing.id}`} client={removing} onClose={() => setRemoving(null)} onRemove={() => void removeClient(removing)} /> : null}
    {tokenSource ? <SourceTokenDialog busy={busy === `source:${tokenSource.id}`} error={tokenError} onClose={() => setTokenSource(null)} onSave={(token) => void saveSourceToken(tokenSource, token)} source={tokenSource} /> : null}
  </Panel>;
}
