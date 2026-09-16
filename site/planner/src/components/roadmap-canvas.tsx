import type { CategoryIconId } from '@/lib/category-icons';
import { libraryIconDataUrl } from '@/lib/icon-library';
import {
  BRAND_LABEL,
  BRAND_NOTE,
  categoryMarker,
  legendSecondX,
  splitLabel,
  type CategoryMarkerGeometry,
  type RoadmapLayout,
  type RoadmapMetrics,
} from '@/lib/roadmap-layout';
import {
  chronologicalMigrations,
  formatNodeDate,
  laneEntries,
  migrationDisplayLabel,
  type Category,
  type IconRef,
  type Migration,
  type RoadmapDocument,
  type ServiceEntry,
} from '@/lib/roadmap-model';
import { useMemo, type Ref } from 'react';
import {
  BriefcaseBusiness,
  CalendarDays,
  Code2,
  Folder,
  Globe2,
  HardDrive,
  HeartPulse,
  HousePlug,
  ImageIcon,
  KeyRound,
  Mail,
  MessageCircle,
  NotebookPen,
  Play,
  Router,
  ShieldCheck,
  Tag,
  WalletCards,
  type LucideIcon,
} from 'lucide-react';

interface Props {
  document: RoadmapDocument;
  layout: RoadmapLayout;
  ref?: Ref<SVGSVGElement>;
  className?: string;
  interactive?: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onAdd?: () => void;
}

