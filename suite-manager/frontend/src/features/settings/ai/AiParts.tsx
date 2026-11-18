import { useEffect, useState, type FormEvent } from 'react';

import { ActionMenu, Dialog, DisclosureRow, Notice, PanelItem, Row, RowSwitch, RowTrailing, Rows, Segmented, TextInput } from '../../../components/ui';
import { whenWords } from '../../../lib/dates';
import { ConnectInstructions, PrivacyLine } from './AddAssistantDialog';
import {
  customizedTools, isOffered, KIND_GROUPS, LEVEL_OPTIONS, LEVEL_WORDS, levelOf, toolAllowed,
  type AiClient, type AiException, type AiLevel, type AiSource, type AiTool, type OfferedKind,
} from './model';

export type ClientActions = {
  onAccept: (tool: string) => void;
  onDefaultLevel: (level: AiLevel) => void;
  onException: (tool: string, exception: AiException | null) => void;
  onLevel: (sourceId: string, level: AiLevel) => void;
  onLevelWithToken: (sourceId: string, level: AiLevel, token: string) => Promise<string>;
  onRemove: () => void;
  onReset: (sourceId: string) => void;
  onRotate: () => void;
  onToggleEnabled: () => void;
};

const LEVEL_LABEL: Record<AiLevel, string> = Object.fromEntries(LEVEL_OPTIONS.map((option) => [option.value, option.label])) as Record<AiLevel, string>;

function needsReview(tool: AiTool) {
  return isOffered(tool) && tool.review !== 'pinned';
}

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function clientMeta(client: AiClient, sources: AiSource[]) {
  if (!client.enabled) return 'Turned off · settings kept';
  const shared = sources.filter((source) => levelOf(client, source.id) !== 'off').map((source) => `${source.name}: ${LEVEL_WORDS[levelOf(client, source.id)]}`);
  const used = client.lastUsedAt ? `used ${lowerFirst(whenWords(client.lastUsedAt))}` : 'not used yet';
  return [...(shared.length ? shared : ['nothing shared yet']), used].join(' · ');
}

function needsToken(source: AiSource) {
  return Boolean(source.token && !source.token.configured);
}

function levelHelp(source: AiSource, level: AiLevel) {
  if (!source.running) return `${source.name} is stopped, so an AI cannot use it right now.`;
  if (source.builtin) {
    return { act: 'Can check how your apps are doing and restart one that is stuck.', off: 'Cannot see how your apps are doing.', see: 'Can check how your apps are doing.' }[level];
  }
  if (level === 'off') return `Cannot use ${source.name}.`;
  const allowed = source.tools.filter(isOffered).filter((tool) => (level === 'act' ? true : tool.kind === 'read'));
  const notes = [...new Set(allowed.map((tool) => tool.note).filter(Boolean))].join(' ');
  const verb = level === 'act' ? 'Can look things up and make changes' : 'Can look things up';
  return `${verb} in ${source.name}.${notes ? ` ${notes}` : ''}`;
}

// The first time an app is opened to any AI, the app has to let MOS in once.
// Asked here, at the moment it matters, rather than as a field of its own.
function TokenStep({ level, onCancel, onSave, source }: { level: AiLevel; onCancel: () => void; onSave: (token: string) => Promise<string>; source: AiSource }) {
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

  return <form className="suite-ai-token-step" onSubmit={(event) => void submit(event)}>
    <Notice title={`Let MOS into ${source.name}`} variant="info">
      <p>You chose {LEVEL_LABEL[level]}. {source.name} has to let MOS in first, once for every AI you connect. {source.token?.hint || `Create an access token in ${source.name}.`} It stays on your suite and is never given to an AI.</p>
    </Notice>
    {source.token?.appUrl ? <a className="mos-btn mos-btn-secondary" href={source.token.appUrl} rel="noreferrer" target="_blank">Open {source.name}</a> : null}
    <TextInput autoComplete="new-password" autoFocus label={`${source.name} access token`} onChange={(event) => setDraft(event.target.value)} type="password" value={draft} />
    {error ? <Notice title={`${source.name} did not accept that token`} variant="error"><p>{error}</p></Notice> : null}
    <div className="suite-ai-token-actions">
      <button className="mos-btn mos-btn-ghost" disabled={saving} onClick={onCancel} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" disabled={saving || !draft.trim()} type="submit">{saving ? 'Checking...' : 'Save and turn on'}</button>
    </div>
  </form>;
}

