import {
  chronologicalMigrations,
  laneEntries,
  migrationDisplayLabel,
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

// Every piece of type on the canvas, and every offset measured in type, in one
// place: the canvas reads its font sizes from here so the layout engine and
// the drawing can never disagree about how much room the text needs.
export interface RoadmapMetrics {
  scale: number;
  title: number;
  subtitle: number;
  lane: number;
  category: number;
  categoryGlyph: number;
  nodeLabel: number;
  nodeLabelLine: number;
  date: number;
  now: number;
  legend: number;
  legendDot: number;
  brand: number;
  brandMark: number;
  /** Lane label baseline, above the lane centre. */
  laneLabelOffset: number;
  /** Category marker baseline, above the top lane centre. */
  categoryOffset: number;
  /** First node-label baseline, below the node centre. */
  nodeLabelOffset: number;
  /** Timeline date baseline, below the timeline rule. */
  dateLabelOffset: number;
  /** "TIMELINE" baseline, above the timeline rule. */
  timelineLabelOffset: number;
}

export interface RoadmapLayout {
  width: number;
  height: number;
  requestedWidth: number;
  requestedHeight: number;
  contentStart: number;
  contentEnd: number;
  topY: number;
  bottomY: number;
  timelineY: number;
  legendY: number;
  /** Centre line of the brand signature: the legend row, or its own row
   *  above the bottom edge on a social canvas. */
  brandY: number;
  /** The tall social arrangement: centred header and legend, signature at
   *  the bottom. Decided here once; the canvas only reads it. */
  social: boolean;
  header: { titleY: number; subtitleY: number; centered: boolean };
  metrics: RoadmapMetrics;
  nodes: NodeGeometry[];
  orderedMigrationIds: string[];
  crossoverIntervals: number[];
  viewMarkerX?: number;
  paths: Record<Category, string>;
  grew: boolean;
  /** Extra width handed to each gap because the canvas is wider than the
   *  content needs. While this is above zero, node spacing is only a floor. */
  spread: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Half the node plate; the plate is a fixed 76px tall pill. */
const PLATE_HALF = 38;

export function textScaleOf(doc: RoadmapDocument) {
  return clamp(doc.layout.textScale || 1, 0.6, 3);
}

// The tall square layout, for a social post. It belongs to an exact-size
// canvas: a canvas that follows its content has no spare height to arrange.
export function isSocialCanvas(doc: RoadmapDocument) {
  return doc.layout.widthMode === 'fixed' && doc.layout.height >= 1400;
}

export function roadmapMetrics(doc: RoadmapDocument): RoadmapMetrics {
  const s = textScaleOf(doc);
  const social = isSocialCanvas(doc);
  return {
    scale: s,
    title: (social ? 64 : 52) * s,
    subtitle: (social ? 22 : 18) * s,
    lane: 14 * s,
    category: (social ? 15 : 12) * s,
    // Generic category glyphs are line art with no colour to recognise them
    // by, so they are drawn well above label size to stay readable.
    categoryGlyph: (social ? 34 : 30) * s,
    nodeLabel: (social ? 14 : 13) * s,
    nodeLabelLine: 17 * s,
    date: 13 * s,
    now: 10 * s,
    legend: (social ? 22 : 14) * s,
    legendDot: (social ? 12 : 9) * s,
    brand: (social ? 33 : 22) * s,
    brandMark: (social ? 76 : 50) * s,
    // Offsets that start at the plate edge grow only by the type they clear,
    // so a bigger typeface moves labels away from the plate without pushing
    // the whole lane apart.
    laneLabelOffset: PLATE_HALF + 28 * s,
    categoryOffset: PLATE_HALF + 68 * s,
    nodeLabelOffset: PLATE_HALF + 40 * s,
    dateLabelOffset: 36 * s,
    timelineLabelOffset: 16 * s,
  };
}

export const BRAND_NOTE = 'Plan your digital independence at';
export const BRAND_LABEL = 'myownsuite.org/plan';

// SVG cannot measure text before it lays out, so the two blocks that sit on
// the bottom row — the legend on the left, the signature on the right — are
// estimated from the semi-bold face at 0.6 of the font size. The canvas is
// never allowed to be narrower than the two of them side by side.
export function legendSecondX(firstLabel: string, metrics: RoadmapMetrics) {
  return (
    metrics.legendDot +
    13 * metrics.scale +
    Math.max(firstLabel.length * metrics.legend * 0.62, 120 * metrics.scale) +
    26 * metrics.scale
  );
}

export function legendWidth(doc: RoadmapDocument, metrics: RoadmapMetrics) {
  return (
    legendSecondX(doc.labels.independent, metrics) +
    metrics.legendDot +
    13 * metrics.scale +
    doc.labels.proprietary.length * metrics.legend * 0.62
  );
}

export function brandWidth(metrics: RoadmapMetrics) {
  return (
    metrics.brandMark * 1.24 +
    Math.max(
      BRAND_LABEL.length * metrics.brand * 0.6,
      BRAND_NOTE.length * metrics.brand * 0.62 * 0.6,
    )
  );
}

export interface CategoryMarkerGeometry {
  glyph: number;
  /** Top edge of the glyph, above the marker anchor. */
  iconTop: number;
  /** Label baseline, above the marker anchor. */
  textBaseline: number;
  /** The marker's topmost ink, above the anchor — what the header clears. */
  reach: number;
}

// The category marker's geometry, shared by the canvas that draws it and the
// engine that has to leave room for it above the top lane.
export function categoryMarker(
  doc: RoadmapDocument,
  metrics: RoadmapMetrics,
): CategoryMarkerGeometry {
  const s = metrics.scale;
  const showIcon = doc.metadata.categoryDisplay !== 'text';
  const showText = doc.metadata.categoryDisplay !== 'icon';
  const glyph = showIcon ? metrics.categoryGlyph : 0;
  const iconTop = 12 * s + glyph;
  const textBaseline = showIcon ? iconTop + 9 * s : 16 * s;
  return {
    glyph,
    iconTop,
    textBaseline,
    reach: showText ? textBaseline + metrics.category * 0.75 : iconTop,
  };
}

// How far a node's label reaches past the plate, so the lanes and the timeline
// can be kept clear of it at any text size.
function labelReach(entries: ServiceEntry[], metrics: RoadmapMetrics) {
  const lines = Math.max(
    1,
    ...entries.map((entry) => splitLabel(entry.label).length),
  );
  return (
    metrics.nodeLabelOffset +
    (lines - 1) * metrics.nodeLabelLine +
    metrics.nodeLabel * 0.4
  );
}

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
  return Math.min((260 * fontSize) / 14, longest * fontSize * 0.56 + 16);
}

export function plateWidth(entry: ServiceEntry, doc: RoadmapDocument) {
  const count = Math.max(1, entry.icons.length);
  const iconWidth = entry.icons.length
    ? count * doc.layout.iconSize + (count - 1) * 8
    : doc.layout.iconSize;
  return Math.max(doc.layout.minNodeWidth, iconWidth + 26);
}

// The column has to hold everything printed under or above it, not only the
// plates: the date on the timeline and, when shown, the category text.
export function measuredColumnWidth(
  doc: RoadmapDocument,
  migration: Migration,
) {
  const { top, bottom } = laneEntries(migration, doc.timeline.viewDate);
  const metrics = roadmapMetrics(doc);
  const dateWidth =
    migrationDisplayLabel(migration, doc.timeline.fullDateFormat).length *
      metrics.date *
      0.62 +
    12;
  const categoryWidth =
    doc.metadata.showCategories && doc.metadata.categoryDisplay !== 'icon'
      ? migration.categoryLabel.length * metrics.category * 0.62 + 12
      : 0;
  return Math.max(
    plateWidth(top, doc),
    plateWidth(bottom, doc),
    estimateLabelWidth(top.label, metrics.nodeLabel),
    estimateLabelWidth(bottom.label, metrics.nodeLabel),
    dateWidth,
    categoryWidth,
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
  const social = isSocialCanvas(doc);
  // "Fit the roadmap" sizes both dimensions from the content; an exact canvas
  // is the size it is told to be, growing only to avoid a collision.
  const fits = doc.layout.widthMode === 'auto';
  const metrics = roadmapMetrics(doc);
  const requestedHeight = Math.max(640, doc.layout.height);
  const outer = doc.layout.outerMargin;
  const entries = orderedMigrations.map((item) =>
    laneEntries(item, doc.timeline.viewDate),
  );

  // Vertical stack, top down. Each band is pushed far enough apart to clear
  // the labels at the current text size, and the canvas grows at the bottom
  // when the requested height cannot hold the result.
  // A title baseline has to clear its own ascender, so it drops as the type
  // grows rather than being cropped by the top edge.
  const titleY = social ? 220 : Math.max(116, 60 + 56 * metrics.scale);
  // With the title hidden the subtitle takes its place instead of its band.
  const subtitleY = !doc.metadata.showTitle
    ? titleY
    : social
      ? 278
      : titleY + 44 * metrics.scale;
  const headerBottom =
    (doc.metadata.showSubtitle ? subtitleY : 0) ||
    (doc.metadata.showTitle ? titleY : 0);
  // Whatever sits above the top lane — the category markers, or the lane
  // label when categories are off — has to clear the subtitle's descender.
  const headroom = Math.max(
    doc.metadata.showCategories
      ? metrics.categoryOffset + categoryMarker(doc, metrics).reach
      : 0,
    metrics.laneLabelOffset + metrics.lane * 1.2,
  );
  // Where the roadmap starts is decided by what is above it: the header if
  // there is one, otherwise the top margin. Hiding the title therefore takes
  // its space back instead of leaving a band of empty canvas.
  const contentTop = headerBottom
    ? headerBottom + metrics.subtitle * 0.4 + 18 * metrics.scale + headroom
    : outer + headroom;
  // An exact-size canvas places the lanes by proportion, but never so high
  // that the header runs into them.
  const topY = Math.max(
    fits ? 0 : Math.round(requestedHeight * (social ? 0.38 : 0.39)),
    contentTop,
  );
  const topReach = labelReach(
    entries.map((entry) => entry.top),
    metrics,
  );
  const bottomReach = labelReach(
    entries.map((entry) => entry.bottom),
    metrics,
  );
  // The bottom lane's own label is printed above it, so the lanes have to hold
  // the top lane's node labels and that label between them.
  const laneSeparation = Math.max(
    doc.layout.laneSeparation,
    topReach + metrics.laneLabelOffset + metrics.lane * 1.3,
  );
  const bottomY = topY + laneSeparation;
  const timelineY = Math.max(
    social ? Math.round(requestedHeight * 0.64) : 0,
    bottomY +
      Math.max(
        173,
        bottomReach + metrics.timelineLabelOffset + metrics.lane * 1.4 + 10,
      ),
  );
  const legendY = Math.max(
    social ? Math.round(requestedHeight * 0.73) : 0,
    timelineY +
      Math.max(
        95,
        metrics.dateLabelOffset + metrics.date * 1.2 + 40 * metrics.scale,
      ),
  );
  // The legend and the signature share the bottom row, except on a social
  // canvas, where the signature gets its own row above the bottom edge.
  const brandRow = 154 * metrics.scale;
  const neededHeight = Math.ceil(
    social
      ? legendY + metrics.legend * 1.2 + brandRow + metrics.brandMark / 2
      : legendY + Math.max(52, metrics.brandMark * 0.75),
  );
  const height = fits ? neededHeight : Math.max(requestedHeight, neededHeight);
  const brandY = social ? height - brandRow : legendY;
  const columnWidths = orderedMigrations.map((migration) =>
    measuredColumnWidth(doc, migration),
  );
  const crossoverIntervals: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    if (entries[i].top.category !== entries[i + 1].top.category)
      crossoverIntervals.push(i);
  }

  // One spacing number, measured between what is drawn: the gap the reader
  // sees between two neighbouring columns. Wider columns push their centres
  // further apart on their own, so the setting never has to be fought.
  const spacing = clamp(doc.layout.nodeSpacing, 4, 600);
  const crossoverRun = Math.max(
    120,
    laneSeparation * clamp(doc.layout.curveTension, 0.35, 1.4),
  );
  const centerGaps = Array.from({ length: Math.max(0, count - 1) }, (_, i) => {
    const baseCenterGap =
      columnWidths[i] / 2 + columnWidths[i + 1] / 2 + spacing;
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
  // The legend and the signature share the bottom row, so no canvas may be
  // narrower than the two of them plus a gap.
  const bottomRow =
    outer * 2 +
    legendWidth(doc, metrics) +
    48 * metrics.scale +
    brandWidth(metrics);
  const intrinsic = Math.max(
    bottomRow,
    count
      ? outer * 2 + firstHalf + lastHalf + centerGaps.reduce((a, b) => a + b, 0)
      : // An empty roadmap has no content to hug, so a canvas that follows its
        // content opens at a modest size rather than at the exact-size setting.
        Math.max(760, fits ? 1200 : doc.layout.width),
  );
  const requestedWidth = Math.max(760, doc.layout.width);
  const width =
    doc.layout.widthMode === 'auto'
      ? Math.ceil(intrinsic)
      : Math.ceil(Math.max(requestedWidth, intrinsic));
  const usable = Math.max(0, width - outer * 2 - firstHalf - lastHalf);
  const intrinsicGaps = centerGaps.reduce((a, b) => a + b, 0);
  const distributable =
    count > 1 && doc.layout.widthMode === 'fixed'
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
    requestedHeight,
    contentStart,
    contentEnd,
    topY,
    bottomY,
    timelineY,
    legendY,
    brandY,
    social,
    header: { titleY, subtitleY, centered: social },
    metrics,
    nodes,
    orderedMigrationIds: orderedMigrations.map((migration) => migration.id),
    crossoverIntervals,
    viewMarkerX,
    paths: {
      independent: pathFor('independent'),
      proprietary: pathFor('proprietary'),
    },
    grew: !fits && (width > requestedWidth || height > requestedHeight),
    spread: distributable,
  };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
