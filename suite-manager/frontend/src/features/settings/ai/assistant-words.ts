import { lowerFirst, shortWhenWords } from '../../../lib/dates';
import { cappedNames, countOf, customizedTools, isOffered, LEVEL_OPTIONS, levelOf, nameList, TUNNEL_WORDS, type AiClient, type AiLevel, type AiSource, type AiTool, type AiTunnel } from './model';

// What card 1 says, kept apart from how it is laid out. The words follow the
// Segmented's own labels, so a row's meta reads like the control it summarises.

const META_NAMES = 3;
const LEVEL_LABEL = Object.fromEntries(LEVEL_OPTIONS.map((option) => [option.value, option.label])) as Record<AiLevel, string>;

export function contactWhen(at: string) {
  return lowerFirst(shortWhenWords(at));
}

export function lastConnected(client: AiClient) {
  return client.lastUsedAt ? `Last connected ${contactWhen(client.lastUsedAt)}` : 'Not connected yet';
}

// MOS keeps only a hash of each token, so a moved suite can hand out its new address but never the old token.
export function holdsOldAddress(client: AiClient, mcpUrl: string | null) {
  return client.route === 'direct' && Boolean(mcpUrl && client.issuedUrl) && client.issuedUrl !== mcpUrl;
}

export function oldAddressHelp(client: AiClient) {
  return `Your suite has a new address. Give ${client.name} the new one; its token still works.`;
}

// A tunnel OpenAI refuses after it has worked: whatever the reason, the fix is to set it up again.
export function tunnelBroken(client: AiClient, tunnel: AiTunnel | null) {
  return tunnel?.state === 'refused' && Boolean(client.lastUsedAt);
}

function grantGroups(client: AiClient, sources: AiSource[]) {
  const custom = sources.filter((source) => customizedTools(client, source).length);
  const at = (level: AiLevel) => sources.filter((source) => !custom.includes(source) && levelOf(client, source.id) === level);
  return [
    { label: LEVEL_LABEL.act, sources: at('act') },
    { label: LEVEL_LABEL.see, sources: at('see') },
    { label: 'Custom', sources: custom },
  ].filter((group) => group.sources.length);
}

// At most three app names across the whole line, spent level by level; the rest are counted.
export function grantsMeta(client: AiClient, sources: AiSource[]) {
  const groups = grantGroups(client, sources);
  if (!groups.length) return 'Nothing allowed yet';
  let namesLeft = META_NAMES;
  return groups.map((group) => {
    const names = group.sources.map((source) => source.name);
    const shown = Math.min(namesLeft, names.length);
    namesLeft -= shown;
    if (!shown) return `${group.label}: ${countOf(names.length, 'app')}`;
    return `${group.label}: ${cappedNames(names, shown)}`;
  }).join(' · ');
}

export function clientMeta(client: AiClient, sources: AiSource[], tunnel: AiTunnel | null) {
  if (!client.enabled) return 'Turned off · settings kept';
  if (tunnelBroken(client, tunnel)) return lastConnected(client);
  if (tunnel && tunnel.state !== 'connected') return TUNNEL_WORDS[tunnel.state];
  return [tunnel ? 'Through OpenAI\'s tunnel' : null, lastConnected(client), grantsMeta(client, sources)].filter(Boolean).join(' · ');
}

export function headLead(sources: AiSource[]) {
  const apps = sources.length ? ` Apps you can allow: ${nameList(sources.map((source) => source.name))}.` : '';
  return `Ask your AI chat to look things up or make changes for you.${apps}`;
}

const EXAMPLE_PROMPTS: Record<string, string> = {
  memos: 'Find my note about the boiler',
  'paperless-ngx': 'Which letters came from the tax office this year?',
};

// One example from an installed app, then the one every suite can answer.
export function examplePrompts(sources: AiSource[]) {
  const fromApp = sources.map((source) => EXAMPLE_PROMPTS[source.id]).find(Boolean);
  return [fromApp, 'Is everything running?'].filter(Boolean).map((prompt) => `“${prompt}”`).join(' or ');
}

export function needsToken(source: AiSource) {
  return Boolean(source.token && !source.token.configured);
}

function exceptionCounts(client: AiClient, source: AiSource) {
  const exceptions = customizedTools(client, source).map((tool) => client.exceptions[tool.name]);
  return { allowed: exceptions.filter((exception) => exception === 'allow').length, blocked: exceptions.filter((exception) => exception === 'block').length };
}

function levelSentence(client: AiClient, source: AiSource, level: AiLevel) {
  const { allowed, blocked } = exceptionCounts(client, source);
  const tools = (count: number) => countOf(count, 'tool');
  if (level === 'off') return allowed ? `Off, except ${tools(allowed)} you allowed under Customize.` : `Cannot use ${source.name}'s own tools.`;
  if (level === 'see') {
    if (allowed) return `See, plus ${tools(allowed)} you allowed under Customize.`;
    return blocked ? `See, except ${tools(blocked)} you blocked under Customize.` : `Can look things up in ${source.name}.`;
  }
  return blocked
    ? `See and do, except ${tools(blocked)} you blocked under Customize.`
    : `Can look things up and make changes in ${source.name}. Changes overwrite what was there and cannot be undone from MOS.`;
}

function isChange(tool: AiTool) {
  return isOffered(tool) && tool.kind !== 'read';
}

// The notes of an app's add and change tools matter only once it may make changes.
export function appHelp(client: AiClient, source: AiSource) {
  if (!source.running) return `${source.name} is stopped, so no AI can use it right now. Your choice is kept.`;
  if (source.error) return `MOS cannot reach ${source.name}'s tools right now, so no assistant can use them. ${source.error}`;
  const level = levelOf(client, source.id);
  const notes = level === 'act' ? [...new Set(source.tools.filter(isChange).map((tool) => tool.note).filter(Boolean))] : [];
  return [levelSentence(client, source, level), ...notes].join(' ');
}

export function tokenHelp(source: AiSource, level: AiLevel) {
  return level === 'off'
    ? `Needs one step in ${source.name} before an assistant can use it.`
    : `MOS no longer has a ${source.name} token, so no assistant can use ${source.name} right now. Set it up again to continue.`;
}

export function reloadHint(client: AiClient) {
  return client.route === 'tunnel'
    ? 'In ChatGPT, press Refresh tools in the MOS plugin to see the change.'
    : `${client.name} may need to reload its tool list to see the change.`;
}

export function levelLabel(level: AiLevel) {
  return LEVEL_LABEL[level];
}