function SourceLevel({ busy, client, onCustomize, onLevel, onLevelWithToken, source }: {
  busy: boolean;
  client: AiClient;
  onCustomize: () => void;
  onLevel: (level: AiLevel) => void;
  onLevelWithToken: (level: AiLevel, token: string) => Promise<string>;
  source: AiSource;
}) {
  const [pending, setPending] = useState<AiLevel | null>(null);
  const level = levelOf(client, source.id);
  useEffect(() => { if (!needsToken(source)) setPending(null); }, [source]);

  function pick(next: AiLevel) {
    if (next !== 'off' && needsToken(source)) setPending(next);
    else onLevel(next);
  }

  const custom = customizedTools(client, source).length > 0;
  const offered = source.tools.some(isOffered);
  const label = <>{source.name}{custom ? <> <span className="mos-pill">Custom</span></> : null}{source.tools.some(needsReview) ? <> <span className="mos-pill mos-pill-warning">Needs review</span></> : null}</>;
  return <>
    <Row
      help={<>{levelHelp(source, level)}{offered && !pending ? <> <button className="mos-link suite-link-button" onClick={onCustomize} type="button">Customize</button></> : null}</>}
      label={label}
    >
      <Segmented<AiLevel> disabled={busy} label={`${source.name} for ${client.name}`} onChange={pick} options={LEVEL_OPTIONS} value={pending ?? level} />
    </Row>
    {pending ? <TokenStep level={pending} onCancel={() => setPending(null)} onSave={(token) => onLevelWithToken(pending, token)} source={source} /> : null}
  </>;
}

export function ClientItem({ actions, busy, changed, client, expanded, onToggle, sources }: {
  actions: ClientActions;
  busy: boolean;
  changed: boolean;
  client: AiClient;
  expanded: boolean;
  onToggle: () => void;
  sources: AiSource[];
}) {
  const [customizing, setCustomizing] = useState('');
  const [choosingDefault, setChoosingDefault] = useState(false);
  const reviewWaiting = sources.some((source) => levelOf(client, source.id) !== 'off' && source.tools.some(needsReview));
  const menu = <ActionMenu ariaLabel={`More for ${client.name}`} disabled={busy} items={[
    ...(client.route === 'direct' ? [{ label: 'New token', onSelect: actions.onRotate }] : []),
    { label: client.enabled ? 'Turn off' : 'Turn on', onSelect: actions.onToggleEnabled },
    { label: 'Remove', onSelect: actions.onRemove },
  ]} />;
  const customizeSource = sources.find((source) => source.id === customizing);

  return <PanelItem flush quiet={!client.enabled} selected={expanded}>
    <DisclosureRow expanded={expanded} label={`${expanded ? 'Hide' : 'Show'} what ${client.name} may use`} onToggle={onToggle} trailing={<>
      {reviewWaiting ? <span className="mos-pill mos-pill-warning">Needs review</span> : null}
      {menu}
    </>}>
      <span className="suite-source-main">
        <strong>{client.name}</strong>
        <span className="suite-meta">{clientMeta(client, sources)}</span>
      </span>
    </DisclosureRow>
    {expanded ? <div className="suite-ai-grants">
      {sources.length ? <Rows>
        {sources.map((source) => <SourceLevel busy={busy} client={client} key={source.id} onCustomize={() => setCustomizing(source.id)} onLevel={(level) => actions.onLevel(source.id, level)} onLevelWithToken={(level, token) => actions.onLevelWithToken(source.id, level, token)} source={source} />)}
      </Rows> : <p className="suite-meta">None of your installed apps can be used by an AI yet.</p>}
      <p className="suite-meta">Apps you add later start as {LEVEL_LABEL[client.defaultLevel]}. <button className="mos-link suite-link-button" disabled={busy} onClick={() => setChoosingDefault(true)} type="button">Change</button></p>
      {changed ? <p className="suite-meta">{client.name} may need to reload its tool list to see the change.</p> : null}
    </div> : null}
    {customizeSource ? <CustomizeDialog actions={actions} busy={busy} client={client} onClose={() => setCustomizing('')} source={customizeSource} /> : null}
    {choosingDefault ? <DefaultLevelDialog busy={busy} client={client} onChange={actions.onDefaultLevel} onClose={() => setChoosingDefault(false)} /> : null}
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
    return <Row help={`Changed in a ${source.name} update. It stays off until you accept it.`} label={<>{tool.title} <span className="mos-pill mos-pill-warning">Needs review</span></>}>
      <RowTrailing><button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onAccept} type="button">Accept</button></RowTrailing>
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
  const never = source.tools.filter((tool) => !isOffered(tool)).map((tool) => lowerFirst(tool.title));
  return never.length
    ? `Never offered to an AI: ${never.join(', ')}, and anything that would delete or share with others.`
    : 'Never offered to an AI: deleting, and anything that would share with others.';
}

