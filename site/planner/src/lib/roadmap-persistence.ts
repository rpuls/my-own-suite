import {
  cloneRoadmap,
  initialRoadmap,
  validateRoadmap,
  type RoadmapDocument,
} from './roadmap-model';

const STORAGE_KEY = 'mos-digital-independence-plan:v1';

export function loadLocalRoadmap(): RoadmapDocument {
  if (typeof window === 'undefined') return cloneRoadmap(initialRoadmap);
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return cloneRoadmap(initialRoadmap);
    const result = validateRoadmap(JSON.parse(saved));
    return result.ok ? result.value : cloneRoadmap(initialRoadmap);
  } catch {
    return cloneRoadmap(initialRoadmap);
  }
}

export function saveLocalRoadmap(doc: RoadmapDocument) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the
    // editor keeps working, the plan just is not remembered between visits.
  }
}

export function roadmapJson(doc: RoadmapDocument) {
  return JSON.stringify(doc, null, 2);
}
