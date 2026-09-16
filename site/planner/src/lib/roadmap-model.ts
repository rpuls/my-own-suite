import { CATEGORY_ICONS, type CategoryIconId } from './category-icons';

export const SCHEMA_VERSION = 1 as const;

export type Category = 'independent' | 'proprietary';
export type DatePrecision = 'year' | 'quarter' | 'date';
export type Side = 'source' | 'replacement';
// Two honest choices: let the canvas hug its content, or pin it to an exact
// width and let the nodes spread to fill it.
export type WidthMode = 'auto' | 'fixed';

const DATE_PRECISIONS: DatePrecision[] = ['year', 'quarter', 'date'];
const WIDTH_MODES: WidthMode[] = ['auto', 'fixed'];
const ICON_SOURCES: IconRef['source'][] = ['library', 'dashboard', 'upload'];

// What each side of a switch is called wherever the editor names it.
export const SIDE_NAMES: Record<Side, string> = {
  source: 'Big Tech',
  replacement: 'Open Source',
};

// The settable range of every layout number. The inspector's controls and the
// validator share these, so a crafted file cannot ask for what a slider cannot.
export const LAYOUT_RANGES = {
  width: { min: 760, max: 8000 },
  height: { min: 640, max: 5000 },
  outerMargin: { min: 24, max: 300 },
  nodeSpacing: { min: 8, max: 400 },
  textScale: { min: 0.8, max: 2.4 },
  minNodeWidth: { min: 54, max: 280 },
  iconSize: { min: 24, max: 110 },
  laneSeparation: { min: 150, max: 650 },
  curveTension: { min: 0.35, max: 1.4 },
} as const;

// Hard caps on what a document may hold, so a file or a link can never ask
// the browser for a canvas or a storage entry it cannot produce.
export const LIMITS = {
  migrations: 60,
  iconsPerSide: 6,
  text: 200,
  filename: 80,
  // A 1.5 MB upload is ~2 MB once base64-encoded.
  dataUrl: 2_100_000,
} as const;

export interface IconRef {
  id: string;
  name: string;
  source: 'library' | 'dashboard' | 'upload';
  dataUrl?: string;
}

export interface ServiceEntry {
  label: string;
  category: Category;
  icons: IconRef[];
}

export interface Migration {
  id: string;
  categoryLabel: string;
  categoryIcon: CategoryIconId;
  source: ServiceEntry;
  replacement: ServiceEntry;
  /** ISO date, or empty while the switch has no date yet. */
  date: string;
  /** How precisely the date is known: the day, or only the quarter or year
   *  it falls in. */
  datePrecision: DatePrecision;
  /** How the date is printed on the graphic; never finer than it is known. */
  displayPrecision: DatePrecision;
}

export interface RoadmapDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  metadata: {
    title: string;
    subtitle: string;
    showTitle: boolean;
    showSubtitle: boolean;
    showCategories: boolean;
    categoryDisplay: 'text' | 'icon' | 'both';
  };
  labels: {
    usingNow: string;
    replacedPlanned: string;
    timeline: string;
    independent: string;
    proprietary: string;
  };
  timeline: {
    viewDate: string;
    fullDateFormat: 'dmy' | 'mdy';
  };
  migrations: Migration[];
  theme: {
    background: string;
    text: string;
    secondaryText: string;
    independent: string;
    proprietary: string;
    timeline: string;
    transparent: boolean;
  };
  layout: {
    widthMode: WidthMode;
    width: number;
    height: number;
    outerMargin: number;
    // The horizontal distance between two neighbouring columns, measured
    // between what is actually drawn — plate edge to plate edge, or label edge
    // to label edge when a label is the wider part of the column.
    nodeSpacing: number;
    // Multiplies every piece of type on the canvas, so a roadmap stays
    // readable when a blog shrinks it into a narrow column.
    textScale: number;
    minNodeWidth: number;
    iconSize: number;
    laneSeparation: number;
    curveTension: number;
    showSafeArea: boolean;
    simulateSquareCrop: boolean;
  };
  export: {
    filename: string;
  };
}

export type CanvasTheme = Omit<RoadmapDocument['theme'], 'transparent'>;

