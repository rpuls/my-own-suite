import { describe, expect, it } from 'vitest';
import { sanitizeAndScopeSvg } from './icon-library';
import { computeLayout, estimateLabelWidth } from './roadmap-layout';
import type { Migration, RoadmapDocument } from './roadmap-model';
import {
  chronologicalMigrations,
  cloneRoadmap,
  createMigration,
  formatFullDate,
  formatNodeDate,
  initialRoadmap,
  laneEntries,
  migrationDisplayLabel,
  migrationIsReached,
  quarterStartDate,
  validateRoadmap,
} from './roadmap-model';

const doc = () => {
  const value = cloneRoadmap(initialRoadmap);
  value.timeline.viewDate = '2026-09-05';
  return value;
};

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

  it('uses uniform spacing when every switch date has passed', () => {
    const value = doc();
    value.timeline.viewDate = '2100-01-01';
    const layout = computeLayout(value);
    const gaps = layout.nodes
      .slice(1)
      .map((node, i) => Math.round((node.x - layout.nodes[i].x) * 10) / 10);
    expect(new Set(gaps).size).toBe(1);
    expect(layout.crossoverIntervals).toEqual([]);
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
    value.layout.widthMode = 'auto';
    const layout = computeLayout(value);
    const gaps = layout.nodes
      .slice(1)
      .map((node, i) => Math.round((node.x - layout.nodes[i].x) * 1000) / 1000);
    expect(gaps[5]).toBeGreaterThan(gaps[0]);
    expect(
      gaps.filter((gap, i) => i !== 5).every((gap) => gap === gaps[0]),
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
    added.timeLabel = 'Jun 12, 2024';
    value.migrations.push(added);
    expect(computeLayout(value).orderedMigrationIds[1]).toBe(added.id);
    value.migrations.splice(value.migrations.indexOf(added), 1);
    expect(computeLayout(value).nodes).toHaveLength(before.nodes.length);
  });

  it('grows a small manual canvas instead of colliding', () => {
    const value = doc();
    value.layout.widthMode = 'manual';
    value.layout.width = 760;
    const layout = computeLayout(value);
    expect(layout.grew).toBe(true);
    expect(layout.width).toBeGreaterThan(760);
  });

  it('automatic width tracks content growth', () => {
    const value = doc();
    value.layout.widthMode = 'auto';
    const normal = computeLayout(value).width;
    value.migrations.push(createMigration(), createMigration());
    expect(computeLayout(value).width).toBeGreaterThan(normal);
  });

  it('starts and ends every segment at visible node edges', () => {
    const value = doc();
    value.layout.widthMode = 'auto';
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
      timeLabel: 'Set date',
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

  it('keeps manual order for flexible nodes with the same visible period', () => {
    const first = structuredClone(initialRoadmap.migrations[0]);
    const second = structuredClone(initialRoadmap.migrations[1]);
    first.date = '2025-12-10';
    second.date = '2025-01-02';
    first.useFlexibleDate = second.useFlexibleDate = true;
    first.displayPrecision = second.displayPrecision = 'year';
    expect(
      chronologicalMigrations([first, second]).map((item) => item.id),
    ).toEqual([first.id, second.id]);
    expect(migrationDisplayLabel(first, 'quarter')).toBe('2025');
  });

  it('does not invent a completed day inside a coarse flexible period', () => {
    const node = structuredClone(initialRoadmap.migrations[0]);
    node.date = '2026-01-01';
    node.datePrecision = 'year';
    node.displayPrecision = 'year';
    node.useFlexibleDate = true;
    expect(migrationIsReached(node, '2026-09-05')).toBe(false);
    expect(migrationIsReached(node, '2027-01-01')).toBe(true);
  });

  it('round-trips versioned JSON', () => {
    const value = doc();
    const result = validateRoadmap(JSON.parse(JSON.stringify(value)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(value);
  });

  it('migrates legacy timeline labels and normalizes fixed categories', () => {
    const value = doc();
    const legacy = value.migrations[0] as unknown as Record<string, unknown>;
    delete legacy.date;
    delete legacy.datePrecision;
    delete legacy.categoryLabel;
    delete legacy.categoryIcon;
    legacy.timeLabel = '2027 Q2';
    value.migrations[0].source.category = 'independent';
    value.migrations[0].replacement.category = 'proprietary';
    const result = validateRoadmap(value);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.migrations[0]).toMatchObject({
        date: '2027-04-01',
        datePrecision: 'date',
        timeLabel: 'Apr 1, 2027',
        categoryLabel: 'Smart home',
        categoryIcon: 'home',
        source: { category: 'proprietary' },
        replacement: { category: 'independent' },
      });
  });

  it('falls back safely from invalid category display and icon values', () => {
    const value = doc();
    value.metadata.categoryDisplay = 'invalid' as 'text';
    value.timeline.dateDisplay = 'invalid' as 'quarter';
    value.timeline.fullDateFormat = 'invalid' as 'dmy';
    value.migrations[0].categoryIcon = 'invalid' as 'tag';
    const result = validateRoadmap(value);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.metadata.categoryDisplay).toBe('text');
      expect(result.value.timeline.dateDisplay).toBe('quarter');
      expect(result.value.timeline.fullDateFormat).toBe('dmy');
      expect(result.value.migrations[0].categoryIcon).toBe('home');
    }
  });

  it('retires legacy emphasis settings when loading older roadmaps', () => {
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