export function RoadmapCanvas({
  document: doc,
  layout,
  ref,
  className,
  interactive = false,
  selectedId,
  onSelect,
  onAdd,
}: Props) {
  const migrations = useMemo(
    () => chronologicalMigrations(doc.migrations),
    [doc.migrations],
  );
  const social = layout.social;
  const type = layout.metrics;
  const marker = categoryMarker(doc, type);
  const titleX = layout.header.centered
    ? layout.width / 2
    : doc.layout.outerMargin;
  const titleAnchor = layout.header.centered ? 'middle' : 'start';
  const topLabelY = layout.topY - type.laneLabelOffset;
  const bottomLabelY = layout.bottomY - type.laneLabelOffset;
  const categoryY = layout.topY - type.categoryOffset;
  const selectionTop =
    (doc.metadata.showCategories ? categoryY : layout.topY) - 54 * type.scale;
  const selectionBottom = layout.timelineY + 54 * type.scale;
  const empty = doc.migrations.length === 0;

  return (
    <svg
      ref={ref}
      id="roadmap-export"
      className={className}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      aria-labelledby="roadmap-title roadmap-description"
      style={{
        background: doc.theme.transparent
          ? 'transparent'
          : doc.theme.background,
      }}
    >
      <title id="roadmap-title">
        {doc.metadata.title || 'Digital independence roadmap'}
      </title>
      <desc id="roadmap-description">
        A two-lane roadmap showing Big Tech apps and their open-source
        alternatives over time.
      </desc>
      <defs>
        <style>{`
          .rm-text{font-family:'Open Sans','Segoe UI',Arial,sans-serif}.rm-interactive:focus-visible .rm-select-outline{opacity:1;stroke-dasharray:none}.rm-title{font-size:${round(type.title)}px;font-weight:800;letter-spacing:${round(-1.7 * type.scale)}px;fill:${doc.theme.text}}.rm-subtitle{font-size:${round(type.subtitle)}px;fill:${doc.theme.secondaryText}}.rm-lane{font-size:${round(type.lane)}px;font-weight:800;letter-spacing:${round(1.5 * type.scale)}px;fill:${doc.theme.text}}.rm-category{font-size:${round(type.category)}px;font-weight:800;fill:${doc.theme.text}}.rm-node-label{font-size:${round(type.nodeLabel)}px;font-weight:600;fill:${doc.theme.secondaryText}}.rm-date{font-size:${round(type.date)}px;font-weight:800;fill:${doc.theme.text}}.rm-now{font-size:${round(type.now)}px;font-weight:800;letter-spacing:.8px;fill:${doc.theme.timeline}}.rm-legend{font-size:${round(type.legend)}px;font-weight:800;fill:${doc.theme.text}}.rm-brand{font-size:${round(type.brand)}px;font-weight:800;fill:${doc.theme.text}}.rm-brand-note{font-size:${round(type.brand * 0.62)}px;font-weight:600;letter-spacing:.5px;fill:${doc.theme.secondaryText}}.rm-interactive{cursor:pointer;outline:none}.rm-select-outline{opacity:0;transition:opacity .12s}.rm-interactive:hover .rm-select-outline,.rm-interactive:focus .rm-select-outline{opacity:.55}.rm-select-outline.selected{opacity:.85}
        `}</style>
      </defs>
      {!doc.theme.transparent && (
        <rect
          width={layout.width}
          height={layout.height}
          fill={doc.theme.background}
        />
      )}

      {doc.metadata.showTitle && (
        <text
          x={titleX}
          y={layout.header.titleY}
          textAnchor={titleAnchor}
          className="rm-text rm-title"
        >
          {doc.metadata.title}
        </text>
      )}
      {doc.metadata.showSubtitle && (
        <text
          x={titleX}
          y={layout.header.subtitleY}
          textAnchor={titleAnchor}
          className="rm-text rm-subtitle"
        >
          {doc.metadata.subtitle}
        </text>
      )}

      {!empty && (
        <>
          <text
            x={doc.layout.outerMargin}
            y={topLabelY}
            className="rm-text rm-lane"
          >
            {doc.labels.usingNow}
          </text>
          <text
            x={doc.layout.outerMargin}
            y={bottomLabelY}
            className="rm-text rm-lane"
          >
            {doc.labels.replacedPlanned}
          </text>
          <path
            d={layout.paths.independent}
            fill="none"
            stroke={doc.theme.independent}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d={layout.paths.proprietary}
            fill="none"
            stroke={doc.theme.proprietary}
            strokeWidth="3"
            strokeLinecap="round"
          />
          {migrations.map((migration, index) => {
            const entries = laneEntries(migration, doc.timeline.viewDate);
            const geometry = layout.nodes[index];
            return (
              <g
                key={migration.id}
                className={interactive ? 'rm-interactive' : undefined}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={
                  interactive
                    ? `Edit ${migration.replacement.label || migration.source.label || migrationDisplayLabel(migration, doc.timeline.fullDateFormat)}`
                    : undefined
                }
                onClick={
                  interactive ? () => onSelect?.(migration.id) : undefined
                }
                onKeyDown={
                  interactive
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect?.(migration.id);
                        }
                      }
                    : undefined
                }
              >
                {interactive && (
                  <>
                    <rect
                      data-preview-only="true"
                      className={`rm-select-outline ${selectedId === migration.id ? 'selected' : ''}`}
                      x={
                        geometry.x -
                        Math.max(geometry.topWidth, geometry.bottomWidth) / 2 -
                        15
                      }
                      y={selectionTop}
                      width={
                        Math.max(geometry.topWidth, geometry.bottomWidth) + 30
                      }
                      height={selectionBottom - selectionTop}
                      rx="22"
                      fill={doc.theme.timeline}
                      fillOpacity=".055"
                      stroke={doc.theme.timeline}
                      strokeWidth="2"
                      strokeDasharray="7 7"
                    />
                    <rect
                      data-preview-only="true"
                      x={
                        geometry.x -
                        Math.max(geometry.topWidth, geometry.bottomWidth) / 2 -
                        15
                      }
                      y={selectionTop}
                      width={
                        Math.max(geometry.topWidth, geometry.bottomWidth) + 30
                      }
                      height={selectionBottom - selectionTop}
                      rx="22"
                      fill="transparent"
                      pointerEvents="all"
                    />
                  </>
                )}
                {doc.metadata.showCategories && (
                  <CategoryMarker
                    migration={migration}
                    x={geometry.x}
                    y={categoryY}
                    display={doc.metadata.categoryDisplay}
                    color={doc.theme.timeline}
                    geometry={marker}
                  />
                )}
                <RoadmapNode
                  entry={entries.top}
                  x={geometry.x}
                  y={layout.topY}
                  width={geometry.topWidth}
                  iconSize={doc.layout.iconSize}
                  active
                  category={entries.top.category}
                  index={`${migration.id}-top`}
                  theme={doc.theme}
                  type={type}
                />
                <RoadmapNode
                  entry={entries.bottom}
                  x={geometry.x}
                  y={layout.bottomY}
                  width={geometry.bottomWidth}
                  iconSize={doc.layout.iconSize}
                  active={false}
                  category={entries.bottom.category}
                  index={`${migration.id}-bottom`}
                  theme={doc.theme}
                  type={type}
                />
              </g>
            );
          })}

          <text
            x={doc.layout.outerMargin}
            y={layout.timelineY - type.timelineLabelOffset}
            className="rm-text rm-lane"
          >
            {doc.labels.timeline}
          </text>
          <line
            x1={layout.nodes[0].x}
            y1={layout.timelineY}
            x2={layout.nodes.at(-1)!.x}
            y2={layout.timelineY}
            stroke={doc.theme.timeline}
            strokeOpacity="0.45"
            strokeWidth="1.5"
          />
          {migrations.map((migration, index) => (
            <g key={`date-${migration.id}`} pointerEvents="none">
              <circle
                cx={layout.nodes[index].x}
                cy={layout.timelineY}
                r={4 * type.scale}
                fill={doc.theme.timeline}
              />
              <text
                x={layout.nodes[index].x}
                y={layout.timelineY + type.dateLabelOffset}
                textAnchor="middle"
                className="rm-text rm-date"
              >
                {migrationDisplayLabel(migration, doc.timeline.fullDateFormat)}
              </text>
            </g>
          ))}
          {layout.viewMarkerX !== undefined && doc.timeline.viewDate && (
            <g
              transform={`translate(${layout.viewMarkerX},${layout.timelineY})`}
            >
              <path
                d={`M 0 ${round(-8 * type.scale)} L ${round(-6 * type.scale)} ${round(-18 * type.scale)} H ${round(6 * type.scale)} Z`}
                fill={doc.theme.timeline}
              />
              <line
                y1={-8 * type.scale}
                y2={8 * type.scale}
                stroke={doc.theme.timeline}
                strokeWidth={2 * type.scale}
              />
              <text
                y={-25 * type.scale}
                textAnchor="middle"
                className="rm-text rm-now"
              >
                AS OF{' '}
                {formatNodeDate(doc.timeline.viewDate, 'date').toUpperCase()}
              </text>
            </g>
          )}

          {/* The second swatch clears the first label, which grows with the
                type, so the pair keeps its spacing at any text size. */}
          <g
            transform={`translate(${social ? layout.width / 2 - 215 * type.scale : doc.layout.outerMargin},${layout.legendY})`}
          >
            <circle r={type.legendDot} fill={doc.theme.independent} />
            <text
              x={type.legendDot + 13 * type.scale}
              y={7 * type.scale}
              className="rm-text rm-legend"
            >
              {doc.labels.independent}
            </text>
            <circle
              cx={legendSecondX(doc.labels.independent, type)}
              r={type.legendDot}
              fill={doc.theme.proprietary}
            />
            <text
              x={
                legendSecondX(doc.labels.independent, type) +
                type.legendDot +
                13 * type.scale
              }
              y={7 * type.scale}
              className="rm-text rm-legend"
            >
              {doc.labels.proprietary}
            </text>
          </g>
        </>
      )}

      {empty && (
        <g
          transform={`translate(${layout.width / 2},${layout.height / 2})`}
          textAnchor="middle"
          className={interactive ? 'rm-interactive' : undefined}
          role={interactive ? 'button' : undefined}
          tabIndex={interactive ? 0 : undefined}
          aria-label={interactive ? 'Add the first node' : undefined}
          onClick={interactive ? onAdd : undefined}
          onKeyDown={
            interactive
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onAdd?.();
                  }
                }
              : undefined
          }
        >
          <circle
            r="44"
            fill={doc.theme.independent}
            fillOpacity="0.08"
            stroke={doc.theme.independent}
            strokeWidth="2"
            strokeDasharray="5 7"
          />
          <text y="8" className="rm-text rm-title" style={{ fontSize: 30 }}>
            +
          </text>
          <text y="88" className="rm-text rm-subtitle">
            Add a node to begin your roadmap
          </text>
        </g>
      )}

      <BrandSignature
        right={layout.width - doc.layout.outerMargin}
        centerY={layout.brandY}
        size={type.brandMark}
        fontSize={type.brand}
      />

      {doc.layout.showSafeArea && (
        <rect
          data-preview-only="true"
          x={layout.width * 0.08}
          y={layout.height * 0.08}
          width={layout.width * 0.84}
          height={layout.height * 0.84}
          rx="18"
          fill="none"
          stroke={doc.theme.timeline}
          strokeWidth="2"
          strokeDasharray="12 10"
          opacity=".4"
        />
      )}
    </svg>
  );
}

