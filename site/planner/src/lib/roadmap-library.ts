import {
  ROADMAP_TEMPLATES,
  cloneRoadmap,
  templateById,
  uniqueId,
  validateRoadmap,
  type RoadmapDocument,
} from './roadmap-model';

// A visitor keeps several roadmaps side by side — the whole journey in one, a
// single year or a single theme in another — and switches between them from
// the topbar. Everything still lives in this browser only: the library is one
// localStorage entry holding every plan, and nothing is ever uploaded.
export interface RoadmapProject {
  id: string;
  name: string;
  doc: RoadmapDocument;
  updatedAt: number;
  /** Set on the built-in example, naming the template it came from. An example
   *  holds nobody's work — the first edit forks it — so it is rebuilt from
   *  that template on every load and always shows the current one. */
  example?: string;
}

export interface RoadmapLibrary {
  activeId: string;
  projects: RoadmapProject[];
}

const STORAGE_KEY = 'mos-digital-independence-plan:library:v1';
export const MAX_PROJECTS = 24;
export const MAX_PROJECT_NAME = 48;

export function createProject(
  name: string,
  doc: RoadmapDocument,
  example?: string,
) {
  return {
    id: uniqueId('plan'),
    name: cleanName(name),
    doc: cloneRoadmap(doc),
    updatedAt: Date.now(),
    ...(example ? { example } : {}),
  } satisfies RoadmapProject;
}

export function cleanName(name: string) {
  return name.trim().slice(0, MAX_PROJECT_NAME) || 'Untitled roadmap';
}

/** The library a browser with no saved plans starts from. */
export function seedLibrary(): RoadmapLibrary {
  const starter = ROADMAP_TEMPLATES[0];
  const example = createProject(starter.name, starter.build(), starter.id);
  return { activeId: example.id, projects: [example] };
}

export function loadLibrary(): RoadmapLibrary {
  if (typeof window === 'undefined') return seedLibrary();
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return seedLibrary();
    return ensureExample(parseLibrary(JSON.parse(saved)) ?? seedLibrary());
  } catch {
    return seedLibrary();
  }
}

/** The shipped example is always in the library, first in the list: it is what
 *  people start from and go back to, so a library missing one — deleted, or
 *  written before examples were kept apart — gets it back. */
export function ensureExample(library: RoadmapLibrary): RoadmapLibrary {
  const template = ROADMAP_TEMPLATES[0];
  if (library.projects.some((project) => project.example === template.id))
    return library;
  const example = createProject(
    uniqueProjectName(library, template.name),
    template.build(),
    template.id,
  );
  return { ...library, projects: [example, ...library.projects] };
}

/** False when the browser refused the write — storage blocked, or full — so
 *  the editor can say so instead of claiming the plans are safe. */
export function saveLibrary(library: RoadmapLibrary) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
    return true;
  } catch {
    return false;
  }
}

export function roadmapJson(doc: RoadmapDocument) {
  return JSON.stringify(doc, null, 2);
}

export function activeProject(library: RoadmapLibrary) {
  return (
    library.projects.find((project) => project.id === library.activeId) ??
    library.projects[0]
  );
}

/** The library with the active plan's document replaced. Only an edit is
 *  stamped as one; opening a plan or embedding its artwork is not. */
export function withActiveDoc(
  library: RoadmapLibrary,
  doc: RoadmapDocument,
  edited = true,
): RoadmapLibrary {
  const activeId = activeProject(library)?.id ?? library.activeId;
  return {
    ...library,
    activeId,
    projects: library.projects.map((project) =>
      project.id === activeId
        ? { ...project, doc, ...(edited ? { updatedAt: Date.now() } : {}) }
        : project,
    ),
  };
}

export function libraryIsFull(library: RoadmapLibrary) {
  return library.projects.length >= MAX_PROJECTS;
}

/** Adding to a full library is refused rather than quietly dropping the
 *  oldest roadmap; the caller says so. */
export function addProject(
  library: RoadmapLibrary,
  project: RoadmapProject,
): RoadmapLibrary {
  if (libraryIsFull(library)) return library;
  return {
    activeId: project.id,
    projects: [...library.projects, project],
  };
}

export function removeProject(
  library: RoadmapLibrary,
  id: string,
): RoadmapLibrary {
  const index = library.projects.findIndex((project) => project.id === id);
  const projects = library.projects.filter((project) => project.id !== id);
  if (!projects.length) return seedLibrary();
  const fallback = projects[Math.min(index, projects.length - 1)];
  return {
    activeId: library.activeId === id ? fallback.id : library.activeId,
    projects,
  };
}

// Naming a roadmap is claiming it: a renamed example becomes an ordinary
// roadmap, kept as it is and no longer rebuilt from its template.
export function renameProject(
  library: RoadmapLibrary,
  id: string,
  name: string,
): RoadmapLibrary {
  return {
    ...library,
    projects: library.projects.map((project) =>
      project.id === id
        ? { ...project, name: cleanName(name), example: undefined }
        : project,
    ),
  };
}

/** The copy an edit to the example lands in, leaving the example untouched. */
export function forkExample(
  library: RoadmapLibrary,
  doc: RoadmapDocument,
  name = 'My roadmap',
) {
  const copy = createProject(uniqueProjectName(library, name), doc);
  return { library: addProject(library, copy), project: copy };
}

/** “My roadmap”, “My roadmap 2”, … */
export function uniqueProjectName(library: RoadmapLibrary, base: string) {
  const taken = new Set(library.projects.map((project) => project.name));
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix++)
    if (!taken.has(`${base} ${suffix}`)) return `${base} ${suffix}`;
  return base;
}

function parseLibrary(input: unknown): RoadmapLibrary | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<RoadmapLibrary>;
  if (!Array.isArray(raw.projects)) return null;
  const projects: RoadmapProject[] = [];
  for (const entry of raw.projects) {
    if (!entry || typeof entry !== 'object') continue;
    // An example is reloaded from the shipped template rather than from
    // storage, so improvements to it reach people who already have a library.
    const template = entry.example ? templateById(String(entry.example)) : null;
    const result = validateRoadmap((entry as RoadmapProject).doc);
    if (!template && !result.ok) continue;
    projects.push({
      id:
        typeof entry.id === 'string' && entry.id ? entry.id : uniqueId('plan'),
      name: cleanName(String(template ? template.name : (entry.name ?? ''))),
      doc: template
        ? template.build()
        : (result as { value: RoadmapDocument }).value,
      updatedAt: Number(entry.updatedAt) || Date.now(),
      ...(template ? { example: template.id } : {}),
    });
  }
  if (!projects.length) return null;
  const activeId = projects.some((project) => project.id === raw.activeId)
    ? (raw.activeId as string)
    : projects[0].id;
  return { activeId, projects };
}