// The two canvas palettes every graphic can flip between. Dark (the default)
// is the MOS brand: values mirror the dark tokens in branding/styles/mos.css —
// navy bg, frost text, mint accent for the open-source lane, danger coral for
// the Big Tech lane, accent-strong for timeline chrome. Light keeps the
// original blog-style violet/pink identity on paper white.
export const CANVAS_THEMES: Record<'light' | 'dark', CanvasTheme> = {
  light: {
    background: '#ffffff',
    text: '#0d2135',
    secondaryText: '#4a6076',
    independent: '#6258f5',
    proprietary: '#ef6c88',
    timeline: '#1c9e6d',
  },
  dark: {
    background: '#061526',
    text: '#eef4ff',
    secondaryText: '#b8c9de',
    independent: '#63e2b3',
    proprietary: '#ff9d9d',
    timeline: '#28bc84',
  },
};

// Starter icons reference the Dashboard Icons set staged at build time (no
// dataUrl yet — the app embeds them on first load, and exports always carry
// embedded artwork). Every id used here must be listed in starter-icons.json,
// which the build checks against the staged set.
const icon = (id: string, name: string): IconRef => ({
  id,
  name,
  source: 'dashboard',
});

const defaultLabels = (): RoadmapDocument['labels'] => ({
  usingNow: 'USING NOW',
  replacedPlanned: 'REPLACED / PLANNED',
  timeline: 'TIMELINE',
  independent: 'OPEN SOURCE',
  proprietary: 'BIG TECH',
});

const defaultLayout = (): RoadmapDocument['layout'] => ({
  widthMode: 'auto',
  width: 2000,
  height: 900,
  outerMargin: 72,
  nodeSpacing: 60,
  textScale: 1,
  minNodeWidth: 78,
  iconSize: 52,
  laneSeparation: 220,
  curveTension: 0.72,
  showSafeArea: false,
  simulateSquareCrop: false,
});

// The roadmap a first-time visitor lands on: five switches everyone
// recognises, a single crossover in the middle, and the light canvas that
// drops straight into a blog post. Long, personal journeys are a template
// away — they are what the planner grows into, not what it opens with.
export const initialRoadmap: RoadmapDocument = {
  schemaVersion: SCHEMA_VERSION,
  metadata: {
    title: 'My digital independence plan',
    subtitle: 'Five everyday switches from Big Tech to open source.',
    showTitle: true,
    showSubtitle: true,
    showCategories: true,
    categoryDisplay: 'icon',
  },
  labels: defaultLabels(),
  timeline: {
    viewDate: todayIsoDate(),
    fullDateFormat: 'dmy',
  },
  migrations: [
    {
      id: 'files',
      categoryLabel: 'Files',
      categoryIcon: 'folder',
      date: '2026-01-01',
      datePrecision: 'quarter',
      displayPrecision: 'quarter',
      source: {
        label: 'Google Drive',
        category: 'proprietary',
        icons: [icon('google-drive', 'Google Drive')],
      },
      replacement: {
        label: 'Seafile',
        category: 'independent',
        icons: [icon('seafile', 'Seafile')],
      },
    },
    {
      // Documents follow the drive they live in: moving the files and moving
      // the editor that opens them is really one switch, so the example keeps
      // the two side by side.
      id: 'office',
      categoryLabel: 'Office',
      categoryIcon: 'office',
      date: '2026-04-01',
      datePrecision: 'quarter',
      displayPrecision: 'quarter',
      source: {
        label: 'Google Docs,\nSheets, Slides',
        category: 'proprietary',
        icons: [
          icon('google-docs', 'Google Docs'),
          icon('google-sheets', 'Google Sheets'),
          icon('google-slides', 'Google Slides'),
        ],
      },
      replacement: {
        label: 'ONLYOFFICE',
        category: 'independent',
        icons: [icon('onlyoffice', 'ONLYOFFICE')],
      },
    },
    {
      id: 'photos',
      categoryLabel: 'Photos',
      categoryIcon: 'image',
      date: '2026-10-01',
      datePrecision: 'quarter',
      displayPrecision: 'quarter',
      source: {
        label: 'Google Photos',
        category: 'proprietary',
        icons: [icon('google-photos', 'Google Photos')],
      },
      replacement: {
        label: 'Immich',
        category: 'independent',
        icons: [icon('immich', 'Immich')],
      },
    },
    {
      id: 'calendar',
      categoryLabel: 'Calendar',
      categoryIcon: 'calendar',
      date: '2027-01-01',
      datePrecision: 'quarter',
      displayPrecision: 'quarter',
      source: {
        label: 'Google Calendar',
        category: 'proprietary',
        icons: [icon('google-calendar', 'Google Calendar')],
      },
      replacement: {
        label: 'Radicale',
        category: 'independent',
        icons: [icon('radicale', 'Radicale')],
      },
    },
    {
      id: 'passwords',
      categoryLabel: 'Passwords',
      categoryIcon: 'key',
      date: '2027-04-01',
      datePrecision: 'quarter',
      displayPrecision: 'quarter',
      source: {
        label: 'Google Password\nManager',
        category: 'proprietary',
        icons: [icon('google-password-manager', 'Google Password Manager')],
      },
      replacement: {
        label: 'Vaultwarden',
        category: 'independent',
        icons: [icon('vaultwarden', 'Vaultwarden')],
      },
    },
  ],
  theme: { ...CANVAS_THEMES.light, transparent: false },
  layout: defaultLayout(),
  export: { filename: 'digital-independence-roadmap' },
};