// Cap height of the semi-bold face, as a share of font size.
const CAP_RATIO = 0.72;

// The invitation every export carries, bottom-right opposite the legend. It is
// not optional: the planner is free, and the signature is what it asks back.
// SVG cannot measure text before layout, so the block is right-aligned from an
// estimated width; the 0.6 factor matches the semi-bold face and keeps the
// label inside the margin.
function BrandSignature({
  right,
  centerY,
  size,
  fontSize,
}: {
  right: number;
  centerY: number;
  size: number;
  fontSize: number;
}) {
  const noteSize = fontSize * 0.62;
  const gap = size * 0.24;
  const textWidth = Math.max(
    BRAND_LABEL.length * fontSize * 0.6,
    BRAND_NOTE.length * noteSize * 0.6,
  );
  // The two lines are optically centred on the mark: the block runs from the
  // note's cap height down to the label's baseline (descenders are ignored, as
  // the eye does), so it is that midpoint which has to land on centerY.
  const lineGap = fontSize * 1.15;
  const noteBaseline = (noteSize * CAP_RATIO - lineGap) / 2;
  return (
    <g transform={`translate(${right - (size + gap + textWidth)},${centerY})`}>
      <IconImage
        icon={{
          id: 'my-own-suite-mark',
          name: 'My Own Suite',
          source: 'library',
        }}
        x={0}
        y={-size / 2}
        size={size}
        instance="brand-mos"
      />
      <text x={size + gap} y={noteBaseline} className="rm-text rm-brand-note">
        {BRAND_NOTE}
      </text>
      <text
        x={size + gap}
        y={noteBaseline + lineGap}
        className="rm-text rm-brand"
      >
        {BRAND_LABEL}
      </text>
    </g>
  );
}

