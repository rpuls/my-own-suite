import { useState, type FormEvent, type ReactNode } from 'react';

import { ActionMenu, AdvancedPanel, Avatar, DestinationLine, Dialog, DisclosureRow, Icon, Notice, PanelItem, Row, RowSwitch, RowTrailing, Rows, Segmented, TextInput, type AdvancedFact } from '../../../components/ui';
import { whenWords } from '../../../lib/dates';
import { navigateOnClick } from '../../../lib/navigation';
import { avatarOf, sourceIconUrl } from '../../ai-activity/timeline';
import { AddressField, AssistantDestination, ChatGptSteps, ConnectDetails, TunnelStatus } from './AddAssistantDialog';
import { appHelp, clientMeta, contactWhen, holdsOldAddress, levelLabel, needsToken, oldAddressHelp, reloadHint, tokenHelp, tunnelBroken } from './assistant-words';
import {
  customizedTools, isOffered, KIND_GROUPS, LEVEL_OPTIONS, levelOf, toolAllowed,
  type AiClient, type AiException, type AiLevel, type AiSource, type AiTool, type AiTunnel, type OfferedKind,
} from './model';

const DASHBOARD_HISTORY_PATH = '/suite-manager/customize#history';
const AI_ACTIVITY_PATH = '/suite-manager/ai-activity';

export type ClientActions = {
  onAccept: (sourceId: string, tool: string) => void;
  onDefaultLevel: (level: AiLevel) => void;
  onException: (sourceId: string, tool: string, exception: AiException | null) => void;
  onLevel: (sourceId: string, level: AiLevel) => void;
  onSourceToken: (sourceId: string, token: string) => Promise<string>;
  onRemove: () => void;
  onReset: (sourceId: string) => void;
  onRotate: () => void;
  onStartTunnel: () => void;
  onToggleEnabled: () => void;
};

// Where a failed change is reported: under the app's control, in its Customize dialog, or under the row's own buttons.
export type FailureSpot = `level:${string}` | 'row' | `tools:${string}`;

function needsReview(tool: AiTool) {
  return isOffered(tool) && tool.review !== 'pinned';
}

function FailedChange({ message }: { message: string | undefined }) {
  return message ? <Notice title="Could not change this" variant="error"><p>{message}</p></Notice> : null;
}

// The first time an app is opened to any assistant, it gives MOS an access token once.
// Asked here, at the moment it matters, rather than as a field of its own.
function TokenStep({ onCancel, onSave, source }: { onCancel: () => void; onSave: (token: string) => Promise<string>; source: AiSource }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setSaving(true);
    setError(await onSave(draft.trim()));
    setSaving(false);
  }

  const tokenPage = source.token?.tokenPageUrl;
  return <form className="suite-ai-token-step" onSubmit={(event) => void submit(event)}>
    <Notice title={`Connect ${source.name} once`} variant="info">
      <p>{source.name} has its own sign-in, so MOS needs a {source.name} access token to reach it for your assistants. {source.token?.hint || `Create an access token in ${source.name}.`}</p>
      {tokenPage ? <p><a className="mos-link" href={tokenPage} rel="noreferrer" target="_blank">Create the token in {source.name}<Icon name="external" /></a></p> : null}
      <p>The token stays on your suite. No assistant ever sees it.</p>
    </Notice>
    <TextInput autoComplete="new-password" autoFocus label={`${source.name} access token`} onChange={(event) => setDraft(event.target.value)} type="password" value={draft} />
    {error ? <Notice title={`${source.name} did not accept that token`} variant="error"><p>{error}</p></Notice> : null}
    <div className="suite-ai-token-actions">
      <button className="mos-btn mos-btn-ghost" disabled={saving} onClick={onCancel} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" disabled={saving || !draft.trim()} type="submit">{saving ? 'Checking…' : 'Save'}</button>
    </div>
  </form>;
}

type SetupChoice = 'off' | 'setup';
const SETUP_OPTIONS: Array<{ label: string; value: SetupChoice }> = [{ label: 'Off', value: 'off' }, { label: 'Set up', value: 'setup' }];

export function AppName({ id, name }: { id: string; name: string }) {
  return <span className="suite-ai-source-name"><img alt="" height="28" src={sourceIconUrl(id)} width="28" />{name}</span>;
}

