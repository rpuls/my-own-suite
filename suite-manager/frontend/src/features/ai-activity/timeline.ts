import { brandOf } from './ai-brands';
import type { AiActivityEntry, AiOutcome } from '../settings/ai/model';

// Calls this close together from one AI are one thing the owner asked for.
const REQUEST_GAP_MS = 2 * 60_000;

export type StepTone = 'change' | 'problem' | 'read';

export type TimelineStep = {
  count: number;
  // A dashboard change the owner can step back from under Customize → History.
  undoable: boolean;
  detail: string | null;
  iconUrl: string | null;
  key: number;
  sourceName: string;
  text: string;
  tone: StepTone;
};

export type TimelineRequest = {
  at: string;
  clientId: string;
  clientName: string;
  clientRemoved: boolean;
  key: number;
  steps: TimelineStep[];
};

export type TimelineDay = { actions: number; changes: number; key: string; requests: TimelineRequest[]; title: string };

const PAST_TENSE: Record<string, string> = {
  add: 'Added', change: 'Changed', check: 'Checked', create: 'Created', delete: 'Deleted', download: 'Downloaded',
  edit: 'Edited', find: 'Found', get: 'Got', list: 'Listed', look: 'Looked', move: 'Moved', open: 'Opened',
  read: 'Read', remove: 'Removed', rename: 'Renamed', restart: 'Restarted', save: 'Saved', search: 'Searched',
  send: 'Sent', set: 'Set', share: 'Shared', show: 'Showed', start: 'Started', stop: 'Stopped', tag: 'Tagged',
  update: 'Updated', upload: 'Uploaded', write: 'Wrote',
};

const REFUSAL_WORDS: Partial<Record<AiOutcome, string>> = {
  'limit-reached': 'Over 30 changes in an hour, so nothing happened',
  'needs-review': 'Waiting for your review, so nothing happened',
  'never-offered': 'Never offered to an assistant, so nothing happened',
  'not-allowed': 'Not allowed for this assistant, so nothing happened',
  'too-large': 'Too large to pass on, so nothing happened',
};

const BUILTIN_ICON = '/suite-manager/assets/brand/my-own-suite-mark.png';

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function title(entry: AiActivityEntry) {
  return entry.toolTitle || entry.tool;
}

export function pastTense(text: string) {
  const [verb = '', ...rest] = text.split(' ');
  const past = PAST_TENSE[verb.toLowerCase()];
  return past ? [past, ...rest].join(' ') : text;
}

function toneOf(entry: AiActivityEntry): StepTone {
  if (entry.outcome !== 'ok') return 'problem';
  return entry.kind === 'add' || entry.kind === 'change' ? 'change' : 'read';
}

function textOf(entry: AiActivityEntry) {
  if (!entry.toolTitle) return 'Tried to use a tool MOS does not offer';
  if (REFUSAL_WORDS[entry.outcome]) return `Tried to ${lowerFirst(title(entry))}`;
  return pastTense(title(entry));
}

function detailOf(entry: AiActivityEntry) {
  if (entry.outcome === 'tool-error') return `${entry.sourceName} reported a problem`;
  if (entry.outcome === 'failed') return `Could not reach ${entry.sourceName}`;
  return REFUSAL_WORDS[entry.outcome] ?? null;
}

export function sourceIconUrl(sourceId: string) {
  return sourceId === 'mos' ? BUILTIN_ICON : `/suite-manager/api/apps/packages/${encodeURIComponent(sourceId)}/icon`;
}

function iconOf(entry: AiActivityEntry) {
  return entry.sourceId ? sourceIconUrl(entry.sourceId) : null;
}

function stepOf(entry: AiActivityEntry): TimelineStep {
  const undoable = entry.outcome === 'ok' && (entry.tool === 'mos_dashboard_change' || entry.tool === 'mos_dashboard_restore');
  return { count: entry.repeats, detail: detailOf(entry), iconUrl: iconOf(entry), key: entry.id, sourceName: entry.sourceName, text: textOf(entry), tone: toneOf(entry), undoable };
}

function dayKey(at: string) {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayTitle(at: string, now = new Date()) {
  const date = new Date(at);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const daysAgo = Math.ceil((midnight.getTime() - date.getTime()) / 86_400_000);
  if (daysAgo <= 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', weekday: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

// Entries arrive newest first. Requests and days stay newest first; the steps
// inside one request read in the order they happened.
export function timelineOf(entries: AiActivityEntry[], now = new Date()): TimelineDay[] {
  const days: TimelineDay[] = [];
  let request: TimelineRequest | null = null;
  let earliest = 0;
  for (const entry of entries) {
    const at = new Date(entry.at).getTime();
    let day = days.at(-1);
    if (!day || day.key !== dayKey(entry.at)) {
      day = { actions: 0, changes: 0, key: dayKey(entry.at), requests: [], title: dayTitle(entry.at, now) };
      days.push(day);
      request = null;
    }
    if (!request || request.clientId !== entry.clientId || earliest - at > REQUEST_GAP_MS) {
      request = { at: entry.at, clientId: entry.clientId, clientName: entry.clientName, clientRemoved: entry.clientRemoved, key: entry.id, steps: [] };
      day.requests.push(request);
    }
    earliest = at;
    request.at = entry.at;
    const step = stepOf(entry);
    const next = request.steps[0];
    if (next && next.text === step.text && next.tone === step.tone && next.detail === step.detail && !step.undoable) next.count += step.count;
    else request.steps.unshift(step);
    day.actions += step.count;
    if (step.tone === 'change') day.changes += step.count;
  }
  return days;
}

export function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function initialsOf(name: string) {
  const words = name.trim().replace(/([a-z])([A-Z])/gu, '$1 $2').split(/[\s._-]+/u).filter(Boolean);
  const first = words[0] ?? '?';
  if (/^[A-Z0-9]{2,}$/u.test(first)) return first.slice(0, 2);
  return ((first[0] ?? '') + (words[1]?.[0] ?? first[1] ?? '')).toUpperCase();
}

const AVATAR_COLOURS = ['#d0744a', '#7b6cf6', '#2f9e8f', '#3b82c4', '#c2557a', '#8a7f2c', '#b7701f', '#5b7088'];

// A known AI wears its brand's colours; any other keeps a colour that is stable per name.
export function avatarOf(name: string) {
  const brand = brandOf(name);
  if (brand) return { background: brand.background, initials: brand.initials ?? initialsOf(name), ink: brand.ink };
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { background: AVATAR_COLOURS[hash % AVATAR_COLOURS.length]!, initials: initialsOf(name), ink: '#ffffff' };
}