const CATEGORY_ICON_COMPONENTS: Record<CategoryIconId, LucideIcon> = {
  home: HousePlug,
  image: ImageIcon,
  router: Router,
  calendar: CalendarDays,
  folder: Folder,
  office: BriefcaseBusiness,
  key: KeyRound,
  globe: Globe2,
  mail: Mail,
  message: MessageCircle,
  play: Play,
  notes: NotebookPen,
  storage: HardDrive,
  shield: ShieldCheck,
  wallet: WalletCards,
  health: HeartPulse,
  code: Code2,
  tag: Tag,
};

function CategoryMarker({
  migration,
  x,
  y,
  display,
  color,
  geometry,
}: {
  migration: Migration;
  x: number;
  y: number;
  display: RoadmapDocument['metadata']['categoryDisplay'];
  color: string;
  geometry: CategoryMarkerGeometry;
}) {
  const Glyph = CATEGORY_ICON_COMPONENTS[migration.categoryIcon] ?? Tag;
  const showIcon = display !== 'text';
  const showText = display !== 'icon' && Boolean(migration.categoryLabel);
  return (
    <g data-category-marker={migration.id}>
      {showText && (
        <text
          data-category-text="true"
          x={x}
          y={y - geometry.textBaseline}
          textAnchor="middle"
          className="rm-text rm-category"
        >
          {migration.categoryLabel}
        </text>
      )}
      {showIcon && (
        <Glyph
          data-category-icon="true"
          x={x - geometry.glyph / 2}
          y={y - geometry.iconTop}
          width={geometry.glyph}
          height={geometry.glyph}
          color={color}
          strokeWidth={1.7}
        />
      )}
    </g>
  );
}