// Suite Manager's level covers every app, so its help says so.
const BUILTIN_HELP: Record<AiLevel, ReactNode> = {
  off: 'Cannot check how your apps are doing, read their logs, or see your dashboard or AI activity.',
  see: 'Can check how every app is doing, read every app\'s recent logs to look into a problem, look at your dashboard, and see what your AI assistants did. Logs can name your files and the people who use your apps, also in apps set to Off here. Passwords and keys MOS knows are masked.',
  act: <>Can also restart any app and rearrange your dashboard, including removing links. MOS keeps the last 20 dashboard versions under <a className="mos-link" href={DASHBOARD_HISTORY_PATH}>History</a>, so recent changes can be undone.</>,
};

function SourceLabel({ client, source }: { client: AiClient; source: AiSource }) {
  return <>
    <AppName id={source.id} name={source.name} />
    {customizedTools(client, source).length ? <> <span className="mos-pill">Custom</span></> : null}
  </>;
}

// Until the app has given MOS a token, the switch offers only Set up, so it never shows
// a level that cannot take effect; the levels appear once the token is accepted.
function TokenLevel({ client, disabled, onSourceToken, source }: { client: AiClient; disabled: boolean; onSourceToken: (token: string) => Promise<string>; source: AiSource }) {
  const [settingUp, setSettingUp] = useState(false);
  return <>
    <Row help={tokenHelp(source, levelOf(client, source.id))} label={<SourceLabel client={client} source={source} />}>
      <Segmented<SetupChoice> disabled={disabled} label={`${source.name} for ${client.name}`} onChange={(choice) => setSettingUp(choice === 'setup')} options={SETUP_OPTIONS} value={settingUp ? 'setup' : 'off'} />
    </Row>
    {settingUp ? <TokenStep onCancel={() => setSettingUp(false)} onSave={onSourceToken} source={source} /> : null}
  </>;
}

function SourceLevel({ client, disabled, failure, onCustomize, onLevel, onSourceToken, source }: {
  client: AiClient;
  disabled: boolean;
  failure: string | undefined;
  onCustomize: () => void;
  onLevel: (level: AiLevel) => void;
  onSourceToken: (token: string) => Promise<string>;
  source: AiSource;
}) {
  if (needsToken(source)) return <><TokenLevel client={client} disabled={disabled} onSourceToken={onSourceToken} source={source} /><FailedChange message={failure} /></>;

  const level = levelOf(client, source.id);
  const help = source.builtin ? BUILTIN_HELP[level] : appHelp(client, source);
  const customize = source.tools.some(isOffered)
    ? <button aria-label={`Customize ${source.name} for ${client.name}`} className="mos-link suite-link-button" onClick={onCustomize} type="button">Customize</button>
    : undefined;
  return <>
    <Row aside={customize} help={help} label={<SourceLabel client={client} source={source} />}>
      <Segmented<AiLevel> disabled={disabled} label={`${source.name} for ${client.name}`} onChange={onLevel} options={LEVEL_OPTIONS} value={level} />
    </Row>
    <FailedChange message={failure} />
  </>;
}

function offeredTools(client: AiClient, source: AiSource) {
  if (!client.enabled || !source.running || needsToken(source)) return 0;
  return source.tools.filter((tool) => isOffered(tool) && tool.review === 'pinned' && toolAllowed(client, source.id, tool)).length;
}

function shortDate(at: string) {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function connectionFacts(client: AiClient, sources: AiSource[], mcpUrl: string | null, tunnel: AiTunnel | null): AdvancedFact[] {
  const viaTunnel = client.route === 'tunnel';
  const offered = sources.map((source) => ({ count: offeredTools(client, source), name: source.name })).filter((entry) => entry.count);
  const total = offered.reduce((sum, entry) => sum + entry.count, 0);
  const lastRequest = client.lastUsedAt ? ` · last request ${contactWhen(client.lastUsedAt)}` : '';
  return [
    { label: 'Route', value: viaTunnel ? `OpenAI tunnel (${tunnel?.tunnelId ?? 'not set up'})` : 'Direct (bearer token)' },
    ...(!viaTunnel && mcpUrl ? [{ code: true, label: 'MCP address', value: mcpUrl }] : []),
    { label: 'Transport', value: `Streamable HTTP · POST, JSON · ${viaTunnel ? 'key in X-MOS-Gateway-Key' : 'bearer token in Authorization'}` },
    { label: 'Tools offered', value: [String(total), offered.map((entry) => `${entry.name} ${entry.count}`).join(', ')].filter(Boolean).join(' · ') },
    { label: viaTunnel ? 'Gateway key' : 'Token', value: `Created ${shortDate(client.createdAt)}${lastRequest}` },
  ];
}

function BrokenTunnel({ client, onRemove }: { client: AiClient; onRemove: () => void }) {
  return <Notice title={`${client.name} cannot reach your suite`} variant="warning">
    <p>OpenAI stopped accepting the tunnel MOS keeps open for {client.name}. Remove {client.name} here, then add it again with a new tunnel and key. The MOS plugin in {client.name} can stay as it is.</p>
    <p><button className="mos-btn mos-btn-secondary" onClick={onRemove} type="button">Remove {client.name}</button></p>
  </Notice>;
}

function RowFooter({ busy, client, onToggleEnabled }: { busy: boolean; client: AiClient; onToggleEnabled: () => void }) {
  const activityPath = `${AI_ACTIVITY_PATH}?assistant=${encodeURIComponent(client.id)}`;
  return <>
    {client.route === 'tunnel' ? <DestinationLine variant="internet">What {client.name} reads is sent to OpenAI.</DestinationLine> : null}
    <div className="suite-ai-limits">
      <p>Up to 30 changes an hour. Tools that delete your data or share it are never offered.</p>
      <span className="suite-ai-limits-actions">
        {client.lastUsedAt ? <a className="mos-link" href={activityPath} onClick={navigateOnClick(activityPath)}>See what {client.name} did<Icon name="arrow-right" /></a> : null}
        <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onToggleEnabled} type="button">{client.enabled ? 'Turn off' : 'Turn on'} {client.name}</button>
      </span>
    </div>
  </>;
}

