import { CATEGORY_ICONS, type CategoryIconId } from './category-icons';

export const SCHEMA_VERSION = 1 as const;

export type Category = 'independent' | 'proprietary';
export type DatePrecision = 'year' | 'quarter' | 'date';
export type WidthMode = 'fit' | 'auto' | 'manual';

export interface IconRef {
  id: string;
  name: string;
  source: 'library' | 'dashboard' | 'upload';
  dataUrl?: string;
  attribution?: string;
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
  date: string;
  datePrecision: DatePrecision;
  timeLabel: string;
  useFlexibleDate?: boolean;
  displayPrecision?: DatePrecision;
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
    dateDisplay: 'quarter' | 'date';
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
    minNodeGap: number;
    preferredNodeGap: number;
    nodeHeight: number;
    minNodeWidth: number;
    iconSize: number;
    laneSeparation: number;
    curveTension: number;
    showSafeArea: boolean;
    simulateSquareCrop: boolean;
  };
  branding: {
    myOwnSuite: boolean;
    siteLabel: string;
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
// embedded artwork). Ids listed here must stay in the STARTER_ICON_IDS guard
// in scripts/prepare-assets.mjs.
const icon = (id: string, name: string): IconRef => ({
  id,
  name,
  source: 'dashboard',
});

export const initialRoadmap: RoadmapDocument = {
  schemaVersion: SCHEMA_VERSION,
  metadata: {
    title: 'My digital independence journey',
    subtitle:
      'A little less Big Tech, a little more open source — one switch at a time.',
    showTitle: true,
    showSubtitle: true,
    showCategories: true,
    categoryDisplay: 'text',
  },
  labels: {
    usingNow: 'USING NOW',
    replacedPlanned: 'REPLACED / PLANNED',
    timeline: 'TIMELINE',
    independent: 'OPEN SOURCE',
    proprietary: 'BIG TECH',
  },
  timeline: {
    viewDate: todayIsoDate(),
    dateDisplay: 'quarter',
    fullDateFormat: 'dmy',
  },
  migrations: [
    {
      id: 'home',
      categoryLabel: 'Smart home',
      categoryIcon: 'home',
      date: '2020-01-01',
      datePrecision: 'date',
      timeLabel: 'Jan 1, 2020',
      useFlexibleDate: true,
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
      timeLabel: 'Jan 1, 2025',
      useFlexibleDate: true,
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
      timeLabel: 'Apr 1, 2026',
      useFlexibleDate: true,
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
      timeLabel: 'Apr 1, 2026',
      useFlexibleDate: true,
      displayPrecision: 'quarter',
      source: {
        label: 'Apple Calendar +\nGoogle Calendar',
        category: 'proprietary',
        icons: [
          // The dark-canvas variant of the monochrome Apple glyph; flipping
          // the canvas scheme swaps variant pairs like this automatically.
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
      timeLabel: 'Jul 1, 2026',
      useFlexibleDate: true,
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
      timeLabel: 'Jul 1, 2026',
      useFlexibleDate: true,
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
      timeLabel: 'Sep 15, 2026',
      useFlexibleDate: true,
      displayPrecision: 'date',
      source: {
        label: 'Google Password\nManager',
        category: 'proprietary',
        icons: [icon('google', 'Google Password Manager')],
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
      timeLabel: 'Oct 1, 2026',
      useFlexibleDate: true,
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
  layout: {
    widthMode: 'fit',
    width: 2000,
    height: 900,
    outerMargin: 72,
    minNodeGap: 34,
    preferredNodeGap: 78,
    nodeHeight: 76,
    minNodeWidth: 78,
    iconSize: 52,
    laneSeparation: 220,
    curveTension: 0.72,
    showSafeArea: false,
    simulateSquareCrop: false,
  },
  branding: {
    myOwnSuite: true,
    siteLabel: 'myownsuite.org/plan',
  },
  export: { filename: 'digital-independence-roadmap' },
};

export const presets = {
  blogLandscape: {
    label: 'Blog landscape',
    apply(doc: RoadmapDocument): RoadmapDocument {
      return {
        ...doc,
        metadata: { ...doc.metadata, showTitle: true, showSubtitle: true },
        layout: {
          ...doc.layout,
          widthMode: 'fit',
          width: 2000,
          height: 900,
          showSafeArea: false,
          simulateSquareCrop: false,
        },
      };
    },
  },
  squareSocial: {
    label: 'Square social',
    apply(doc: RoadmapDocument): RoadmapDocument {
      return {
        ...doc,
        metadata: { ...doc.metadata, showTitle: true, showSubtitle: true },
        layout: {
          ...doc.layout,
          widthMode: 'fit',
          width: 2000,
          height: 2000,
          showSafeArea: true,
          simulateSquareCrop: false,
        },
        branding: { ...doc.branding, myOwnSuite: true },
      };
    },
  },
};

export function cloneRoadmap(value: RoadmapDocument): RoadmapDocument {
  return JSON.parse(JSON.stringify(value)) as RoadmapDocument;
}

export function migrationIsReached(migration: Migration, viewDate: string) {
  if (!migration.date || !viewDate) return false;
  if (!migration.useFlexibleDate || migration.datePrecision === 'date')
    return migration.date <= viewDate;
  return periodEndDate(migration.date, migration.datePrecision) < viewDate;
}

export function laneEntries(migration: Migration, viewDate: string) {
  const complete = migrationIsReached(migration, viewDate);
  return complete
    ? { top: migration.replacement, bottom: migration.source }
    : { top: migration.source, bottom: migration.replacement };
}

export function chronologicalMigrations(migrations: Migration[]) {
  return migrations
    .map((migration, index) => ({ migration, index }))
    .sort((a, b) => {
      const aDate = migrationPositionDate(a.migration);
      const bDate = migrationPositionDate(b.migration);
      if (!aDate && !bDate) return a.index - b.index;
      if (!aDate) return 1;
      if (!bDate) return -1;
      return aDate.localeCompare(bDate) || a.index - b.index;
    })
    .map(({ migration }) => migration);
}

// Which of the two schemes a canvas background is closest to, so icon
// variants can follow even a custom background color.
export function canvasSchemeFor(background: string): 'light' | 'dark' {
  const hex = background.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return 'light';
  const value = Number.parseInt(hex, 16);
  const luminance =
    0.299 * (value >> 16) + 0.587 * ((value >> 8) & 0xff) + 0.114 * (value & 0xff);
  return luminance < 128 ? 'dark' : 'light';
}

export function todayIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function formatNodeDate(date: string, precision: DatePrecision) {
  if (!date) return 'Set date';
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

export function migrationDisplayPrecision(migration: Migration) {
  return migration.useFlexibleDate
    ? migration.displayPrecision || migration.datePrecision
    : undefined;
}

export function migrationDisplayLabel(
  migration: Migration,
  fallback: 'quarter' | 'date',
  fullDateFormat: 'dmy' | 'mdy' = 'dmy',
) {
  const precision = migrationDisplayPrecision(migration) || fallback;
  if (precision === 'date' && migration.datePrecision !== 'date')
    return 'Set exact date';
  if (precision === 'date')
    return formatFullDate(migration.date, fullDateFormat);
  return formatNodeDate(migration.date, precision);
}

export function formatFullDate(date: string, order: 'dmy' | 'mdy') {
  if (!date) return 'Set date';
  const [year, month, day] = date.split('-');
  return order === 'dmy'
    ? `${day}/${month}/${year}`
    : `${month}/${day}/${year}`;
}

export function migrationPeriodKey(migration: Migration) {
  const precision = migrationDisplayPrecision(migration) || 'date';
  if (!migration.date) return `unset:${migration.id}`;
  if (precision === 'year') return `year:${migration.date.slice(0, 4)}`;
  if (precision === 'quarter')
    return `quarter:${formatNodeDate(migration.date, 'quarter')}`;
  return `date:${migration.date}`;
}

function migrationPositionDate(migration: Migration) {
  const precision = migrationDisplayPrecision(migration);
  if (!migration.date || !precision || precision === 'date')
    return migration.date;
  if (precision === 'year') return `${migration.date.slice(0, 4)}-01-01`;
  const year = Number(migration.date.slice(0, 4));
  const month = Number(migration.date.slice(5, 7));
  return quarterStartDate(
    year,
    (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4,
  );
}

function periodEndDate(date: string, precision: DatePrecision) {
  const year = Number(date.slice(0, 4));
  if (precision === 'year') return `${year}-12-31`;
  if (precision === 'quarter') {
    const month = Number(date.slice(5, 7));
    const quarter = Math.floor((month - 1) / 3) + 1;
    const endMonth = quarter * 3;
    const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    return `${year}-${String(endMonth).padStart(2, '0')}-${lastDay}`;
  }
  return date;
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
    timeLabel: 'Set date',
    useFlexibleDate: true,
    displayPrecision: 'quarter',
    source: { label: '', category: 'proprietary', icons: [] },
    replacement: { label: '', category: 'independent', icons: [] },
  };
}

export function validateRoadmap(
  input: unknown,
): { ok: true; value: RoadmapDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object')
    return {
      ok: false,
      errors: ['The file does not contain a roadmap object.'],
    };
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== SCHEMA_VERSION)
    errors.push(
      `Unsupported schema version “${String(raw.schemaVersion)}”. This app supports version ${SCHEMA_VERSION}.`,
    );
  if (!raw.metadata || typeof raw.metadata !== 'object')
    errors.push('Roadmap metadata is missing.');
  if (!Array.isArray(raw.migrations))
    errors.push('The migrations list is missing.');
  else
    raw.migrations.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`Migration ${index + 1} is not an object.`);
        return;
      }
      const row = item as Record<string, unknown>;
      if (typeof row.id !== 'string' || !row.id)
        errors.push(`Migration ${index + 1} needs a stable id.`);
      for (const side of ['source', 'replacement'] as const) {
        const service = row[side] as Record<string, unknown> | undefined;
        if (!service || typeof service.label !== 'string')
          errors.push(`Migration ${index + 1} needs a ${side} label.`);
        if (
          service &&
          !['independent', 'proprietary'].includes(String(service.category))
        )
          errors.push(
            `Migration ${index + 1} has an invalid ${side} category.`,
          );
        if (service && !Array.isArray(service.icons))
          errors.push(
            `Migration ${index + 1} has an invalid ${side} icon list.`,
          );
      }
    });
  if (errors.length) return { ok: false, errors };
  // Start with current defaults so unknown future fields are ignored without
  // making older files lose newly introduced optional settings.
  const value = raw as unknown as RoadmapDocument;
  const normalized = {
    ...cloneRoadmap(initialRoadmap),
    ...value,
    metadata: { ...initialRoadmap.metadata, ...value.metadata },
    labels: { ...initialRoadmap.labels, ...value.labels },
    timeline: { ...initialRoadmap.timeline, ...value.timeline },
    theme: { ...initialRoadmap.theme, ...value.theme },
    layout: { ...initialRoadmap.layout, ...value.layout },
    branding: { ...initialRoadmap.branding, ...value.branding },
    export: { ...initialRoadmap.export, ...value.export },
  };
  normalized.metadata.showCategories =
    typeof value.metadata.showCategories === 'boolean'
      ? value.metadata.showCategories
      : initialRoadmap.metadata.showCategories;
  normalized.metadata.categoryDisplay = ['text', 'icon', 'both'].includes(
    value.metadata.categoryDisplay,
  )
    ? value.metadata.categoryDisplay
    : initialRoadmap.metadata.categoryDisplay;
  normalized.timeline.dateDisplay = ['quarter', 'date'].includes(
    value.timeline?.dateDisplay,
  )
    ? value.timeline!.dateDisplay
    : initialRoadmap.timeline.dateDisplay;
  normalized.timeline.fullDateFormat = ['dmy', 'mdy'].includes(
    value.timeline?.fullDateFormat,
  )
    ? value.timeline!.fullDateFormat
    : initialRoadmap.timeline.fullDateFormat;
  delete (
    normalized.theme as RoadmapDocument['theme'] & {
      emphasized?: unknown;
    }
  ).emphasized;
  // Legacy field from the original studio build; the planner ships MOS
  // branding only.
  delete (
    normalized.branding as RoadmapDocument['branding'] & {
      funkyton?: unknown;
    }
  ).funkyton;
  normalized.migrations = normalized.migrations.map((migration) => {
    const result: Migration = {
      ...migration,
      categoryLabel:
        typeof migration.categoryLabel === 'string'
          ? migration.categoryLabel
          : inferredCategory(migration),
      categoryIcon: CATEGORY_ICONS.some(
        (option) => option.id === migration.categoryIcon,
      )
        ? migration.categoryIcon
        : inferredCategoryIcon(migration),
      ...normalizedMigrationDate(migration, normalized.timeline.viewDate),
      source: { ...migration.source, category: 'proprietary' as const },
      replacement: {
        ...migration.replacement,
        category: 'independent' as const,
      },
    };
    result.useFlexibleDate = true;
    result.displayPrecision = ['year', 'quarter', 'date'].includes(
      String(migration.displayPrecision),
    )
      ? migration.displayPrecision
      : normalized.timeline.dateDisplay;
    delete (result as Migration & { emphasized?: unknown }).emphasized;
    return result;
  });
  return { ok: true, value: normalized };
}

function inferredCategory(migration: Migration) {
  const known: Record<string, string> = {
    home: 'Smart home',
    photos: 'Photos',
    network: 'Router',
    calendar: 'Calendar',
    files: 'Files',
    office: 'Office',
    passwords: 'Passwords',
    browser: 'Browser',
  };
  return known[migration.id] || '';
}

function inferredCategoryIcon(migration: Migration): CategoryIconId {
  const known: Record<string, CategoryIconId> = {
    home: 'home',
    photos: 'image',
    network: 'router',
    calendar: 'calendar',
    files: 'folder',
    office: 'office',
    passwords: 'key',
    browser: 'globe',
  };
  return known[migration.id] || 'tag';
}

function normalizedMigrationDate(migration: Migration, viewDate: string) {
  if (migration.date) {
    const precision =
      migration.useFlexibleDate &&
      ['year', 'quarter', 'date'].includes(migration.datePrecision)
        ? migration.datePrecision
        : ('date' as const);
    return {
      date: migration.date,
      datePrecision: precision,
      timeLabel: formatNodeDate(migration.date, precision),
    };
  }
  const legacy = parseLegacyDate(migration.timeLabel);
  const legacyStatus = (migration as unknown as { status?: string }).status;
  if (
    legacy.date &&
    legacy.date <= viewDate &&
    (legacyStatus === 'planned' || legacyStatus === 'current')
  ) {
    const nextDay = new Date(`${viewDate}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    legacy.date = nextDay.toISOString().slice(0, 10);
  }
  return {
    date: legacy.date,
    datePrecision: 'date' as const,
    timeLabel: legacy.date ? formatNodeDate(legacy.date, 'date') : 'Set date',
  };
}

function parseLegacyDate(label: string): {
  date: string;
  datePrecision: DatePrecision;
} {
  const quarter = label?.match(/^(\d{4})\s*Q([1-4])$/i);
  if (quarter)
    return {
      date: `${quarter[1]}-${String((Number(quarter[2]) - 1) * 3 + 1).padStart(2, '0')}-01`,
      datePrecision: 'quarter',
    };
  const year = label?.match(/^(\d{4})$/);
  if (year) return { date: `${year[1]}-01-01`, datePrecision: 'year' };
  const parsed = Date.parse(label);
  if (Number.isFinite(parsed))
    return {
      date: new Date(parsed).toISOString().slice(0, 10),
      datePrecision: 'date',
    };
  return { date: '', datePrecision: 'date' };
}
