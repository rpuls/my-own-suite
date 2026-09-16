import { describe, expect, it } from 'vitest';
import { sanitizeAndScopeSvg } from './icon-library';
import starterIcons from './starter-icons.json';
import { iconIdForScheme } from './dashboard-icon-library';
import {
  brandWidth,
  categoryMarker,
  computeLayout,
  estimateLabelWidth,
  legendWidth,
} from './roadmap-layout';
import type { Migration, RoadmapDocument } from './roadmap-model';
import {
  ROADMAP_TEMPLATES,
  chronologicalMigrations,
  cloneRoadmap,
  createMigration,
  formatFullDate,
  formatNodeDate,
  fullJourneyRoadmap,
  initialRoadmap,
  laneEntries,
  migrationDisplayLabel,
  migrationIsReached,
  quarterStartDate,
  validateRoadmap,
} from './roadmap-model';
import {
  activeProject,
  addProject,
  createProject,
  ensureExample,
  forkExample,
  seedLibrary,
  libraryIsFull,
  removeProject,
  renameProject,
  uniqueProjectName,
  withActiveDoc,
  type RoadmapLibrary,
} from './roadmap-library';

// The long worked example exercises the engine hardest: eight nodes, a
// crossover in the middle, multi-icon and multi-line labels.
const doc = () => {
  const value = cloneRoadmap(fullJourneyRoadmap);
  value.timeline.viewDate = '2026-09-05';
  return value;
};

// Edge-to-edge distance between two neighbouring columns — what the node
// spacing setting promises the reader.
const edgeGaps = (layout: ReturnType<typeof computeLayout>) =>
  layout.nodes
    .slice(1)
    .map(
      (node, i) =>
        Math.round(
          (node.x -
            node.width / 2 -
            (layout.nodes[i].x + layout.nodes[i].width / 2)) *
            10,
        ) / 10,
    );