// A worked, full-length example: eight switches over seven years, on the MOS
// dark canvas. Offered as a template so the planner can show what a whole
// journey looks like without making that the first thing anyone edits.
export const fullJourneyRoadmap: RoadmapDocument = {
  schemaVersion: SCHEMA_VERSION,
  metadata: {
    title: 'My digital independence journey',
    subtitle:
      'A little less Big Tech, a little more open source — one switch at a time.',
    showTitle: true,
    showSubtitle: true,
    showCategories: true,
    categoryDisplay: 'icon',
  },
  labels: defaultLabels(),
  timeline: {
    viewDate: todayIsoDate(),
    fullDateFormat: 'dmy',
  },
  migrations: [
    {
      id: 'home',
      categoryLabel: 'Smart home',
      categoryIcon: 'home',
      date: '2020-01-01',
      datePrecision: 'date',
      displayPrecision: 'year',
      source: {
        label: 'SmartThings +\nGoogle Home',
        category: 'proprietary',
        icons: [icon('google-home', 'Google Home')],
      },
      replacement: {
        label: 'Home Assistant',
        category: 'independent',
        icons: [icon('home-assistant', 'Home Assistant')],
      },
    },
    {
      id: 'photos',
      categoryLabel: 'Photos',
      categoryIcon: 'image',
      date: '2025-01-01',
      datePrecision: 'date',
      displayPrecision: 'year',
      source: {
        label: 'Google Photos',
        category: 'proprietary',
        icons: [icon('google-photos', 'Google Photos')],
      },
      replacement: {
        label: 'Immich',
        category: 'independent',
        icons: [icon('immich', 'Immich')],
      },
    },
    {
      id: 'network',
      categoryLabel: 'Router',
      categoryIcon: 'router',
      date: '2026-04-01',
      datePrecision: 'date',
      displayPrecision: 'quarter',
      source: {
        label: 'TP-Link',
        category: 'proprietary',
        icons: [icon('tp-link', 'TP-Link')],
      },
      replacement: {
        label: 'OPNsense',
        category: 'independent',
        icons: [icon('opnsense', 'OPNsense')],
      },
    },
    {
      id: 'calendar',
      categoryLabel: 'Calendar',
      categoryIcon: 'calendar',
      date: '2026-04-01',
      datePrecision: 'date',
      displayPrecision: 'quarter',
      source: {
        label: 'Apple Calendar +\nGoogle Calendar',
        category: 'proprietary',
        icons: [
          // The white variant of the monochrome Apple glyph, for the dark
          // canvas; flipping the canvas scheme swaps such pairs automatically.
          icon('apple-light', 'Apple Calendar'),
          icon('google-calendar', 'Google Calendar'),
        ],
      },
      replacement: {
        label: 'Radicale',
        category: 'independent',
        icons: [icon('radicale', 'Radicale')],
      },
    },
    {
      id: 'files',
      categoryLabel: 'Files',
      categoryIcon: 'folder',
      date: '2026-07-01',
      datePrecision: 'date',
      displayPrecision: 'quarter',
      source: {
        label: 'Google Drive',
        category: 'proprietary',
        icons: [icon('google-drive', 'Google Drive')],
      },
      replacement: {
        label: 'Seafile',
        category: 'independent',
        icons: [icon('seafile', 'Seafile')],
      },
    },
    {
      id: 'office',
      categoryLabel: 'Office',
      categoryIcon: 'office',
      date: '2026-07-01',
      datePrecision: 'date',
      displayPrecision: 'quarter',
      source: {
        label: 'Google Docs, Sheets,\nand Slides',
        category: 'proprietary',
        icons: [
          icon('google-docs', 'Google Docs'),
          icon('google-sheets', 'Google Sheets'),
          icon('google-slides', 'Google Slides'),
        ],
      },
      replacement: {
        label: 'ONLYOFFICE',
        category: 'independent',
        icons: [icon('onlyoffice', 'ONLYOFFICE')],
      },
    },
    {
      id: 'passwords',
      categoryLabel: 'Passwords',
      categoryIcon: 'key',
      date: '2026-09-15',
      datePrecision: 'date',
      displayPrecision: 'date',
      source: {
        label: 'Google Password\nManager',
        category: 'proprietary',
        icons: [icon('google-password-manager', 'Google Password Manager')],
      },
      replacement: {
        label: 'Vaultwarden',
        category: 'independent',
        icons: [icon('vaultwarden', 'Vaultwarden')],
      },
    },
    {
      id: 'browser',
      categoryLabel: 'Browser',
      categoryIcon: 'globe',
      date: '2026-10-01',
      datePrecision: 'date',
      displayPrecision: 'quarter',
      source: {
        label: 'Chrome',
        category: 'proprietary',
        icons: [icon('google-chrome', 'Chrome')],
      },
      replacement: {
        label: 'Firefox',
        category: 'independent',
        icons: [icon('firefox', 'Firefox')],
      },
    },
  ],
  theme: { ...CANVAS_THEMES.dark, transparent: false },
  layout: defaultLayout(),
  export: { filename: 'digital-independence-roadmap' },
};