function CustomizeDialog({ actions, busy, client, onClose, source }: { actions: ClientActions; busy: boolean; client: AiClient; onClose: () => void; source: AiSource }) {
  const level = levelOf(client, source.id);
  const title = `${source.name} for ${client.name}`;
  const offered = source.tools.filter(isOffered);
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-ghost" disabled={busy || !customizedTools(client, source).length} onClick={() => actions.onReset(source.id)} type="button">Reset to {LEVEL_LABEL[level]}</button>
      <button className="mos-btn mos-btn-primary" onClick={onClose} type="button">Done</button>
    </>}
    header={<div><h2>{title}</h2><p className="suite-meta">Set to {LEVEL_LABEL[level]}. Change single tools here.</p></div>}
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
            onAccept={() => actions.onAccept(tool.name)}
            onException={(exception) => actions.onException(tool.name, exception)}
            source={source}
            tool={tool}
          />)}</Rows>
        </div>;
      })}
      {source.error ? <Notice title={`MOS could not read what ${source.name} offers`} variant="warning"><p>{source.error}</p></Notice> : null}
      <p className="suite-meta">{neverOfferedLine(source)}</p>
    </div>
  </Dialog>;
}

function DefaultLevelDialog({ busy, client, onChange, onClose }: { busy: boolean; client: AiClient; onChange: (level: AiLevel) => void; onClose: () => void }) {
  return <Dialog footer={<button className="mos-btn mos-btn-primary" onClick={onClose} type="button">Done</button>} onClose={onClose} title="Apps you add later">
    <Rows>
      <Row help={`What ${client.name} may do in an app you install from now on. Apps you already have keep their own setting.`} label="Start new apps as">
        <Segmented<AiLevel> disabled={busy} label={`Apps added later for ${client.name}`} onChange={onChange} options={LEVEL_OPTIONS} value={client.defaultLevel} />
      </Row>
    </Rows>
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
      <button className="mos-btn mos-btn-primary" disabled={busy || !draft.trim()} form="suite-ai-source-token" type="submit">{busy ? 'Checking...' : 'Save'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={configured ? `Replace the ${source.name} token` : `Let an AI use ${source.name}`}
  >
    <form className="suite-settings-form" id="suite-ai-source-token" onSubmit={submit}>
      <p>MOS uses an access token from {source.name} to act there for your assistants. It stays on your suite and is never given to an AI.</p>
      <TextInput autoComplete="new-password" autoFocus helperText={source.token?.hint || undefined} label={`${source.name} access token`} onChange={(event) => setDraft(event.target.value)} type="password" value={draft} />
      {error ? <Notice title={`${source.name} did not accept that token`} variant="error"><p>{error}</p></Notice> : null}
    </form>
  </Dialog>;
}

export function NewTokenDialog({ client, mcpUrl, onClose, token }: { client: AiClient; mcpUrl: string | null; onClose: () => void; token: string }) {
  return <Dialog footer={<button className="mos-btn mos-btn-primary" onClick={onClose} type="button">Done</button>} onClose={onClose} title={`New token for ${client.name}`}>
    <div className="suite-settings-form">
      <p>The old token no longer works. Set {client.name} up again with this one.</p>
      <ConnectInstructions mcpUrl={mcpUrl} token={token} />
      <PrivacyLine />
    </div>
  </Dialog>;
}

export function RemoveClientDialog({ busy, client, onClose, onRemove }: { busy: boolean; client: AiClient; onClose: () => void; onRemove: () => void }) {
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-danger" disabled={busy} onClick={onRemove} type="button">{busy ? 'Removing...' : 'Remove'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Remove ${client.name}?`}
  >
    <p>{client.name} can no longer reach your apps through MOS, and what it may use is forgotten. Anything it already did in your apps stays, and so does its history under AI activity. To pause it instead, turn it off.</p>
  </Dialog>;
}

export function tokenLine(source: AiSource) {
  if (!source.token?.configured) return `No token yet, so an AI cannot use ${source.name}.`;
  return source.token.verifiedAt ? `Accepted by ${source.name}. Last checked: ${whenWords(source.token.verifiedAt)}.` : 'Token saved.';
}