describe('dated roadmap layout engine', () => {
  it('handles an empty roadmap', () => {
    const value = doc();
    value.migrations = [];
    const layout = computeLayout(value);
    expect(layout.nodes).toEqual([]);
    expect(layout.paths.independent).toBe('');
    expect(layout.width).toBeGreaterThanOrEqual(760);
  });

  it('handles one node without a crossover', () => {
    const value = doc();
    value.migrations = [value.migrations[0]];
    const layout = computeLayout(value);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.crossoverIntervals).toEqual([]);
    expect(layout.paths.independent).not.toContain(' C ');
  });

  it('keeps every gap at the chosen spacing when no crossover is due', () => {
    const value = doc();
    value.timeline.viewDate = '2100-01-01';
    const layout = computeLayout(value);
    expect(layout.crossoverIntervals).toEqual([]);
    expect(new Set(edgeGaps(layout))).toEqual(
      new Set([value.layout.nodeSpacing]),
    );
  });

  it('moves nodes closer together and further apart with one setting', () => {
    const value = doc();
    value.layout.nodeSpacing = 20;
    const tight = computeLayout(value);
    value.layout.nodeSpacing = 160;
    const loose = computeLayout(value);
    expect(Math.min(...edgeGaps(tight))).toBe(20);
    expect(Math.min(...edgeGaps(loose))).toBe(160);
    expect(loose.width).toBeGreaterThan(tight.width);
  });

  it('treats spacing as a floor once a fixed canvas is wider than needed', () => {
    const value = doc();
    value.layout.widthMode = 'fixed';
    value.layout.width = 4000;
    const layout = computeLayout(value);
    expect(layout.width).toBe(4000);
    expect(layout.spread).toBeGreaterThan(0);
    expect(Math.min(...edgeGaps(layout))).toBeGreaterThan(
      value.layout.nodeSpacing,
    );
  });

  it('grows type, columns, and canvas together with the text size', () => {
    const value = doc();
    const plain = computeLayout(value);
    value.layout.textScale = 2;
    const large = computeLayout(value);
    expect(large.metrics.nodeLabel).toBeCloseTo(plain.metrics.nodeLabel * 2);
    expect(large.nodes[0].width).toBeGreaterThan(plain.nodes[0].width);
    // Bigger type needs more room under the header, more room above the
    // timeline, and a taller canvas to hold the result.
    expect(large.topY).toBeGreaterThan(plain.topY);
    expect(large.timelineY - large.bottomY).toBeGreaterThan(
      plain.timelineY - plain.bottomY,
    );
    expect(large.height).toBeGreaterThan(plain.height);
  });

  it('reports growth only when an exact canvas had to be overruled', () => {
    const value = doc();
    expect(computeLayout(value).grew).toBe(false);
    value.layout.widthMode = 'fixed';
    value.layout.width = 760;
    value.layout.height = 640;
    expect(computeLayout(value).grew).toBe(true);
  });

  it('takes the header space back when the title is hidden', () => {
    const value = doc();
    const titled = computeLayout(value);
    value.metadata.showTitle = false;
    value.metadata.showSubtitle = false;
    const bare = computeLayout(value);
    expect(bare.topY).toBeLessThan(titled.topY);
    expect(bare.height).toBeLessThan(titled.height);
  });

  it('never gets narrower than the legend and the signature together', () => {
    const value = doc();
    value.migrations = [value.migrations[0]];
    value.layout.nodeSpacing = 8;
    const layout = computeLayout(value);
    expect(layout.width).toBeGreaterThanOrEqual(
      Math.ceil(
        value.layout.outerMargin * 2 +
          legendWidth(value, layout.metrics) +
          48 +
          brandWidth(layout.metrics),
      ),
    );
  });

  it('opens the lanes when a tall label would otherwise reach into one', () => {
    const value = doc();
    value.layout.textScale = 2.4;
    for (const migration of value.migrations)
      migration.replacement.label = 'A three line replacement label to fit';
    const layout = computeLayout(value);
    expect(layout.bottomY - layout.topY).toBeGreaterThan(
      value.layout.laneSeparation,
    );
  });

  it('places one crossover at the selected viewing date', () => {
    const layout = computeLayout(doc());
    expect(layout.crossoverIntervals).toEqual([5]);
    expect(layout.paths.independent).toContain(' C ');
    expect(layout.viewMarkerX).toBe(
      (layout.nodes[5].x + layout.nodes[6].x) / 2,
    );
  });

  it('shows no crossover before every node or after every node', () => {
    const value = doc();
    value.timeline.viewDate = '1900-01-01';
    expect(computeLayout(value).crossoverIntervals).toEqual([]);
    value.timeline.viewDate = '2200-01-01';
    expect(computeLayout(value).crossoverIntervals).toEqual([]);
  });

  it('sorts nodes chronologically regardless of storage order', () => {
    const value = doc();
    value.migrations.reverse();
    const layout = computeLayout(value);
    expect(layout.orderedMigrationIds).toEqual(
      chronologicalMigrations(value.migrations).map((item) => item.id),
    );
    expect(layout.crossoverIntervals).toEqual([5]);
  });

  it('derives lane placement from dates instead of manual status', () => {
    const value = doc();
    expect(
      laneEntries(value.migrations[0], value.timeline.viewDate).top.category,
    ).toBe('independent');
    expect(
      laneEntries(value.migrations.at(-1)!, value.timeline.viewDate).top
        .category,
    ).toBe('proprietary');
  });

  it('allocates extra spacing only to the dated crossover interval', () => {
    const value = doc();
    const gaps = edgeGaps(computeLayout(value));
    expect(gaps[5]).toBeGreaterThan(value.layout.nodeSpacing);
    expect(
      gaps.every((gap, i) =>
        i === 5 ? true : gap === value.layout.nodeSpacing,
      ),
    ).toBe(true);
  });

  it('aligns both crossover runways when one lane has a much wider node', () => {
    const value = doc();
    value.layout.widthMode = 'auto';
    const office = value.migrations[5];
    office.source.icons.push(
      ...office.source.icons,
      ...office.source.icons,
      ...office.source.icons,
    );
    const layout = computeLayout(value);
    const crossoverIndex = layout.crossoverIntervals[0];
    const from = layout.nodes[crossoverIndex];
    const to = layout.nodes[crossoverIndex + 1];
    const curveStart =
      Math.round(
        (from.x + Math.max(from.topWidth, from.bottomWidth) / 2) * 10,
      ) / 10;
    const curveEnd =
      Math.round((to.x - Math.max(to.topWidth, to.bottomWidth) / 2) * 10) / 10;

    expect(layout.paths.independent).toContain(`H ${curveStart} C `);
    expect(layout.paths.proprietary).toContain(`H ${curveStart} C `);
    expect(layout.paths.independent).toContain(
      `, ${curveEnd} ${layout.bottomY}`,
    );
    expect(layout.paths.proprietary).toContain(`, ${curveEnd} ${layout.topY}`);
  });

  it('measures long labels and multiple icons', () => {
    const value = doc();
    value.migrations[0].source.label =
      'An exceptionally long service name that needs several lines of careful wrapping';
    value.migrations[0].source.icons.push(...value.migrations[0].source.icons);
    const layout = computeLayout(value);
    expect(
      estimateLabelWidth(value.migrations[0].source.label),
    ).toBeGreaterThan(100);
    expect(layout.nodes[0].bottomWidth).toBeGreaterThan(
      value.layout.minNodeWidth,
    );
  });

  it('recalculates after adding, removing, and redating nodes', () => {
    const value = doc();
    const before = computeLayout(value);
    const added = createMigration();
    added.date = '2024-06-12';
    value.migrations.push(added);
    expect(computeLayout(value).orderedMigrationIds[1]).toBe(added.id);
    value.migrations.splice(value.migrations.indexOf(added), 1);
    expect(computeLayout(value).nodes).toHaveLength(before.nodes.length);
  });

  it('grows a small fixed canvas instead of colliding', () => {
    const value = doc();
    value.layout.widthMode = 'fixed';
    value.layout.width = 760;
    const layout = computeLayout(value);
    expect(layout.grew).toBe(true);
    expect(layout.width).toBeGreaterThan(760);
  });

  it('automatic width tracks content growth', () => {
    const value = doc();
    const normal = computeLayout(value).width;
    value.migrations.push(createMigration(), createMigration());
    expect(computeLayout(value).width).toBeGreaterThan(normal);
  });

  it('starts and ends every segment at visible node edges', () => {
    const value = doc();
    const layout = computeLayout(value);
    const firstRightEdge = layout.nodes[0].x + layout.nodes[0].topWidth / 2;
    const secondLeftEdge = layout.nodes[1].x - layout.nodes[1].topWidth / 2;
    expect(layout.paths.independent).toContain(
      `M ${Math.round(firstRightEdge * 10) / 10} ${layout.topY}`,
    );
    expect(layout.paths.independent).toContain(
      `H ${Math.round(secondLeftEdge * 10) / 10}`,
    );
  });
});

