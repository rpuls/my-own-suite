import { createDashboardIcon } from './dashboard-icon-library';
import { MOS_ICON_PREFIX, createMosAppIcon, mosApps } from './mos-catalog';
import { cloneRoadmap, type IconRef, type RoadmapDocument } from './roadmap-model';

// Dashboard and MOS catalog icons travel by id (in the starter roadmap and in
// share links) and get their artwork embedded from the first-party staged
// sets. An id that no longer resolves — say a denylisted logo — simply keeps
// rendering as the canvas fallback glyph plus its text label.
//
// Resolution and application are split so the caller can fetch artwork
// asynchronously and still apply it to whatever the latest document is,
// without clobbering edits made while the fetch was in flight.
export async function resolveMissingIconArtwork(
  doc: RoadmapDocument,
  attempted: Set<string>,
): Promise<Map<string, string> | null> {
  const pending = new Map<string, IconRef>();
  forEachIcon(doc, (icon) => {
    if (icon.source !== 'dashboard' || icon.dataUrl || attempted.has(icon.id))
      return;
    pending.set(icon.id, icon);
  });
  if (!pending.size) return null;

  const resolved = new Map<string, string>();
  await Promise.all(
    [...pending.values()].map(async (icon) => {
      try {
        const created = icon.id.startsWith(MOS_ICON_PREFIX)
          ? await createMosAppIcon(
              requireMosApp(icon.id.slice(MOS_ICON_PREFIX.length)),
            )
          : await createDashboardIcon(icon);
        if (created.dataUrl) resolved.set(icon.id, created.dataUrl);
      } catch {
        // Only failures are remembered, so an unresolvable id is not retried
        // forever while an id that returns (e.g. after a canvas scheme flip
        // swaps a variant pair back) hydrates again. The canvas falls back
        // gracefully in the meantime.
        attempted.add(icon.id);
      }
    }),
  );
  return resolved.size ? resolved : null;
}

export function applyIconArtwork(
  doc: RoadmapDocument,
  artwork: Map<string, string>,
): RoadmapDocument | null {
  let changed = false;
  const next = cloneRoadmap(doc);
  forEachIcon(next, (icon) => {
    const dataUrl = artwork.get(icon.id);
    if (icon.source === 'dashboard' && !icon.dataUrl && dataUrl) {
      icon.dataUrl = dataUrl;
      changed = true;
    }
  });
  return changed ? next : null;
}

function requireMosApp(id: string) {
  const app = mosApps.find((entry) => entry.id === id);
  if (!app) throw new Error(`Unknown MOS catalog app: ${id}`);
  return app;
}

function forEachIcon(doc: RoadmapDocument, visit: (icon: IconRef) => void) {
  for (const migration of doc.migrations) {
    for (const side of [migration.source, migration.replacement]) {
      for (const icon of side.icons) visit(icon);
    }
  }
}
