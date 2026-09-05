import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from 'lz-string';
import {
  cloneRoadmap,
  validateRoadmap,
  type RoadmapDocument,
} from './roadmap-model';

// Share links carry the whole plan in the URL fragment, so a shared plan opens
// live in the editor for anyone to remix — with no backend, and since the
// fragment never leaves the browser, no server ever sees the plan either.
const FRAGMENT_PREFIX = '#plan=';

// Dashboard and MOS catalog artwork re-hydrates from its id on open, so links
// stay short enough to paste anywhere. Only uploaded icons must carry their
// own artwork — theirs exists nowhere else.
export function stripRehydratableArtwork(doc: RoadmapDocument): RoadmapDocument {
  const next = cloneRoadmap(doc);
  for (const migration of next.migrations) {
    for (const side of [migration.source, migration.replacement]) {
      for (const icon of side.icons) {
        if (icon.source === 'dashboard') delete icon.dataUrl;
      }
    }
  }
  return next;
}

export function encodeShareFragment(doc: RoadmapDocument): string {
  const payload = JSON.stringify(stripRehydratableArtwork(doc));
  return `${FRAGMENT_PREFIX}${compressToEncodedURIComponent(payload)}`;
}

export function decodeShareFragment(hash: string): RoadmapDocument | null {
  if (!hash.startsWith(FRAGMENT_PREFIX)) return null;
  try {
    const json = decompressFromEncodedURIComponent(
      hash.slice(FRAGMENT_PREFIX.length),
    );
    if (!json) return null;
    const result = validateRoadmap(JSON.parse(json));
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

export function shareUrlFor(doc: RoadmapDocument): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${encodeShareFragment(doc)}`;
}

export function takePendingSharedRoadmap(): RoadmapDocument | null {
  if (typeof window === 'undefined') return null;
  const doc = decodeShareFragment(window.location.hash);
  if (doc) {
    // Drop the fragment so a refresh returns to the visitor's own plan
    // instead of re-importing the shared one.
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  }
  return doc;
}