describe('roadmap files, dates, and icon safety', () => {
  it('creates a blank node with date, Big Tech, and Open Source steps', () => {
    const node = createMigration();
    expect(node).toMatchObject({
      categoryLabel: '',
      categoryIcon: 'tag',
      date: '',
      datePrecision: 'date',
    });
    expect(node.source).toMatchObject({
      label: '',
      category: 'proprietary',
      icons: [],
    });
    expect(node.replacement).toMatchObject({
      label: '',
      category: 'independent',
      icons: [],
    });
  });

  it('formats year, quarter, and exact dates', () => {
    expect(formatNodeDate('2028-01-01', 'year')).toBe('2028');
    expect(formatNodeDate('2028-07-01', 'quarter')).toBe('2028 Q3');
    expect(formatNodeDate('2028-07-18', 'date')).toBe('Jul 18, 2028');
    expect(formatFullDate('2028-07-18', 'dmy')).toBe('18/07/2028');
    expect(formatFullDate('2028-07-18', 'mdy')).toBe('07/18/2028');
  });

  it('creates exact quarter-start quick dates', () => {
    expect(
      [1, 2, 3, 4].map((quarter) =>
        quarterStartDate(2028, quarter as 1 | 2 | 3 | 4),
      ),
    ).toEqual(['2028-01-01', '2028-04-01', '2028-07-01', '2028-10-01']);
  });

  it('keeps manual order for nodes that count as done on the same day', () => {
    const first = structuredClone(initialRoadmap.migrations[0]);
    const second = structuredClone(initialRoadmap.migrations[1]);
    first.date = '2025-12-10';
    second.date = '2025-01-02';
    first.datePrecision = second.datePrecision = 'year';
    first.displayPrecision = second.displayPrecision = 'year';
    expect(
      chronologicalMigrations([first, second]).map((item) => item.id),
    ).toEqual([first.id, second.id]);
    expect(migrationDisplayLabel(first)).toBe('2025');
  });

  it('crosses over once whatever mix of date precisions is in play', () => {
    const value = doc();
    value.timeline.viewDate = '2026-09-16';
    const [a, b, c] = value.migrations;
    Object.assign(a, {
      date: '2026-07-01',
      datePrecision: 'quarter',
      displayPrecision: 'quarter',
    });
    Object.assign(b, {
      date: '2026-09-15',
      datePrecision: 'date',
      displayPrecision: 'date',
    });
    Object.assign(c, {
      date: '2026-10-01',
      datePrecision: 'quarter',
      displayPrecision: 'quarter',
    });
    value.migrations = [a, b, c];
    const layout = computeLayout(value);
    expect(layout.orderedMigrationIds).toEqual([b.id, a.id, c.id]);
    expect(layout.crossoverIntervals).toEqual([0]);
    expect(layout.viewMarkerX).toBeGreaterThan(layout.nodes[0].x);
    expect(layout.viewMarkerX).toBeLessThan(layout.nodes[1].x);
  });

  it('does not invent a completed day inside a coarse flexible period', () => {
    const node = structuredClone(initialRoadmap.migrations[0]);
    node.date = '2026-01-01';
    node.datePrecision = 'year';
    node.displayPrecision = 'year';
    expect(migrationIsReached(node, '2026-09-05')).toBe(false);
    expect(migrationIsReached(node, '2027-01-01')).toBe(true);
  });

  it('round-trips versioned JSON', () => {
    const value = doc();
    const result = validateRoadmap(JSON.parse(JSON.stringify(value)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(value);
  });

  it('fills missing node fields with defaults and fixes the side categories', () => {
    const value = doc();
    const bare = value.migrations[0] as unknown as Record<string, unknown>;
    delete bare.date;
    delete bare.datePrecision;
    delete bare.categoryLabel;
    delete bare.categoryIcon;
    value.migrations[0].source.category = 'independent';
    value.migrations[0].replacement.category = 'proprietary';
    const result = validateRoadmap(value);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.migrations[0]).toMatchObject({
        date: '',
        datePrecision: 'date',
        categoryLabel: '',
        categoryIcon: 'tag',
        source: { category: 'proprietary' },
        replacement: { category: 'independent' },
      });
  });

  it('never throws on hostile input and clamps what it keeps', () => {
    const value = doc() as unknown as Record<string, unknown>;
    Object.assign(value, {
      metadata: { title: { evil: true }, showTitle: 'yes' },
      labels: { independent: 5 },
      timeline: { viewDate: 'abc' },
      theme: { background: 123, text: '#ZZZZZZ' },
      layout: { width: 1e9, height: -5, outerMargin: 'abc', iconSize: NaN },
      export: { filename: '../../evil' },
    });
    const first = (value.migrations as Record<string, unknown>[])[0];
    Object.assign(first, {
      date: 20260101,
      datePrecision: 'sometime',
      source: {
        label: 7,
        icons: [
          null,
          'string',
          42,
          { id: 1 },
          { id: 'x', dataUrl: 'https://tracker.example/p.png' },
        ],
      },
    });
    const result = validateRoadmap(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata.title).toBe(initialRoadmap.metadata.title);
    expect(result.value.metadata.showTitle).toBe(true);
    expect(result.value.labels.independent).toBe('OPEN SOURCE');
    expect(result.value.timeline.viewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.value.theme.background).toBe('#ffffff');
    expect(result.value.theme.text).toBe('#0d2135');
    expect(result.value.layout).toMatchObject({
      width: 8000,
      height: 640,
      outerMargin: 72,
      iconSize: 52,
    });
    expect(result.value.export.filename).toBe('evil');
    expect(result.value.migrations[0]).toMatchObject({
      date: '',
      datePrecision: 'date',
      source: { label: '' },
    });
    expect(result.value.migrations[0].source.icons).toEqual([
      { id: 'x', name: 'x', source: 'dashboard' },
    ]);
    const layout = computeLayout(result.value);
    expect(
      Number.isFinite(layout.width) && Number.isFinite(layout.height),
    ).toBe(true);
  });

  it('refuses a roadmap with more nodes than the canvas can hold', () => {
    const value = doc();
    value.migrations = Array.from({ length: 61 }, () => createMigration());
    const result = validateRoadmap(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/61 nodes/);
  });

  it('falls back safely from invalid category display and icon values', () => {
    const value = doc();
    value.metadata.categoryDisplay = 'invalid' as 'text';
    value.timeline.fullDateFormat = 'invalid' as 'dmy';
    value.migrations[0].categoryIcon = 'invalid' as 'tag';
    const result = validateRoadmap(value);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.metadata.categoryDisplay).toBe('icon');
      expect(result.value.timeline.fullDateFormat).toBe('dmy');
      expect(result.value.migrations[0].categoryIcon).toBe('tag');
    }
  });

  it('drops fields the document does not have', () => {
    const value = doc() as RoadmapDocument & {
      theme: RoadmapDocument['theme'] & { emphasized?: string };
    };
    value.theme.emphasized = '#f0c000';
    (value.migrations[0] as Migration & { emphasized?: boolean }).emphasized =
      true;
    const result = validateRoadmap(value);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.theme).not.toHaveProperty('emphasized');
      expect(result.value.migrations[0]).not.toHaveProperty('emphasized');
    }
  });

  it('returns actionable errors for invalid imports', () => {
    const result = validateRoadmap({ schemaVersion: 99, migrations: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.join(' ')).toMatch(/schema version|migrations/i);
  });

  it('scopes SVG ids and classes and removes executable content', () => {
    const input =
      '<svg viewBox="0 0 10 10"><style>.a{fill:url(#g)}</style><defs><linearGradient id="g"/></defs><script>alert(1)</script><path class="a" fill="url(#g)" onclick="evil()"/></svg>';
    const output = sanitizeAndScopeSvg(input, 'demo');
    expect(output).toContain('id="demo-g"');
    expect(output).toContain('class="demo-a"');
    expect(output).toContain('url(#demo-g)');
    expect(output).not.toMatch(/script|onclick/);
  });

  it('preserves full-color artwork while sanitizing it', () => {
    const input =
      '<svg viewBox="0 0 10 10"><path fill="#4285F4" d="M0 0h5v10H0z"/><path fill="#EA4335" d="M5 0h5v10H5z"/></svg>';
    const output = sanitizeAndScopeSvg(input, 'color');
    expect(output).toContain('#4285F4');
    expect(output).toContain('#EA4335');
  });
});

