import type { CategoryIconId } from '@/lib/category-icons';
import { libraryIconDataUrl } from '@/lib/icon-library';
import { computeLayout, splitLabel } from '@/lib/roadmap-layout';
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
import { forwardRef, useMemo } from 'react';
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
  className?: string;
  interactive?: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
}

export const RoadmapCanvas = forwardRef<SVGSVGElement, Props>(
  function RoadmapCanvas(
    { document: doc, className, interactive = false, selectedId, onSelect },
    ref,
  ) {
    const layout = useMemo(() => computeLayout(doc), [doc]);
    const migrations = useMemo(
      () => chronologicalMigrations(doc.migrations),
      [doc.migrations],
    );
    const social = layout.height >= 1400;
    const titleX = layout.header.centered
      ? layout.width / 2
      : doc.layout.outerMargin;
    const titleAnchor = layout.header.centered ? 'middle' : 'start';
    const topLabelY = layout.topY - 66;
    const bottomLabelY = layout.bottomY - 66;
    const categoryY = layout.topY - 106;
    const selectionTop = doc.metadata.showCategories
      ? categoryY - 56
      : layout.topY - 54;
    const selectionBottom = layout.timelineY + 54;
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
          .rm-text{font-family:Inter,"Segoe UI",Arial,sans-serif}.rm-title{font-size:${social ? 64 : 52}px;font-weight:760;letter-spacing:-1.7px;fill:${doc.theme.text}}.rm-subtitle{font-size:${social ? 22 : 18}px;fill:${doc.theme.secondaryText}}.rm-lane{font-size:14px;font-weight:800;letter-spacing:1.5px;fill:${doc.theme.text}}.rm-category{font-size:${social ? 15 : 12}px;font-weight:760;fill:${doc.theme.text}}.rm-node-label{font-size:${social ? 14 : 13}px;font-weight:620;fill:${doc.theme.secondaryText}}.rm-date{font-size:13px;font-weight:750;fill:${doc.theme.text}}.rm-now{font-size:10px;font-weight:850;letter-spacing:.8px;fill:${doc.theme.timeline}}.rm-legend{font-size:${social ? 22 : 14}px;font-weight:780;fill:${doc.theme.text}}.rm-brand{font-size:27px;font-weight:760;fill:${doc.theme.text}}.rm-interactive{cursor:pointer;outline:none}.rm-select-outline{opacity:0;transition:opacity .12s}.rm-interactive:hover .rm-select-outline,.rm-interactive:focus .rm-select-outline{opacity:.55}.rm-select-outline.selected{opacity:.85}
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
                      ? `Edit ${migration.replacement.label || migration.source.label || migration.timeLabel}`
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
                          Math.max(geometry.topWidth, geometry.bottomWidth) /
                            2 -
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
                          Math.max(geometry.topWidth, geometry.bottomWidth) /
                            2 -
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
                  />
                </g>
              );
            })}

            <text
              x={doc.layout.outerMargin}
              y={layout.timelineY - 16}
              className="rm-text rm-lane"
            >
              {doc.labels.timeline}
            </text>
            <line
              x1={layout.nodes[0].x}
              y1={layout.timelineY}
              x2={layout.nodes.at(-1)!.x}
              y2={layout.timelineY}
              stroke={doc.theme.secondaryText}
              strokeOpacity="0.35"
              strokeWidth="1.5"
            />
            {migrations.map((migration, index) => (
              <g key={`date-${migration.id}`} pointerEvents="none">
                <circle
                  cx={layout.nodes[index].x}
                  cy={layout.timelineY}
                  r="4"
                  fill={doc.theme.timeline}
                />
                <text
                  x={layout.nodes[index].x}
                  y={layout.timelineY + 36}
                  textAnchor="middle"
                  className="rm-text rm-date"
                >
                  {migrationDisplayLabel(
                    migration,
                    doc.timeline.dateDisplay,
                    doc.timeline.fullDateFormat,
                  )}
                </text>
              </g>
            ))}
            {layout.viewMarkerX !== undefined && (
              <g
                transform={`translate(${layout.viewMarkerX},${layout.timelineY})`}
              >
                <path d="M 0 -8 L -6 -18 H 6 Z" fill={doc.theme.timeline} />
                <line
                  y1="-8"
                  y2="8"
                  stroke={doc.theme.timeline}
                  strokeWidth="2"
                />
                <text y="-25" textAnchor="middle" className="rm-text rm-now">
                  AS OF{' '}
                  {formatNodeDate(doc.timeline.viewDate, 'date').toUpperCase()}
                </text>
              </g>
            )}

            <g
              transform={`translate(${social ? layout.width / 2 - 215 : doc.layout.outerMargin},${layout.legendY})`}
            >
              <circle r={social ? 12 : 9} fill={doc.theme.independent} />
              <text x={social ? 28 : 22} y={7} className="rm-text rm-legend">
                {doc.labels.independent}
              </text>
              <circle
                cx={social ? 250 : 190}
                r={social ? 12 : 9}
                fill={doc.theme.proprietary}
              />
              <text x={social ? 278 : 212} y={7} className="rm-text rm-legend">
                {doc.labels.proprietary}
              </text>
            </g>
          </>
        )}

        {empty && (
          <g
            transform={`translate(${layout.width / 2},${layout.height / 2})`}
            textAnchor="middle"
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

        {social && doc.branding.myOwnSuite && (
          <g
            transform={`translate(${layout.width - 390},${layout.height - 185})`}
          >
            <IconImage
              icon={{
                id: 'my-own-suite-mark',
                name: 'My Own Suite',
                source: 'library',
              }}
              x={0}
              y={0}
              size={62}
              instance="brand-mos"
            />
            <text x="78" y="42" className="rm-text rm-brand">
              {doc.branding.siteLabel}
            </text>
          </g>
        )}

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
  },
);

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
}: {
  migration: Migration;
  x: number;
  y: number;
  display: RoadmapDocument['metadata']['categoryDisplay'];
  color: string;
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
          y={showIcon ? y - 43 : y - 16}
          textAnchor="middle"
          className="rm-text rm-category"
        >
          {migration.categoryLabel}
        </text>
      )}
      {showIcon && (
        <Glyph
          data-category-icon="true"
          x={x - 11}
          y={y - 34}
          width={22}
          height={22}
          color={color}
          strokeWidth={1.8}
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
      <Label text={entry.label} x={x} y={y + 78} muted={!active} />
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
      opacity={muted ? 0.62 : 1}
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
    <g opacity={muted ? 0.45 : 1}>
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
  muted,
}: {
  text: string;
  x: number;
  y: number;
  muted: boolean;
}) {
  const lines = splitLabel(text);
  const startY = y - Math.max(0, lines.length - 1) * 8;
  return (
    <text
      x={x}
      y={startY}
      textAnchor="middle"
      className="rm-text rm-node-label"
      opacity={muted ? 0.72 : 1}
    >
      {lines.map((line, index) => (
        <tspan key={index} x={x} dy={index ? 17 : 0}>
          {line}
        </tspan>
      ))}
    </text>
  );
}