export function blankRoadmap(): RoadmapDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      title: 'My digital independence plan',
      subtitle: 'From Big Tech to open source, one switch at a time.',
      showTitle: true,
      showSubtitle: true,
      showCategories: true,
      categoryDisplay: 'icon',
    },
    labels: defaultLabels(),
    timeline: {
      viewDate: todayIsoDate(),
      fullDateFormat: 'dmy',
    },
    migrations: [],
    theme: { ...CANVAS_THEMES.light, transparent: false },
    layout: defaultLayout(),
    export: { filename: 'digital-independence-roadmap' },
  };
}

export interface RoadmapTemplate {
  id: string;
  name: string;
  description: string;
  build: () => RoadmapDocument;
}

// What the “new roadmap” button offers. The first entry is also what a
// first-time visitor's library is seeded with.
export const ROADMAP_TEMPLATES: RoadmapTemplate[] = [
  {
    id: 'everyday',
    name: 'Example roadmap',
    description: 'Five familiar apps, one crossover — the starting example.',
    build: () => withFreshViewDate(initialRoadmap),
  },
  {
    id: 'journey',
    name: 'Full journey',
    description: 'A longer, worked example on the dark canvas.',
    build: () => withFreshViewDate(fullJourneyRoadmap),
  },
  {
    id: 'blank',
    name: 'Blank roadmap',
    description: 'An empty canvas to build up node by node.',
    build: blankRoadmap,
  },
];

export function templateById(id: string) {
  return ROADMAP_TEMPLATES.find((template) => template.id === id);
}

function withFreshViewDate(doc: RoadmapDocument): RoadmapDocument {
  const copy = cloneRoadmap(doc);
  copy.timeline.viewDate = todayIsoDate();
  return copy;
}

export const presets = {
  blogLandscape: {
    label: 'Blog landscape',
    description: 'Fits the roadmap; drops into a post.',
    apply(doc: RoadmapDocument): RoadmapDocument {
      return {
        ...doc,
        metadata: { ...doc.metadata, showTitle: true, showSubtitle: true },
        layout: {
          ...doc.layout,
          widthMode: 'auto',
          height: 900,
          showSafeArea: false,
          simulateSquareCrop: false,
        },
      };
    },
  },
  squareSocial: {
    label: 'Square social',
    description: '2000 × 2000 with the safe area shown.',
    apply(doc: RoadmapDocument): RoadmapDocument {
      return {
        ...doc,
        metadata: { ...doc.metadata, showTitle: true, showSubtitle: true },
        layout: {
          ...doc.layout,
          widthMode: 'fixed',
          width: 2000,
          height: 2000,
          showSafeArea: true,
          simulateSquareCrop: false,
        },
      };
    },
  },
};