describe('the roadmap a first-time visitor lands on', () => {
  it('is short, light, and crosses over exactly once', () => {
    const value = cloneRoadmap(initialRoadmap);
    value.timeline.viewDate = '2026-09-16';
    expect(value.migrations).toHaveLength(5);
    expect(value.theme.background).toBe('#ffffff');
    expect(value.layout.widthMode).toBe('auto');
    expect(computeLayout(value).crossoverIntervals).toHaveLength(1);
  });

  it('offers the long journey and a blank canvas as templates', () => {
    expect(ROADMAP_TEMPLATES.map((template) => template.id)).toEqual([
      'everyday',
      'journey',
      'blank',
    ]);
    expect(ROADMAP_TEMPLATES[0].build().migrations).toHaveLength(5);
    expect(ROADMAP_TEMPLATES[1].build().migrations).toHaveLength(
      fullJourneyRoadmap.migrations.length,
    );
    expect(ROADMAP_TEMPLATES[2].build().migrations).toEqual([]);
  });

  it('replaces retired layout settings when reading an older file', () => {
    const value = cloneRoadmap(initialRoadmap) as RoadmapDocument & {
      layout: RoadmapDocument['layout'] & Record<string, unknown>;
    };
    value.layout.widthMode = 'manual' as 'auto';
    value.layout.minNodeGap = 34;
    value.layout.preferredNodeGap = 78;
    value.layout.textScale = 99;
    const result = validateRoadmap(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.layout.widthMode).toBe('auto');
    expect(result.value.layout).not.toHaveProperty('minNodeGap');
    expect(result.value.layout).not.toHaveProperty('preferredNodeGap');
    expect(result.value.layout.textScale).toBe(2.4);
  });
});