function RoadmapNode({
  entry,
  x,
  y,
  width,
  iconSize,
  active,
  category,
  index,
  theme,
  type,
}: {
  entry: ServiceEntry;
  x: number;
  y: number;
  width: number;
  iconSize: number;
  active: boolean;
  category: Category;
  index: string;
  theme: RoadmapDocument['theme'];
  type: RoadmapMetrics;
}) {
  const color =
    category === 'independent' ? theme.independent : theme.proprietary;
  const icons = entry.icons;
  const actualIconSize = icons.length > 1 ? iconSize * 0.7 : iconSize;
  const groupWidth = Math.max(
    actualIconSize,
    icons.length * actualIconSize + Math.max(0, icons.length - 1) * 7,
  );
  const start = x - groupWidth / 2;
  return (
    <g>
      <rect
        x={x - width / 2}
        y={y - 38}
        width={width}
        height="76"
        rx="38"
        fill={theme.background}
        stroke={color}
        strokeWidth={active ? 3 : 2.5}
      />
      {icons.length ? (
        icons.map((icon, iconIndex) => (
          <IconImage
            key={`${icon.id}-${iconIndex}`}
            icon={icon}
            x={start + iconIndex * (actualIconSize + 7)}
            y={y - actualIconSize / 2}
            size={actualIconSize}
            instance={`${index}-${iconIndex}`}
            muted={!active}
          />
        ))
      ) : (
        <FallbackIcon x={x} y={y} color={color} muted={!active} />
      )}
      <Label
        text={entry.label}
        x={x}
        y={y + type.nodeLabelOffset}
        lineHeight={type.nodeLabelLine}
        muted={!active}
      />
    </g>
  );
}

function IconImage({
  icon,
  x,
  y,
  size,
  instance,
  muted = false,
}: {
  icon: IconRef;
  x: number;
  y: number;
  size: number;
  instance: string;
  muted?: boolean;
}) {
  const url =
    icon.source === 'library'
      ? libraryIconDataUrl(icon.id, instance)
      : icon.dataUrl;
  if (!url)
    return (
      <FallbackIcon
        x={x + size / 2}
        y={y + size / 2}
        color="#8c9593"
        muted={muted}
      />
    );
  return (
    <image
      href={url}
      x={x}
      y={y}
      width={size}
      height={size}
      opacity={muted ? 0.57 : 1}
      preserveAspectRatio="xMidYMid meet"
    />
  );
}

function FallbackIcon({
  x,
  y,
  color,
  muted,
}: {
  x: number;
  y: number;
  color: string;
  muted: boolean;
}) {
  return (
    <g opacity={muted ? 0.4 : 1}>
      <circle cx={x} cy={y} r="17" fill="none" stroke={color} strokeWidth="2" />
      <path
        d={`M${x - 7} ${y}h14M${x} ${y - 7}v14`}
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </g>
  );
}

function Label({
  text,
  x,
  y,
  lineHeight,
  muted,
}: {
  text: string;
  x: number;
  y: number;
  lineHeight: number;
  muted: boolean;
}) {
  const lines = splitLabel(text);
  // A multi-line label stays optically centred on the same point a one-line
  // label would sit at, so lanes keep their rhythm.
  const startY = y - (Math.max(0, lines.length - 1) * lineHeight) / 2;
  return (
    <text
      x={x}
      y={startY}
      textAnchor="middle"
      className="rm-text rm-node-label"
      opacity={muted ? 0.67 : 1}
    >
      {lines.map((line, index) => (
        <tspan key={index} x={x} dy={index ? lineHeight : 0}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

const round = (value: number) => Math.round(value * 10) / 10;