export function cloneRoadmap(value: RoadmapDocument): RoadmapDocument {
  return JSON.parse(JSON.stringify(value)) as RoadmapDocument;
}

// A side's label follows its icons ("Google Docs +\nSheets") until the owner
// types a label of their own, after which the icons stop touching it.
export function appLabel(names: string[]) {
  return names.join(' +\n');
}

/** Adds an icon to a side; false when the side is full. */
export function addIconToEntry(entry: ServiceEntry, icon: IconRef) {
  if (entry.icons.length >= LIMITS.iconsPerSide) return false;
  const names = entry.icons.map((item) => item.name);
  const follows = !entry.label || entry.label === appLabel(names);
  entry.icons.push(icon);
  if (follows) entry.label = appLabel([...names, icon.name]);
  return true;
}

export function removeIconFromEntry(entry: ServiceEntry, index: number) {
  const follows = entry.label === appLabel(entry.icons.map((i) => i.name));
  entry.icons.splice(index, 1);
  if (follows) entry.label = appLabel(entry.icons.map((i) => i.name));
}

/** The first day a switch counts as done: its date when the day is known,
 *  otherwise the day after the quarter or year it is placed in ends. */
export function migrationReachedOn(migration: Migration): string {
  if (!migration.date) return '';
  if (migration.datePrecision === 'date') return migration.date;
  return dayAfter(periodEndDate(migration.date, migration.datePrecision));
}

export function migrationIsReached(migration: Migration, viewDate: string) {
  const reachedOn = migrationReachedOn(migration);
  return Boolean(reachedOn && viewDate) && reachedOn <= viewDate;
}

export function laneEntries(migration: Migration, viewDate: string) {
  const complete = migrationIsReached(migration, viewDate);
  return complete
    ? { top: migration.replacement, bottom: migration.source }
    : { top: migration.source, bottom: migration.replacement };
}

// Left to right in the order the switches happen. Sorting by the day each
// one counts as done means the done ones are always a prefix of the row, so
// the lanes cross exactly once whatever mix of precisions is in play. Nodes
// that become done on the same day keep the order they were put in, which is
// what the “earlier / later” controls adjust; undated nodes go last.
export function chronologicalMigrations(migrations: Migration[]) {
  return migrations
    .map((migration, index) => ({ migration, index }))
    .sort((a, b) => {
      const aOn = migrationReachedOn(a.migration);
      const bOn = migrationReachedOn(b.migration);
      if (!aOn && !bOn) return a.index - b.index;
      if (!aOn) return 1;
      if (!bOn) return -1;
      return aOn.localeCompare(bOn) || a.index - b.index;
    })
    .map(({ migration }) => migration);
}

/** Nodes that share this key are tied in time and can be reordered by hand. */
export function migrationOrderKey(migration: Migration) {
  return migrationReachedOn(migration) || `unset:${migration.id}`;
}

// Which of the two schemes a canvas background is closest to, so icon
// variants can follow even a custom background color.
export function canvasSchemeFor(background: string): 'light' | 'dark' {
  const hex = background.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return 'light';
  const value = Number.parseInt(hex, 16);
  const luminance =
    0.299 * (value >> 16) +
    0.587 * ((value >> 8) & 0xff) +
    0.114 * (value & 0xff);
  return luminance < 128 ? 'dark' : 'light';
}