describe('the roadmap library', () => {
  const library = (): RoadmapLibrary => {
    const first = createProject('Example roadmap', initialRoadmap);
    return { activeId: first.id, projects: [first] };
  };

  it('keeps the edits of each roadmap in its own project', () => {
    const start = library();
    const second = createProject('Photos only', fullJourneyRoadmap);
    const both = addProject(start, second);
    const edited = cloneRoadmap(second.doc);
    edited.metadata.title = 'Photos only';
    const saved = withActiveDoc(both, edited);
    expect(saved.projects[0].doc.metadata.title).toBe(
      initialRoadmap.metadata.title,
    );
    expect(saved.projects[1].doc.metadata.title).toBe('Photos only');
  });

  it('names copies apart and opens a neighbour after a delete', () => {
    const start = library();
    const copy = createProject(
      uniqueProjectName(start, 'Example roadmap'),
      initialRoadmap,
    );
    const both = addProject(start, copy);
    expect(copy.name).toBe('Example roadmap 2');
    expect(both.activeId).toBe(copy.id);
    const left = removeProject(both, copy.id);
    expect(left.projects).toHaveLength(1);
    expect(left.activeId).toBe(start.projects[0].id);
  });

  it('forks the example instead of letting an edit land in it', () => {
    const start = seedLibrary();
    const example = activeProject(start);
    expect(example.example).toBe('everyday');
    const edited = cloneRoadmap(example.doc);
    edited.metadata.title = 'My own thing';
    const { library: next, project: copy } = forkExample(start, edited);
    expect(copy.example).toBeUndefined();
    expect(next.activeId).toBe(copy.id);
    expect(next.projects[0].doc.metadata.title).toBe(
      initialRoadmap.metadata.title,
    );
    expect(copy.doc.metadata.title).toBe('My own thing');
  });

  it('keeps the example in a library that has lost it', () => {
    const mine = createProject('Mine', fullJourneyRoadmap);
    const restored = ensureExample({ activeId: mine.id, projects: [mine] });
    expect(restored.projects[0].example).toBe('everyday');
    expect(restored.activeId).toBe(mine.id);
    expect(ensureExample(restored).projects).toHaveLength(2);
  });

  it('lets renaming the example adopt it as an ordinary roadmap', () => {
    const start = seedLibrary();
    const claimed = renameProject(start, start.projects[0].id, 'Mine now');
    expect(claimed.projects[0].example).toBeUndefined();
    expect(ensureExample(claimed).projects).toHaveLength(2);
  });

  it('refuses a new roadmap rather than dropping the oldest', () => {
    let full = library();
    while (!libraryIsFull(full))
      full = addProject(full, createProject('Another', initialRoadmap));
    const refused = addProject(
      full,
      createProject('One too many', initialRoadmap),
    );
    expect(refused.projects).toHaveLength(full.projects.length);
    expect(refused.projects[0].id).toBe(full.projects[0].id);
  });

  it('trims and caps a renamed roadmap', () => {
    const start = library();
    const renamed = renameProject(
      start,
      start.projects[0].id,
      `  ${'n'.repeat(80)}  `,
    );
    expect(renamed.projects[0].name).toHaveLength(48);
  });
});

