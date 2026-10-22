import { formatBytes } from '../../lib/bytes';
import type { StorageEntry, StorageUsage } from './model';

type Tone = 'accent' | 'info' | 'muted' | 'warning';
export type UsageSegment = { bytes: number; label: string; tone: Tone };

const APP_TONES: Tone[] = ['accent', 'info'];

// What is on a drive, in the legend's order: each app, the backups, then whatever
// else the drive holds that MOS did not put there.
export function usageSegments(entry: StorageEntry, usage: StorageUsage | null): UsageSegment[] {
  if (entry.sizeBytes === null || entry.availableBytes === null) return [];
  if (entry.systemUsage) {
    return entry.systemUsage.appsBytes
      ? [{ bytes: entry.systemUsage.systemBytes, label: 'MOS itself', tone: 'info' }, { bytes: entry.systemUsage.appsBytes, label: 'Apps and their data', tone: 'accent' }]
      : [{ bytes: entry.systemUsage.systemBytes, label: 'MOS and your apps', tone: 'info' }];
  }
  const used = Math.max(0, entry.sizeBytes - entry.availableBytes);
  const byApp = new Map<string, number>();
  for (const folder of usage?.folders.filter((item) => item.driveId === entry.id) || []) byApp.set(folder.appName, (byApp.get(folder.appName) || 0) + folder.bytes);
  const apps = [...byApp].map(([label, bytes], index): UsageSegment => ({ bytes, label, tone: APP_TONES[index % APP_TONES.length] ?? 'accent' }));
  const backups = usage?.backups.find((item) => item.driveId === entry.id)?.bytes || 0;
  const known = apps.reduce((sum, segment) => sum + segment.bytes, 0) + backups;
  const rest: UsageSegment = entry.kind === 'system'
    ? { bytes: Math.max(0, used - known), label: 'MOS and your apps', tone: 'info' }
    : { bytes: Math.max(0, used - known), label: 'Other files', tone: 'muted' };
  const segments: UsageSegment[] = [...apps, ...(backups ? [{ bytes: backups, label: 'Backups', tone: 'warning' as const }] : []), rest];
  return segments.filter((segment) => segment.bytes > 0);
}

function share(bytes: number, total: number) {
  return `${Math.min(100, (bytes / total) * 100).toFixed(2)}%`;
}

export function UsageBar({ entry, segments, variant }: { entry: StorageEntry; segments: UsageSegment[]; variant: 'compact' | 'full' }) {
  const total = entry.sizeBytes;
  if (total === null || entry.availableBytes === null) return null;
  const used = total - entry.availableBytes;
  const drawn: UsageSegment[] = segments.length ? segments : [{ bytes: used, label: 'Used', tone: 'accent' }];
  const track = <div aria-label={`${formatBytes(used)} of ${formatBytes(total)} used`} className="mos-usage-track" role="img">
    {drawn.map((segment) => <span className={`mos-usage-segment is-${segment.tone}`} key={segment.label} style={{ width: share(segment.bytes, total) }} />)}
  </div>;
  if (variant === 'compact') return <div className="mos-usage mos-usage-compact">{track}</div>;
  return <div className="mos-usage">
    <p className="suite-meta suite-storage-used"><strong>{entry.kind === 'system' ? `${formatBytes(entry.availableBytes)} free for apps and their data` : `${formatBytes(used)} of ${formatBytes(total)} used`}</strong>{entry.kind === 'system' ? null : <span>{formatBytes(entry.availableBytes)} free</span>}</p>
    {track}
    <ul className="mos-usage-legend">
      {drawn.map((segment) => <li key={segment.label}><span className={`mos-usage-swatch is-${segment.tone}`} />{segment.label} · {formatBytes(segment.bytes)}</li>)}
      <li><span className="mos-usage-swatch" />{entry.kind === 'system' ? 'Free for apps' : 'Free'} · {formatBytes(entry.availableBytes)}</li>
    </ul>
  </div>;
}

// Storage billed by use has no capacity to draw, so it says what MOS knows instead.
export function CloudUsage({ entry }: { entry: StorageEntry }) {
  const stored = entry.backups?.storedBytes;
  return <div className="mos-usage">
    <p className="suite-meta suite-storage-used"><strong>{stored ? `About ${formatBytes(stored)} stored` : 'Nothing stored yet'}</strong><span>No size limit — billed by your provider</span></p>
  </div>;
}