function rowPills(client: AiClient, sources: AiSource[], tunnel: AiTunnel | null, mcpUrl: string | null) {
  const unreachable = tunnelBroken(client, tunnel) || (client.route === 'direct' && !mcpUrl);
  const reviewWaiting = sources.some((source) => levelOf(client, source.id) !== 'off' && source.tools.some(needsReview));
  const pills = [unreachable ? 'Not working' : null, !unreachable && holdsOldAddress(client, mcpUrl) ? 'Old address' : null, reviewWaiting ? 'Needs review' : null].filter(Boolean);
  return pills.length ? <>{pills.map((pill, index) => <span key={pill}>{index ? ' ' : null}<span className="mos-pill mos-pill-warning">{pill}</span></span>)}</> : undefined;
}

export function ClientItem({ actions, busy, changed, client, expanded, failures, mcpUrl, onToggle, sources, tunnel }: {
  actions: ClientActions;
  busy: boolean;
  changed: boolean;
  client: AiClient;
  expanded: boolean;
  failures: Partial<Record<FailureSpot, string>>;
  mcpUrl: string | null;
  onToggle: () => void;
  sources: AiSource[];
  tunnel: AiTunnel | null;
}) {
  const [customizing, setCustomizing] = useState('');
  const [choosingDefault, setChoosingDefault] = useState(false);
  const [showingAddress, setShowingAddress] = useState(false);
  const broken = tunnelBroken(client, tunnel);
  const oldAddress = holdsOldAddress(client, mcpUrl);
  const menu = <ActionMenu ariaLabel={`More for ${client.name}`} disabled={busy} items={[
    ...(oldAddress ? [{ label: 'Show the new address', onSelect: () => setShowingAddress(true) }] : []),
    ...(client.route === 'direct' && mcpUrl ? [{ label: 'Make a new token', onSelect: actions.onRotate }] : []),
    { label: 'For apps you install later…', onSelect: () => setChoosingDefault(true) },
    { label: client.enabled ? 'Turn off' : 'Turn on', onSelect: actions.onToggleEnabled },
    { label: 'Remove', onSelect: actions.onRemove },
  ]} />;
  const customizeSource = sources.find((source) => source.id === customizing);
  const turnOnTunnel = tunnel?.state === 'off' ? <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={actions.onStartTunnel} type="button">Turn on the tunnel</button> : undefined;

  return <PanelItem flush quiet={!client.enabled}>
    <DisclosureRow aside={rowPills(client, sources, tunnel, mcpUrl)} expanded={expanded} lead={<Avatar {...avatarOf(client.name)} />} onToggle={onToggle} trailing={menu}>
      <strong>{client.name}</strong>
      <span className="suite-meta">{clientMeta(client, sources, tunnel)}</span>
      {oldAddress ? <span className="suite-meta">{oldAddressHelp(client)}</span> : null}
    </DisclosureRow>
    {expanded ? <div className="suite-ai-grants">
      {broken ? <BrokenTunnel client={client} onRemove={actions.onRemove} /> : tunnel && tunnel.state !== 'connected' ? <TunnelStatus action={turnOnTunnel} tunnel={tunnel} /> : null}
      {tunnel && !client.lastUsedAt ? <ChatGptSteps /> : null}
      <Rows>
        {sources.map((source) => <SourceLevel
          client={client}
          disabled={busy || broken}
          failure={failures[`level:${source.id}`]}
          key={source.id}
          onCustomize={() => setCustomizing(source.id)}
          onLevel={(level) => actions.onLevel(source.id, level)}
          onSourceToken={(token) => actions.onSourceToken(source.id, token)}
          source={source}
        />)}
      </Rows>
      <p className="suite-meta suite-ai-reload" role="status">{changed ? reloadHint(client) : null}</p>
      <RowFooter busy={busy} client={client} onToggleEnabled={actions.onToggleEnabled} />
      <FailedChange message={failures.row} />
      <AdvancedPanel facts={connectionFacts(client, sources, mcpUrl, tunnel)} reveal="technical-mode" summary="Connection details" />
    </div> : null}
    {customizeSource ? <CustomizeDialog actions={actions} busy={busy} client={client} failure={failures[`tools:${customizeSource.id}`]} onClose={() => setCustomizing('')} source={customizeSource} /> : null}
    {choosingDefault ? <DefaultLevelDialog busy={busy} client={client} onChange={actions.onDefaultLevel} onClose={() => setChoosingDefault(false)} /> : null}
    {showingAddress && mcpUrl ? <NewAddressDialog client={client} mcpUrl={mcpUrl} onClose={() => setShowingAddress(false)} /> : null}
  </PanelItem>;
}

