import {
  chronologicalMigrations,
  laneEntries,
  migrationIsReached,
  type Category,
  type Migration,
  type RoadmapDocument,
  type ServiceEntry,
} from './roadmap-model';

export interface NodeGeometry {
  x: number;
  width: number;
  topWidth: number;
  bottomWidth: number;
}

export interface RoadmapLayout {
  width: number;
  height: number;
  requestedWidth: number;
  contentStart: number;
  contentEnd: number;
  topY: number;
  bottomY: number;
  timelineY: number;
  legendY: number;
  header: { titleY: number; subtitleY: number; centered: boolean };
  nodes: NodeGeometry[];
  orderedMigrationIds: string[];
  crossoverIntervals: number[];
  viewMarkerX?: number;
  paths: Record<Category, string>;
  grew: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function splitLabel(label: string, maxChars = 22): string[] {
  const explicit = label.split(/\r?\n/);
  const lines: string[] = [];
  for (const source of explicit) {
    const words = source.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      if (!line || `${line} ${word}`.length <= maxChars)
        line = line ? `${line} ${word}` : word;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.slice(0, 3);
}

export function estimateLabelWidth(label: string, fontSize = 14) {
  const longest = Math.max(1, ...splitLabel(label).map((line) => line.length));
  return Math.min(260, longest * fontSize * 0.56 + 16);
}

export function plateWidth(entry: ServiceEntry, doc: RoadmapDocument) {
  const count = Math.max(1, entry.icons.length);
  const iconWidth = entry.icons.length
    ? count * doc.layout.iconSize + (count - 1) * 8
    : doc.layout.iconSize;
  return Math.max(doc.layout.minNodeWidth, iconWidth + 26);
}

export function measuredColumnWidth(
  doc: RoadmapDocument,
  migration: Migration,
) {
  const { top, bottom } = laneEntries(migration, doc.timeline.viewDate);
  return Math.max(
    plateWidth(top, doc),
    plateWidth(bottom, doc),
    estimateLabelWidth(top.label),
    estimateLabelWidth(bottom.label),
    86,
  );
}

function laneForCategory(
  entry: { top: ServiceEntry; bottom: ServiceEntry },
  category: Category,
) {
  return entry.top.category === category ? 'top' : 'bottom';
}

export function computeLayout(doc: RoadmapDocument): RoadmapLayout {
  const orderedMigrations = chronologicalMigrations(doc.migrations);
  const count = orderedMigrations.length;
  const social = doc.layout.height >= 1400;
  const height = Math.max(640, doc.layout.height);
  const topY = social ? Math.round(height * 0.38) : Math.round(height * 0.39);
  const bottomY = topY + doc.layout.laneSeparation;
  const timelineY = social
    ? Math.round(height * 0.64)
    : Math.min(height - 118, bottomY + 173);
  const legendY = social
    ? Math.round(height * 0.73)
    : Math.min(height - 52, timelineY + 95);
  const outer = doc.layout.outerMargin;
  const entries = orderedMigrations.map((item) =>
    laneEntries(item, doc.timeline.viewDate),
  );
  const columnWidths = orderedMigrations.map((migration) =>
    measuredColumnWidth(doc, migration),
  );
  const crossoverIntervals: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    if (entries[i].top.category !== entries[i + 1].top.category)
      crossoverIntervals.push(i);
  }

  const baseCenterGap =
    count > 1
      ? Math.max(
          doc.layout.preferredNodeGap,
          ...columnWidths
            .slice(0, -1)
            .map(
              (w, i) => w / 2 + columnWidths[i + 1] / 2 + doc.layout.minNodeGap,
            ),
        )
      : 0;
  const crossoverRun = Math.max(
    120,
    doc.layout.laneSeparation * clamp(doc.layout.curveTension, 0.35, 1.4),
  );
  const centerGaps = Array.from({ length: Math.max(0, count - 1) }, (_, i) => {
    if (!crossoverIntervals.includes(i)) return baseCenterGap;
    const plateRequirement =
      Math.max(
        plateWidth(entries[i].top, doc),
        plateWidth(entries[i].bottom, doc),
      ) /
        2 +
      Math.max(
        plateWidth(entries[i + 1].top, doc),
        plateWidth(entries[i + 1].bottom, doc),
      ) /
        2 +
      crossoverRun;
    return Math.max(baseCenterGap, plateRequirement);
  });

  const firstHalf = count ? columnWidths[0] / 2 : 0;
  const lastHalf = count ? columnWidths[count - 1] / 2 : 0;
  const intrinsic = count
    ? outer * 2 + firstHalf + lastHalf + centerGaps.reduce((a, b) => a + b, 0)
    : Math.max(760, doc.layout.width);
  const requestedWidth = Math.max(760, doc.layout.width);
  const width =
    doc.layout.widthMode === 'auto'
      ? Math.ceil(intrinsic)
      : Math.ceil(Math.max(requestedWidth, intrinsic));
  const usable = Math.max(0, width - outer * 2 - firstHalf - lastHalf);
  const intrinsicGaps = centerGaps.reduce((a, b) => a + b, 0);
  const distributable =
    count > 1 && doc.layout.widthMode !== 'auto'
      ? Math.max(0, usable - intrinsicGaps) / (count - 1)
      : 0;
  const resolvedGaps = centerGaps.map((gap) => gap + distributable);
  const nodes: NodeGeometry[] = [];
  let cursor = outer + firstHalf;
  for (let i = 0; i < count; i++) {
    nodes.push({
      x: cursor,
      width: columnWidths[i],
      topWidth: plateWidth(entries[i].top, doc),
      bottomWidth: plateWidth(entries[i].bottom, doc),
    });
    cursor += resolvedGaps[i] ?? 0;
  }
  const contentStart = count
    ? Math.max(outer, nodes[0].x - nodes[0].topWidth / 2)
    : outer;
  const contentEnd = count
    ? Math.min(
        width - outer,
        nodes[count - 1].x + nodes[count - 1].topWidth / 2,
      )
    : width - outer;
  const reachedCount = orderedMigrations.filter((migration) =>
    migrationIsReached(migration, doc.timeline.viewDate),
  ).length;
  const viewMarkerX = count
    ? reachedCount === 0
      ? nodes[0].x
      : reachedCount >= count
        ? nodes[count - 1].x
        : (nodes[reachedCount - 1].x + nodes[reachedCount].x) / 2
    : undefined;

  const pathFor = (category: Category) => {
    if (!count) return '';
    const firstLane = laneForCategory(entries[0], category);
    const firstY = firstLane === 'top' ? topY : bottomY;
    const firstPlate =
      firstLane === 'top' ? nodes[0].topWidth : nodes[0].bottomWidth;
    let d = `M ${outer} ${firstY} H ${round(nodes[0].x - firstPlate / 2)}`;
    for (let i = 0; i < count - 1; i++) {
      const fromLane = laneForCategory(entries[i], category);
      const toLane = laneForCategory(entries[i + 1], category);
      const fromY = fromLane === 'top' ? topY : bottomY;
      const toY = toLane === 'top' ? topY : bottomY;
      const fromWidth =
        fromLane === 'top' ? nodes[i].topWidth : nodes[i].bottomWidth;
      const toWidth =
        toLane === 'top' ? nodes[i + 1].topWidth : nodes[i + 1].bottomWidth;
      const startX = nodes[i].x + fromWidth / 2;
      const endX = nodes[i + 1].x - toWidth / 2;
      d += ` M ${round(startX)} ${fromY}`;
      if (fromY === toY) d += ` H ${round(endX)}`;
      else {
        // Both category paths must enter and leave the crossover at the same
        // x coordinates. If one plate is wider, extend the shorter plate's
        // horizontal line to the wider edge before either curve begins.
        const curveStartX = Math.max(
          nodes[i].x + nodes[i].topWidth / 2,
          nodes[i].x + nodes[i].bottomWidth / 2,
        );
        const curveEndX = Math.min(
          nodes[i + 1].x - nodes[i + 1].topWidth / 2,
          nodes[i + 1].x - nodes[i + 1].bottomWidth / 2,
        );
        const run = curveEndX - curveStartX;
        const pull = Math.min(
          run * 0.48,
          Math.max(44, run * clamp(doc.layout.curveTension, 0.2, 0.8)),
        );
        d += ` H ${round(curveStartX)}`;
        d += ` C ${round(curveStartX + pull)} ${fromY}, ${round(curveEndX - pull)} ${toY}, ${round(curveEndX)} ${toY}`;
        d += ` H ${round(endX)}`;
      }
    }
    const lastLane = laneForCategory(entries[count - 1], category);
    const lastY = lastLane === 'top' ? topY : bottomY;
    const lastPlate =
      lastLane === 'top'
        ? nodes[count - 1].topWidth
        : nodes[count - 1].bottomWidth;
    d += ` M ${round(nodes[count - 1].x + lastPlate / 2)} ${lastY} H ${round(width - outer)}`;
    return d;
  };

  return {
    width,
    height,
    requestedWidth,
    contentStart,
    contentEnd,
    topY,
    bottomY,
    timelineY,
    legendY,
    header: {
      titleY: social ? 220 : 116,
      subtitleY: social ? 278 : 160,
      centered: social,
    },
    nodes,
    orderedMigrationIds: orderedMigrations.map((migration) => migration.id),
    crossoverIntervals,
    viewMarkerX,
    paths: {
      independent: pathFor('independent'),
      proprietary: pathFor('proprietary'),
    },
    grew: width > requestedWidth,
  };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
