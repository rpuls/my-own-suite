import { useEffect, useMemo, useState } from 'react';

import { Avatar, FilterChips, Icon, Notice } from '../../components/ui';
import { aiActivity, aiRequest, type AiActivityEntry, type AiClient } from '../settings/ai/model';
import { avatarOf, initialsOf, plural, timelineOf, type TimelineRequest, type TimelineStep } from './timeline';

const AI_SETTINGS_PATH = '/suite-manager/settings#set-ai';
const DASHBOARD_HISTORY_PATH = '/suite-manager/customize#history';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function clock(at: string) {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function AiAvatar({ name }: { name: string }) {
  return <Avatar {...avatarOf(name)} initials={initialsOf(name)} />;
}

function Step({ step }: { step: TimelineStep }) {
  const details = [step.count > 1 ? `${step.count} times` : null, step.detail].filter(Boolean).join(' · ');
  return <li className={`suite-ai-step suite-ai-step-${step.tone}`}>
    {step.tone === 'problem'
      ? <span aria-label="Refused" className="suite-ai-step-icon suite-ai-step-stop" role="img"><Icon name="shield" /></span>
      : step.iconUrl ? <img alt={step.sourceName} className="suite-ai-step-icon" height="22" src={step.iconUrl} width="22" /> : <span aria-label={step.sourceName} className="suite-ai-step-icon" role="img"><Icon name="apps" /></span>}
    <span className="suite-ai-step-text">{step.text}{details ? <span className="suite-ai-step-detail">{details}</span> : null}{step.undoable ? <> <a className="mos-link suite-ai-step-undo" href={DASHBOARD_HISTORY_PATH}>Undo</a></> : null}</span>
  </li>;
}

function Request({ request }: { request: TimelineRequest }) {
  const notable = request.steps.some((step) => step.tone !== 'read');
  return <div className={`suite-ai-entry${request.clientRemoved ? ' is-removed' : ''}`}>
    <time className="suite-ai-entry-time" dateTime={request.at}>{clock(request.at)}</time>
    <AiAvatar name={request.clientName} />
    <article className="suite-ai-card">
      <header className="suite-ai-card-who">
        <span>{request.clientName}{request.clientRemoved ? <span className="suite-ai-card-removed"> · since removed</span> : null}</span>
        {notable && !request.clientRemoved ? <a className="suite-ai-card-notyou" href={AI_SETTINGS_PATH}>Not you?</a> : null}
      </header>
      <ul className="suite-ai-steps">{request.steps.map((step) => <Step key={step.key} step={step} />)}</ul>
    </article>
  </div>;
}

// What the AI did, one card per thing the owner asked for: which action ran and
// how it went, never what was read or written.
export function AiActivityScreen() {
  const [clients, setClients] = useState<AiClient[]>([]);
  const [clientId, setClientId] = useState('');
  const [entries, setEntries] = useState<AiActivityEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const days = useMemo(() => timelineOf(entries ?? []), [entries]);

  useEffect(() => {
    aiRequest('GET', '', 'Unable to load your AI.').then((status) => setClients(status.clients), () => setClients([]));
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
    <div className="suite-ai-timeline">
      <div className="suite-hero">
        <h1>AI activity</h1>
        <p className="suite-lead mos-body-lg">Everything your AI did in your apps, one card per request. MOS keeps which action ran, never what was read or written, for 90 days.</p>
      </div>
      {clients.length > 1 ? <FilterChips
        label="Show activity for"
        onChange={setClientId}
        options={[{ label: 'Every AI', value: '' }, ...clients.map((client) => ({ label: client.name, lead: <AiAvatar name={client.name} />, value: client.id }))]}
        value={clientId}
      /> : null}
      {error ? <Notice title="Something went wrong" variant="error"><p>{error}</p></Notice> : null}
      {entries && !entries.length ? <p className="suite-meta">Nothing yet. When an AI you connected uses your apps, it shows up here.</p> : null}
      {days.map((day) => <section aria-label={day.title} className="suite-ai-day" key={day.key}>
        <h2 className="suite-ai-day-head">
          <span>{day.title}</span>
          <span className="suite-ai-day-sum">{[plural(day.requests.length, 'request'), day.changes ? plural(day.changes, 'change') : null].filter(Boolean).join(' · ')}</span>
        </h2>
        {day.requests.map((request) => <Request key={request.key} request={request} />)}
      </section>)}
      {nextBefore ? <div className="suite-ai-more">
        <button className="mos-btn mos-btn-ghost" disabled={loading} onClick={() => void load(nextBefore)} type="button">{loading ? 'Loading...' : 'Show earlier'}</button>
      </div> : null}
    </div>
  </section>;
}