describe('the graphic at its extremes', () => {
  it('keeps the category markers under the header on a social canvas', () => {
    const value = doc();
    value.layout.widthMode = 'fixed';
    value.layout.width = 2000;
    value.layout.height = 1400;
    value.layout.textScale = 2.4;
    value.metadata.categoryDisplay = 'both';
    const layout = computeLayout(value);
    const marker = categoryMarker(value, layout.metrics);
    const markerTop =
      layout.topY - layout.metrics.categoryOffset - marker.reach;
    expect(layout.social).toBe(true);
    expect(markerTop).toBeGreaterThan(layout.header.subtitleY);
  });

  it('gives the signature its own row under the legend on a grown social canvas', () => {
    const value = doc();
    value.layout.widthMode = 'fixed';
    value.layout.width = 2000;
    value.layout.height = 1400;
    value.layout.textScale = 2.4;
    const layout = computeLayout(value);
    expect(layout.height).toBeGreaterThan(1400);
    expect(layout.brandY - layout.metrics.brandMark / 2).toBeGreaterThanOrEqual(
      layout.legendY + layout.metrics.legend * 1.2,
    );
  });

  it('never flips a tall content-sized canvas into the social arrangement', () => {
    const value = doc();
    value.layout.outerMargin = 24;
    value.layout.textScale = 2.4;
    const layout = computeLayout(value);
    expect(layout.height).toBeGreaterThan(1400);
    expect(layout.social).toBe(false);
    expect(layout.brandY).toBe(layout.legendY);
  });

  it('leaves room for the date labels at any text size', () => {
    const value = doc();
    value.layout.textScale = 1.5;
    value.layout.nodeSpacing = 8;
    value.layout.iconSize = 24;
    for (const migration of value.migrations) {
      migration.source.label = 'X';
      migration.replacement.label = 'X';
      migration.displayPrecision = 'date';
    }
    const layout = computeLayout(value);
    const dateWidth = '01/01/2020'.length * layout.metrics.date * 0.62;
    for (let i = 1; i < layout.nodes.length; i++)
      expect(layout.nodes[i].x - layout.nodes[i - 1].x).toBeGreaterThan(
        dateWidth,
      );
  });

  it('lets the subtitle take the title’s place when the title is hidden', () => {
    const shown = doc();
    const hidden = doc();
    hidden.metadata.showTitle = false;
    expect(computeLayout(hidden).header.subtitleY).toBeLessThan(
      computeLayout(shown).header.subtitleY,
    );
  });
});

describe('logo colour variants', () => {
  // Upstream metadata names the file by its own colour: the light-coloured
  // file is for a dark canvas.
  it('puts the light-coloured file on the dark canvas and vice versa', () => {
    const catalog = { light: 'vaultwarden-light' };
    expect(iconIdForScheme('vaultwarden', catalog, 'dark')).toBe(
      'vaultwarden-light',
    );
    expect(iconIdForScheme('vaultwarden', catalog, 'light')).toBe('vaultwarden');
    // The variant index completes the pair with the base file, so a flipped
    // logo finds its way back.
    const pair = { light: 'vaultwarden-light', dark: 'vaultwarden' };
    expect(iconIdForScheme('vaultwarden-light', pair, 'light')).toBe(
      'vaultwarden',
    );
    expect(iconIdForScheme('immich', undefined, 'dark')).toBe('immich');
  });

  it('lists every template icon in the build guard, and nothing else', () => {
    const used = new Set<string>();
    for (const template of ROADMAP_TEMPLATES)
      for (const migration of template.build().migrations)
        for (const side of [migration.source, migration.replacement])
          for (const icon of side.icons) used.add(icon.id);
    expect([...used].sort()).toEqual([...starterIcons.icons].sort());
  });
});