function ToolSwitch({ busy, client, onAccept, onException, source, tool }: {
  busy: boolean;
  client: AiClient;
  onAccept: () => void;
  onException: (exception: AiException | null) => void;
  source: AiSource;
  tool: AiTool & { kind: OfferedKind };
}) {
  if (tool.review !== 'pinned') {
    return <Row help={`Changed in a ${source.name} update. It stays off for every assistant until you accept it.`} label={<>{tool.title} <span className="mos-pill mos-pill-warning">Needs review</span></>}>
      <RowTrailing><button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onAccept} type="button">Accept for every assistant</button></RowTrailing>
    </Row>;
  }
  const allowed = toolAllowed(client, source.id, tool);
  const custom = Boolean(client.exceptions[tool.name]);
  // Flipping back to what the level gives clears the exception instead of storing a redundant one.
  function flip(next: boolean) {
    const byLevel = toolAllowed({ ...client, exceptions: {} }, source.id, tool);
    onException(next === byLevel ? null : next ? 'allow' : 'block');
  }
  return <RowSwitch
    checked={allowed}
    description={tool.note || tool.description || undefined}
    disabled={busy}
    label={<>{tool.title}{custom ? <> <span className="mos-pill">Custom</span></> : null}</>}
    onChange={(event) => flip(event.currentTarget.checked)}
  />;
}

function neverOfferedLine(source: AiSource) {
  const never = source.tools.filter((tool) => !isOffered(tool)).map((tool) => tool.title.charAt(0).toLowerCase() + tool.title.slice(1));
  return never.length
    ? `Never offered to an AI: ${never.join(', ')}, and anything else that deletes your data or shares it.`
    : 'Never offered to an AI: anything that deletes your data or shares it.';
}

function CustomizeDialog({ actions, busy, client, failure, onClose, source }: { actions: ClientActions; busy: boolean; client: AiClient; failure: string | undefined; onClose: () => void; source: AiSource }) {
  const level = levelLabel(levelOf(client, source.id));
  const title = `${source.name} for ${client.name}`;
  const offered = source.tools.filter(isOffered);
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-ghost" disabled={busy || !customizedTools(client, source).length} onClick={() => actions.onReset(source.id)} type="button">Reset to {level}</button>
      <button className="mos-btn mos-btn-primary" onClick={onClose} type="button">Done</button>
    </>}
    header={<div><h2>{title}</h2><p className="suite-meta">Set to {level}. Change single tools here.</p></div>}
    onClose={onClose}
    title={title}
  >
    <div className="suite-ai-grant-app">
      {KIND_GROUPS.map((group) => {
        const tools = offered.filter((tool) => group.kinds.includes(tool.kind));
        if (!tools.length) return null;
        return <div className="suite-ai-grant-group" key={group.label}>
          <p className="suite-field-label">{group.label}</p>
          <Rows>{tools.map((tool) => <ToolSwitch
            busy={busy}
            client={client}
            key={tool.name}
            onAccept={() => actions.onAccept(source.id, tool.name)}
            onException={(exception) => actions.onException(source.id, tool.name, exception)}
            source={source}
            tool={tool}
          />)}</Rows>
        </div>;
      })}
      <FailedChange message={failure} />
      {source.error ? <p className="suite-meta">MOS cannot reach {source.name}&apos;s tools right now, so no assistant can use them. {source.error}</p> : null}
      <p className="suite-meta">{neverOfferedLine(source)}</p>
    </div>
  </Dialog>;
}

