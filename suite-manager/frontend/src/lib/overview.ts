import { useEffect, useState } from 'react';

// What MOS noticed by itself, as GET /overview reports it: each tile's numbers
// and the problems that belong to it. A tile is null when its source could not answer.

export type AttentionIssue = {
  app?: string;
  assistant?: string;
  check: string;
  detail: string;
  id: string;
  since: string;
  text: string;
  tile: OverviewTile;
};

export type OverviewTile = 'ai' | 'apps' | 'backups' | 'storage' | 'updates';

export type Overview = {
  ai: { connected: number; issues: AttentionIssue[]; lastUsed: { at: string; by: string } | null };
  apps: { issues: AttentionIssue[]; running: number; total: number };
  backups: { issues: AttentionIssue[]; lastAt: string | null; nextAt: string | null; timeZone: string | null } | null;
  storage: { issues: AttentionIssue[]; places: number; systemFreeBytes: number | null } | null;
  updates: { available: string | null; checkedAt: string | null; issues: AttentionIssue[] } | null;
};

export async function readOverview(): Promise<Overview> {
  const response = await fetch('/suite-manager/api/overview');
  if (!response.ok) throw new Error('MOS could not say how the suite is doing.');
  return await response.json() as Overview;
}

export function useOverview() {
  const [overview, setOverview] = useState<Overview | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readOverview().then((answer) => { if (!cancelled) setOverview(answer); }, () => undefined);
    return () => { cancelled = true; };
  }, []);
  return overview;
}

export function issuesOf(overview: Overview | null) {
  if (!overview) return [];
  return [overview.apps, overview.ai, overview.updates, overview.backups, overview.storage].flatMap((tile) => tile?.issues ?? []);
}
