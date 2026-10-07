import { useEffect, useState } from 'react';

import { Panel, PanelBand, PanelHead, PanelItem, PanelList } from '../../components/ui';
import { jsonResponse } from '../../lib/api';
import { EditToggle } from './EditToggle';

type SecurityEventSummary = {
  byType: Array<{ eventCount: number; eventType: string; lastSeenAt: string | null; subjectCount: number }>;
  eventCount: number;
  lastSeenAt: string | null;
  since: string;
};

const securityEventLabels: Record<string, { description: string; label: string }> = {
  'app-catalog-signature-invalid': { description: 'Catalog data was refused because its publisher signature was missing or invalid.', label: 'Invalid catalog signatures' },
  'app-source-candidate-rejected': { description: 'An external package candidate failed MOS safety or validation checks.', label: 'Rejected external packages' },
  'app-source-download-throttled': { description: 'An external package source exceeded its bounded download rate.', label: 'Throttled package sources' },
  'login-throttled': { description: 'Repeated failed sign-in attempts were temporarily slowed down.', label: 'Throttled sign-in attempts' },
};

export function SecurityActivityPanel() {
  const [summary, setSummary] = useState<SecurityEventSummary | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void fetch('/suite-manager/api/settings/security-events')
      .then((response) => jsonResponse<SecurityEventSummary>(response, 'Unable to load recent security activity.'))
      .then((next) => { setSummary(next); setError(''); })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load recent security activity.'));
  }, []);

  const count = summary?.eventCount ?? 0;

  return <Panel>
    <PanelHead actions={count > 0 ? <EditToggle editing={open} label="View" onToggle={() => setOpen(!open)} /> : null} heading="h3" title="Security activity">
      <p>Times MOS slowed or refused an action in the last 30 days. Counts show patterns without IP addresses, repository URLs, or internal subject identifiers.</p>
    </PanelHead>
    {error ? <PanelBand icon="shield" note={error} title="Security activity unavailable" tone="warning" />
      : !summary ? <PanelBand busy title="Loading security activity" />
        : count === 0 ? <PanelBand icon="check" note="MOS has not recorded any of the monitored events during this period." title="No recorded security events" tone="accent" />
          : <PanelBand icon="shield" note="These mean MOS slowed or refused an action. They do not by themselves prove the server was compromised." title={`${count} security event${count === 1 ? '' : 's'} recorded`} tone="warning" />}
    {summary && count > 0 && open ? <PanelList>
      {summary.byType.map((event) => {
        const copy = securityEventLabels[event.eventType] || { description: 'MOS recorded a security-relevant refusal.', label: event.eventType };
        return <PanelItem key={event.eventType}>
          <div className="suite-settings-row">
            <div className="suite-settings-row-main">
              <strong>{copy.label}</strong>
              <span className="suite-meta">{copy.description} Across {event.subjectCount} subject{event.subjectCount === 1 ? '' : 's'}; last seen {event.lastSeenAt ? new Date(event.lastSeenAt).toLocaleString() : 'unknown'}.</span>
            </div>
            <span className="mos-pill" title={`${event.eventCount} event${event.eventCount === 1 ? '' : 's'}`}>{event.eventCount}</span>
          </div>
        </PanelItem>;
      })}
    </PanelList> : null}
  </Panel>;
}