function DefaultLevelDialog({ busy, client, onChange, onClose }: { busy: boolean; client: AiClient; onChange: (level: AiLevel) => void; onClose: () => void }) {
  return <Dialog footer={<button className="mos-btn mos-btn-primary" onClick={onClose} type="button">Done</button>} onClose={onClose} title="For apps you install later">
    <div className="suite-settings-form">
      <p>Choose what {client.name} may do in apps you install from now on. Off unless you change it.</p>
      <Rows>
        <Row help="Apps you already have keep their own setting." label="Start new apps as">
          <Segmented<AiLevel> disabled={busy} label={`Apps installed later for ${client.name}`} onChange={onChange} options={LEVEL_OPTIONS} value={client.defaultLevel} />
        </Row>
      </Rows>
    </div>
  </Dialog>;
}

export function SourceTokenDialog({ busy, error, onClose, onSave, source }: { busy: boolean; error: string; onClose: () => void; onSave: (token: string) => void; source: AiSource }) {
  const [draft, setDraft] = useState('');
  const configured = Boolean(source.token?.configured);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.trim()) onSave(draft.trim());
  }

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" disabled={busy || !draft.trim()} form="suite-ai-source-token" type="submit">{busy ? 'Checking…' : 'Save'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={configured ? `Replace the ${source.name} token` : `Connect ${source.name} once`}
  >
    <form className="suite-settings-form" id="suite-ai-source-token" onSubmit={submit}>
      <p>{source.name} has its own sign-in, so MOS needs a {source.name} access token to reach it for your assistants. The token stays on your suite. No assistant ever sees it.</p>
      <TextInput autoComplete="new-password" autoFocus helperText={source.token?.hint || undefined} label={`${source.name} access token`} onChange={(event) => setDraft(event.target.value)} type="password" value={draft} />
      {error ? <Notice title={`${source.name} did not accept that token`} variant="error"><p>{error}</p></Notice> : null}
    </form>
  </Dialog>;
}

export function NewTokenDialog({ client, mcpUrl, onClose, token }: { client: AiClient; mcpUrl: string; onClose: () => void; token: string }) {
  return <Dialog footer={<button className="mos-btn mos-btn-primary" onClick={onClose} type="button">Done</button>} onClose={onClose} title={`New token for ${client.name}`}>
    <div className="suite-settings-form">
      <p>The old token no longer works. Paste this one into {client.name}&apos;s MCP settings.</p>
      <ConnectDetails mcpUrl={mcpUrl} token={token} />
      <AssistantDestination />
    </div>
  </Dialog>;
}

function NewAddressDialog({ client, mcpUrl, onClose }: { client: AiClient; mcpUrl: string; onClose: () => void }) {
  return <Dialog onClose={onClose} title={`New address for ${client.name}`}>
    <div className="suite-settings-form">
      <p>Your suite moved. Replace the address in {client.name}; the token stays the same.</p>
      <AddressField mcpUrl={mcpUrl} />
      <AssistantDestination />
    </div>
  </Dialog>;
}

export function RemoveClientDialog({ busy, client, error, onClose, onRemove }: { busy: boolean; client: AiClient; error: string; onClose: () => void; onRemove: () => void }) {
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-danger" disabled={busy} onClick={onRemove} type="button">{busy ? 'Removing...' : 'Remove'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Remove ${client.name}?`}
  >
    <div className="suite-settings-form">
      <p>{client.name} can no longer reach your apps through MOS, and what it may use is forgotten. Anything it already did with your apps stays, and so does its history under AI activity. To pause it instead, turn it off.</p>
      {error ? <Notice title={`${client.name} could not be removed`} variant="error"><p>{error}</p></Notice> : null}
    </div>
  </Dialog>;
}

export function tokenLine(source: AiSource) {
  if (!source.token?.configured) return `AI access is not enabled yet: ${source.name} needs to give MOS an access token.`;
  return source.token.verifiedAt ? `Accepted by ${source.name}. Last checked: ${whenWords(source.token.verifiedAt)}.` : 'Token saved.';
}