export function todayIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** A real calendar day written YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function formatNodeDate(date: string, precision: DatePrecision) {
  if (!isIsoDate(date)) return 'Set date';
  const [year, month, day] = date.split('-').map(Number);
  if (precision === 'year') return String(year);
  if (precision === 'quarter')
    return `${year} Q${Math.floor((month - 1) / 3) + 1}`;
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function migrationDisplayLabel(
  migration: Migration,
  fullDateFormat: 'dmy' | 'mdy' = 'dmy',
) {
  const precision = migration.displayPrecision;
  if (precision === 'date' && migration.datePrecision !== 'date')
    return 'Set exact date';
  if (precision === 'date')
    return formatFullDate(migration.date, fullDateFormat);
  return formatNodeDate(migration.date, precision);
}

export function formatFullDate(date: string, order: 'dmy' | 'mdy') {
  if (!isIsoDate(date)) return 'Set date';
  const [year, month, day] = date.split('-');
  return order === 'dmy'
    ? `${day}/${month}/${year}`
    : `${month}/${day}/${year}`;
}

function periodEndDate(date: string, precision: DatePrecision) {
  const year = Number(date.slice(0, 4));
  if (precision === 'year') return `${year}-12-31`;
  if (precision === 'quarter') {
    const month = Number(date.slice(5, 7));
    const endMonth = (Math.floor((month - 1) / 3) + 1) * 3;
    const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    return `${year}-${String(endMonth).padStart(2, '0')}-${lastDay}`;
  }
  return date;
}

function dayAfter(date: string) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function quarterStartDate(year: number, quarter: 1 | 2 | 3 | 4) {
  const month = (quarter - 1) * 3 + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function uniqueId(prefix = 'migration') {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMigration(): Migration {
  return {
    id: uniqueId(),
    categoryLabel: '',
    categoryIcon: 'tag',
    date: '',
    datePrecision: 'date',
    displayPrecision: 'quarter',
    source: { label: '', category: 'proprietary', icons: [] },
    replacement: { label: '', category: 'independent', icons: [] },
  };
}

// Anything that reaches the editor from outside — a JSON file, a share link,
// this browser's own storage — comes through here. The shape is checked, and
// every field is then rebuilt from what was given with defaults, caps and
// ranges applied, so a document that validates can always be laid out, drawn,
// stored and shared without a further check anywhere.
export function validateRoadmap(
  input: unknown,
): { ok: true; value: RoadmapDocument } | { ok: false; errors: string[] } {
  if (!isRecord(input))
    return {
      ok: false,
      errors: ['The file does not contain a roadmap object.'],
    };
  const errors: string[] = [];
  if (input.schemaVersion !== SCHEMA_VERSION)
    errors.push(
      `Unsupported schema version “${String(input.schemaVersion)}”. This app supports version ${SCHEMA_VERSION}.`,
    );
  if (!Array.isArray(input.migrations))
    errors.push('The migrations list is missing.');
  else if (input.migrations.length > LIMITS.migrations)
    errors.push(
      `This roadmap has ${input.migrations.length} nodes; the planner supports up to ${LIMITS.migrations}.`,
    );
  else
    input.migrations.forEach((item, index) => {
      if (
        !isRecord(item) ||
        !isRecord(item.source) ||
        !isRecord(item.replacement)
      )
        errors.push(`Node ${index + 1} is not a roadmap node.`);
    });
  if (errors.length) return { ok: false, errors };

  const base = initialRoadmap;
  const metadata = field(input.metadata);
  const labels = field(input.labels);
  const timeline = field(input.timeline);
  const theme = field(input.theme);
  const layout = field(input.layout);
  const exportSettings = field(input.export);
  const seenIds = new Set<string>();

  const value: RoadmapDocument = {
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      title: text(metadata.title, base.metadata.title),
      subtitle: text(metadata.subtitle, base.metadata.subtitle),
      showTitle: flag(metadata.showTitle, base.metadata.showTitle),
      showSubtitle: flag(metadata.showSubtitle, base.metadata.showSubtitle),
      showCategories: flag(
        metadata.showCategories,
        base.metadata.showCategories,
      ),
      categoryDisplay: oneOf(
        metadata.categoryDisplay,
        ['text', 'icon', 'both'],
        base.metadata.categoryDisplay,
      ),
    },
    labels: {
      usingNow: text(labels.usingNow, base.labels.usingNow),
      replacedPlanned: text(
        labels.replacedPlanned,
        base.labels.replacedPlanned,
      ),
      timeline: text(labels.timeline, base.labels.timeline),
      independent: text(labels.independent, base.labels.independent),
      proprietary: text(labels.proprietary, base.labels.proprietary),
    },
    timeline: {
      viewDate: isIsoDate(timeline.viewDate)
        ? timeline.viewDate
        : todayIsoDate(),
      fullDateFormat: oneOf(
        timeline.fullDateFormat,
        ['dmy', 'mdy'],
        base.timeline.fullDateFormat,
      ),
    },
    migrations: (input.migrations as Record<string, unknown>[]).map((item) => {
      const id =
        typeof item.id === 'string' && item.id && !seenIds.has(item.id)
          ? item.id
          : uniqueId();
      seenIds.add(id);
      const datePrecision = oneOf(item.datePrecision, DATE_PRECISIONS, 'date');
      return {
        id,
        categoryLabel: text(item.categoryLabel, ''),
        categoryIcon: oneOf(
          item.categoryIcon,
          CATEGORY_ICONS.map((option) => option.id),
          'tag',
        ),
        date: isIsoDate(item.date) ? item.date : '',
        datePrecision,
        displayPrecision: oneOf(
          item.displayPrecision,
          DATE_PRECISIONS,
          'quarter',
        ),
        source: service(item.source as Record<string, unknown>, 'proprietary'),
        replacement: service(
          item.replacement as Record<string, unknown>,
          'independent',
        ),
      };
    }),
    theme: {
      background: color(theme.background, base.theme.background),
      text: color(theme.text, base.theme.text),
      secondaryText: color(theme.secondaryText, base.theme.secondaryText),
      independent: color(theme.independent, base.theme.independent),
      proprietary: color(theme.proprietary, base.theme.proprietary),
      timeline: color(theme.timeline, base.theme.timeline),
      transparent: flag(theme.transparent, base.theme.transparent),
    },
    layout: {
      widthMode: oneOf(layout.widthMode, WIDTH_MODES, base.layout.widthMode),
      width: number(layout.width, LAYOUT_RANGES.width, base.layout.width),
      height: number(layout.height, LAYOUT_RANGES.height, base.layout.height),
      outerMargin: number(
        layout.outerMargin,
        LAYOUT_RANGES.outerMargin,
        base.layout.outerMargin,
      ),
      nodeSpacing: number(
        layout.nodeSpacing,
        LAYOUT_RANGES.nodeSpacing,
        base.layout.nodeSpacing,
      ),
      textScale: number(
        layout.textScale,
        LAYOUT_RANGES.textScale,
        base.layout.textScale,
      ),
      minNodeWidth: number(
        layout.minNodeWidth,
        LAYOUT_RANGES.minNodeWidth,
        base.layout.minNodeWidth,
      ),
      iconSize: number(
        layout.iconSize,
        LAYOUT_RANGES.iconSize,
        base.layout.iconSize,
      ),
      laneSeparation: number(
        layout.laneSeparation,
        LAYOUT_RANGES.laneSeparation,
        base.layout.laneSeparation,
      ),
      curveTension: number(
        layout.curveTension,
        LAYOUT_RANGES.curveTension,
        base.layout.curveTension,
      ),
      showSafeArea: flag(layout.showSafeArea, base.layout.showSafeArea),
      simulateSquareCrop: flag(
        layout.simulateSquareCrop,
        base.layout.simulateSquareCrop,
      ),
    },
    export: { filename: safeFilename(exportSettings.filename) },
  };
  return { ok: true, value };
}

export function safeFilename(value: unknown) {
  const cleaned =
    typeof value === 'string'
      ? value
          .replace(/[^a-zA-Z0-9._-]/g, '-')
          .replace(/^[.-]+/, '')
          .slice(0, LIMITS.filename)
      : '';
  return cleaned || 'roadmap';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function field(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(value: unknown, fallback: string) {
  return typeof value === 'string' ? value.slice(0, LIMITS.text) : fallback;
}

function flag(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function number(
  value: unknown,
  range: { min: number; max: number },
  fallback: number,
) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, value))
    : fallback;
}

function color(value: unknown, fallback: string) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

// Artwork is only ever an inline image: a remote address here would make the
// recipient of a link fetch it, which is exactly what the planner promises
// never happens. Anything else is dropped; catalog icons re-embed from their
// id and an upload without artwork draws the fallback glyph.
const INLINE_IMAGE = /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i;

function service(
  value: Record<string, unknown>,
  category: Category,
): ServiceEntry {
  const icons: IconRef[] = [];
  for (const raw of Array.isArray(value.icons) ? value.icons : []) {
    if (icons.length >= LIMITS.iconsPerSide) break;
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) continue;
    const source = oneOf(raw.source, ICON_SOURCES, 'dashboard');
    const icon: IconRef = {
      id: raw.id.slice(0, LIMITS.text),
      name: text(raw.name, raw.id),
      source,
    };
    if (
      typeof raw.dataUrl === 'string' &&
      raw.dataUrl.length <= LIMITS.dataUrl &&
      INLINE_IMAGE.test(raw.dataUrl)
    )
      icon.dataUrl = raw.dataUrl;
    icons.push(icon);
  }
  return { label: text(value.label, ''), category, icons };
}
