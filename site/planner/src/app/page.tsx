import { RoadmapCanvas } from '@/components/roadmap-canvas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  createDashboardIcon,
  dashboardIconUrl,
  loadDashboardIcons,
  loadIconVariantIndex,
  type DashboardIcon,
} from '@/lib/dashboard-icon-library';
import { CATEGORY_ICONS, type CategoryIconId } from '@/lib/category-icons';
import {
  applyIconArtwork,
  resolveMissingIconArtwork,
} from '@/lib/icon-hydration';
import { svgTextToDataUrl } from '@/lib/icon-library';
import {
  createMosAppIcon,
  mosAppDocsUrl,
  mosAppIconUrl,
  mosAppMatchesQuery,
  mosApps,
  mosAppsForIcons,
  type MosApp,
} from '@/lib/mos-catalog';
import { computeLayout } from '@/lib/roadmap-layout';
import {
  downloadText,
  rasterizeSvg,
  serializeRoadmapSvg,
  type RasterFormat,
} from '@/lib/roadmap-export';
import {
  loadLocalRoadmap,
  roadmapJson,
  saveLocalRoadmap,
} from '@/lib/roadmap-persistence';
import { shareUrlFor, takePendingSharedRoadmap } from '@/lib/share-link';
import {
  CANVAS_THEMES,
  canvasSchemeFor,
  cloneRoadmap,
  createMigration,
  formatNodeDate,
  initialRoadmap,
  migrationDisplayLabel,
  migrationIsReached,
  migrationPeriodKey,
  presets,
  quarterStartDate,
  todayIsoDate,
  uniqueId,
  validateRoadmap,
  type CanvasTheme,
  type IconRef,
  type Migration,
  type RoadmapDocument,
} from '@/lib/roadmap-model';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileDown,
  FileUp,
  Focus,
  Eye,
  ImageDown,
  LayoutTemplate,
  Link2,
  Minus,
  MonitorUp,
  Pencil,
  Plus,
  Library,
  Redo2,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type InspectorTab = 'migration' | 'design';
type ConfirmAction = {
  title: string;
  description: string;
  action: () => void;
} | null;

// Read once at module scope: it consumes the #plan= fragment, and React
// StrictMode would otherwise run a state initializer twice and lose it.
const pendingShared = takePendingSharedRoadmap();

export default function Home() {
  const [history, setHistory] = useState(() => {
    const local = loadLocalRoadmap();
    return pendingShared
      ? { past: [local], present: pendingShared, future: [] as RoadmapDocument[] }
      : { past: [] as RoadmapDocument[], present: local, future: [] as RoadmapDocument[] };
  });
  const doc = history.present;
  const [selectedId, setSelectedId] = useState(doc.migrations[0]?.id ?? '');
  const [mode, setMode] = useState<'edit' | 'view'>('edit');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('migration');
  const [zoom, setZoom] = useState(0.56);
  const [saveState, setSaveState] = useState<'saving' | 'saved'>('saved');
  const [notice, setNotice] = useState(
    pendingShared
      ? 'Shared plan loaded — your own work is one Undo away.'
      : '',
  );
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const hydrationAttempts = useRef(new Set<string>());
  const layout = useMemo(() => computeLayout(doc), [doc]);
  const selectedIndex = doc.migrations.findIndex(
    (item) => item.id === selectedId,
  );
  const selected =
    selectedIndex >= 0 ? doc.migrations[selectedIndex] : undefined;

  useEffect(() => {
    const timer = setTimeout(() => {
      saveLocalRoadmap(doc);
      setSaveState('saved');
    }, 350);
    return () => clearTimeout(timer);
  }, [doc]);

  // Icons referenced by id (starter plan, shared links, denylist survivors)
  // get their artwork embedded from the first-party sets. Applied onto the
  // latest document so an edit made mid-fetch is never lost, and without a
  // history entry so it cannot be "undone".
  useEffect(() => {
    let active = true;
    resolveMissingIconArtwork(doc, hydrationAttempts.current).then(
      (artwork) => {
        if (!active || !artwork) return;
        setHistory((current) => {
          const next = applyIconArtwork(current.present, artwork);
          return next ? { ...current, present: next } : current;
        });
      },
    );
    return () => {
      active = false;
    };
  }, [doc]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  const commit = useCallback((recipe: (draft: RoadmapDocument) => void) => {
    setSaveState('saving');
    setHistory((current) => {
      const next = cloneRoadmap(current.present);
      recipe(next);
      return {
        past: [...current.past.slice(-79), current.present],
        present: next,
        future: [],
      };
    });
  }, []);

  const undo = () => {
    setSaveState('saving');
    setHistory((current) => {
      if (!current.past.length) return current;
      const present = current.past.at(-1)!;
      return {
        past: current.past.slice(0, -1),
        present,
        future: [current.present, ...current.future],
      };
    });
  };
  const redo = () => {
    setSaveState('saving');
    setHistory((current) => {
      if (!current.future.length) return current;
      return {
        past: [...current.past, current.present],
        present: current.future[0],
        future: current.future.slice(1),
      };
    });
  };

  const updateSelected = (recipe: (item: Migration) => void) => {
    if (selectedIndex < 0) return;
    commit((draft) => recipe(draft.migrations[selectedIndex]));
  };

  const addMigration = () => {
    const item = createMigration();
    commit((draft) => draft.migrations.push(item));
    setSelectedId(item.id);
    setInspectorTab('migration');
  };

  const duplicateSelected = () => {
    if (!selected) return;
    const copy = structuredClone(selected);
    copy.id = uniqueId();
    copy.source.label = copy.source.label
      ? `${copy.source.label} copy`
      : 'Big Tech apps copy';
    commit((draft) => draft.migrations.splice(selectedIndex + 1, 0, copy));
    setSelectedId(copy.id);
  };

  const removeSelected = () => {
    if (!selected) return;
    setConfirmAction({
      title: `Remove “${selected.replacement.label || selected.source.label || 'untitled node'}”?`,
      description:
        'This removes the node from the roadmap. You can still undo the change afterward.',
      action: () => {
        const nextId =
          doc.migrations[selectedIndex + 1]?.id ??
          doc.migrations[selectedIndex - 1]?.id ??
          '';
        commit((draft) => draft.migrations.splice(selectedIndex, 1));
        setSelectedId(nextId);
      },
    });
  };

  const moveSelectedWithinPeriod = (direction: -1 | 1) => {
    if (!selected) return;
    commit((draft) => {
      const index = draft.migrations.findIndex(
        (item) => item.id === selectedId,
      );
      if (index < 0) return;
      const key = migrationPeriodKey(draft.migrations[index]);
      const peerIndexes = draft.migrations
        .map((item, itemIndex) => ({ item, itemIndex }))
        .filter(({ item }) => migrationPeriodKey(item) === key)
        .map(({ itemIndex }) => itemIndex);
      const peerPosition = peerIndexes.indexOf(index);
      const targetIndex = peerIndexes[peerPosition + direction];
      if (targetIndex === undefined) return;
      [draft.migrations[index], draft.migrations[targetIndex]] = [
        draft.migrations[targetIndex],
        draft.migrations[index],
      ];
    });
  };

  const fitPreview = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setZoom(
      Math.min(1.1, Math.max(0.12, (viewport.clientWidth - 64) / layout.width)),
    );
  }, [layout.width]);

  useEffect(() => {
    fitPreview();
  }, [fitPreview, mode]);

  const applyPreset = (key: keyof typeof presets) => {
    const preset = presets[key];
    commit((draft) => Object.assign(draft, preset.apply(draft)));
    setNotice(`${preset.label} preset applied`);
  };

  const exportGraphic = async (format: 'svg' | RasterFormat) => {
    if (!svgRef.current) return;
    try {
      if (format === 'svg')
        downloadText(
          serializeRoadmapSvg(svgRef.current),
          `${doc.export.filename}.svg`,
          'image/svg+xml',
        );
      else await rasterizeSvg(svgRef.current, format, doc.export.filename);
      setNotice(
        `${format.toUpperCase()} exported at ${layout.width} × ${layout.height}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Export failed.');
    }
  };

  const shareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrlFor(doc));
      setNotice('Link copied — anyone can open and remix this plan.');
    } catch {
      setNotice('The link could not be copied to the clipboard.');
    }
  };

  const importJson = async (file?: File) => {
    if (!file) return;
    try {
      const result = validateRoadmap(JSON.parse(await file.text()));
      if (!result.ok) {
        setNotice(result.errors.slice(0, 2).join(' '));
        return;
      }
      setHistory((current) => ({
        past: [...current.past, current.present],
        present: result.value,
        future: [],
      }));
      setSaveState('saving');
      setSelectedId(result.value.migrations[0]?.id ?? '');
      setNotice('Roadmap loaded successfully');
    } catch {
      setNotice('That file is not valid JSON. Nothing was changed.');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const saveJson = () =>
    downloadText(
      roadmapJson(doc),
      `${doc.export.filename}.json`,
      'application/json',
    );

  const uploadIcon = async (
    file: File | undefined,
    side: 'source' | 'replacement' = 'replacement',
  ) => {
    if (!file || !selected) return;
    if (!['image/svg+xml', 'image/png'].includes(file.type)) {
      setNotice('Choose an SVG or PNG icon.');
      return;
    }
    if (file.size > 1_500_000) {
      setNotice('Please keep icon files below 1.5 MB.');
      return;
    }
    try {
      const dataUrl =
        file.type === 'image/svg+xml'
          ? svgTextToDataUrl(await file.text(), uniqueId('svg'))
          : await readAsDataUrl(file);
      const icon: IconRef = {
        id: uniqueId('upload'),
        name: file.name.replace(/\.[^.]+$/, ''),
        source: 'upload',
        dataUrl,
      };
      updateSelected((item) => {
        const previousNames = item[side].icons.map((entry) => entry.name);
        const keepInSync =
          !item[side].label || item[side].label === appLabel(previousNames);
        item[side].icons.push(icon);
        if (keepInSync)
          item[side].label = appLabel([...previousNames, icon.name]);
      });
      setNotice(
        `${icon.name} added to ${side === 'source' ? 'Big Tech' : 'Open Source'}`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The icon could not be read.',
      );
    }
  };

  return (
    <main className="roadmap-app">
      <header className="topbar">
        <div className="topbar-row">
          <a className="brand-lockup" href="https://myownsuite.org/">
            <img src="/brand/my-own-suite-mark.svg" alt="" />
            <div>
              <strong>Digital Independence Planner</strong>
              <small>Free & private · by My Own Suite</small>
            </div>
          </a>
          <div className="toolbar-actions">
            {mode === 'edit' && (
              <>
                <input
                  ref={importRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(event) => importJson(event.target.files?.[0])}
                />
                <Button
                  variant="outline"
                  className="wide-only"
                  onClick={() => importRef.current?.click()}
                >
                  <FileUp /> Load
                </Button>
                <Button variant="outline" className="wide-only" onClick={saveJson}>
                  <Save /> Save JSON
                </Button>
              </>
            )}
            <Button variant="outline" onClick={shareLink}>
              <Link2 /> Share link
            </Button>
            <div className="export-menu">
              <Button
                className="export-main"
                onClick={() => exportGraphic('png')}
              >
                <Download /> Export PNG
              </Button>
              <details>
                <summary aria-label="More export formats">
                  <ChevronDown />
                </summary>
                <div className="export-popover">
                  <button onClick={() => exportGraphic('svg')}>
                    <FileDown /> Editable SVG{' '}
                    <small>Self-contained vector</small>
                  </button>
                  <button onClick={() => exportGraphic('png')}>
                    <ImageDown /> PNG <small>Exact-size lossless</small>
                  </button>
                  <button onClick={() => exportGraphic('webp')}>
                    <ImageDown /> WebP <small>Compact social image</small>
                  </button>
                </div>
              </details>
            </div>
          </div>
        </div>
        <div className="topbar-row topbar-controls">
          <div className="mode-switch" aria-label="Workspace mode">
            <button
              className={mode === 'edit' ? 'active' : ''}
              onClick={() => setMode('edit')}
            >
              <Pencil /> Edit
            </button>
            <button
              className={mode === 'view' ? 'active' : ''}
              onClick={() => setMode('view')}
            >
              <Eye /> View
            </button>
          </div>
          <div className="view-date-control">
            <CalendarDays aria-hidden="true" />
            <label>
              <span>View as of</span>
              <input
                type="date"
                value={doc.timeline.viewDate}
                onChange={(event) =>
                  commit((draft) => {
                    draft.timeline.viewDate = event.target.value;
                  })
                }
                aria-label="View timeline as of date"
              />
            </label>
            <button
              onClick={() =>
                commit((draft) => {
                  draft.timeline.viewDate = todayIsoDate();
                })
              }
            >
              Today
            </button>
          </div>
          {mode === 'edit' && (
            <div className="edit-history">
              <Button
                variant="ghost"
                size="icon"
                onClick={undo}
                disabled={!history.past.length}
                aria-label="Undo"
              >
                <Undo2 />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={redo}
                disabled={!history.future.length}
                aria-label="Redo"
              >
                <Redo2 />
              </Button>
              <span className={`save-state ${saveState}`}>
                <Check /> {saveState === 'saved' ? 'Saved locally' : 'Saving…'}
              </span>
            </div>
          )}
        </div>
      </header>

      <section className={`workspace ${mode}-mode`}>
        <section className="stage-panel">
          <div className="stage-toolbar">
            {mode === 'edit' ? (
              <div className="preset-row">
                <LayoutTemplate />
                <select
                  aria-label="Apply an export preset"
                  defaultValue=""
                  onChange={(event) => {
                    if (event.target.value)
                      applyPreset(event.target.value as keyof typeof presets);
                    event.target.value = '';
                  }}
                >
                  <option value="" disabled>
                    Apply preset…
                  </option>
                  {Object.entries(presets).map(([key, preset]) => (
                    <option key={key} value={key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <span className="canvas-size">
                  {layout.width} × {layout.height} px
                </span>
                {layout.grew && (
                  <span className="growth-note">
                    Auto-grown to prevent collisions
                  </span>
                )}
              </div>
            ) : (
              <div className="view-mode-caption">
                <Eye /> Clean view
              </div>
            )}
            <div className="zoom-controls">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setZoom((value) => Math.max(0.1, value - 0.1))}
                aria-label="Zoom out"
              >
                <Minus />
              </Button>
              <button className="zoom-value" onClick={fitPreview}>
                {Math.round(zoom * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setZoom((value) => Math.min(2, value + 0.1))}
                aria-label="Zoom in"
              >
                <ZoomIn />
              </Button>
              <Button variant="outline" size="sm" onClick={fitPreview}>
                <Focus /> Fit
              </Button>
            </div>
          </div>
          <div
            ref={viewportRef}
            className={`preview-viewport ${doc.layout.simulateSquareCrop ? 'square-crop' : ''}`}
          >
            {mode === 'edit' && (
              <div className="canvas-edit-bar">
                <span>
                  <Pencil /> Click any node on the canvas to edit it
                </span>
                <Button size="sm" onClick={addMigration}>
                  <Plus /> Add node
                </Button>
              </div>
            )}
            <div
              className="canvas-shadow"
              style={{
                width: layout.width * zoom,
                height: layout.height * zoom,
              }}
            >
              <RoadmapCanvas
                ref={svgRef}
                document={doc}
                className="roadmap-svg"
                interactive={mode === 'edit'}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setInspectorTab('migration');
                }}
              />
            </div>
          </div>
          <div className="stage-footer">
            <span>
              <MonitorUp /> Viewing as of{' '}
              <strong>{formatNodeDate(doc.timeline.viewDate, 'date')}</strong>
            </span>
            <div className="stage-footer-end">
              <span>
                {layout.crossoverIntervals.length} crossover
                {layout.crossoverIntervals.length === 1 ? '' : 's'} ·{' '}
                {
                  doc.migrations.filter((item) =>
                    migrationIsReached(item, doc.timeline.viewDate),
                  ).length
                }{' '}
                switched ·{' '}
                {
                  doc.migrations.filter(
                    (item) => !migrationIsReached(item, doc.timeline.viewDate),
                  ).length
                }{' '}
                planned
              </span>
              {mode === 'edit' && (
                <button
                  className="reset-button"
                  onClick={() =>
                    setConfirmAction({
                      title: 'Reset the entire roadmap?',
                      description:
                        'This restores the starter roadmap, theme, and labels. Your current work can only be recovered from a JSON backup.',
                      action: () => {
                        const fresh = cloneRoadmap(initialRoadmap);
                        setSaveState('saving');
                        setHistory((current) => ({
                          past: [...current.past, current.present],
                          present: fresh,
                          future: [],
                        }));
                        setSelectedId(fresh.migrations[0].id);
                      },
                    })
                  }
                >
                  <RotateCcw /> Reset to starter plan
                </button>
              )}
            </div>
          </div>
        </section>

        {mode === 'edit' && (
          <aside className="inspector-panel">
            <div className="inspector-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={inspectorTab === 'migration'}
                className={inspectorTab === 'migration' ? 'active' : ''}
                onClick={() => setInspectorTab('migration')}
              >
                Node
              </button>
              <button
                role="tab"
                aria-selected={inspectorTab === 'design'}
                className={inspectorTab === 'design' ? 'active' : ''}
                onClick={() => setInspectorTab('design')}
              >
                Design
              </button>
            </div>
            {inspectorTab === 'migration' ? (
              selected ? (
                <MigrationInspector
                  migration={selected}
                  update={updateSelected}
                  onDuplicate={duplicateSelected}
                  onDelete={removeSelected}
                  onUpload={uploadIcon}
                  setNotice={setNotice}
                  viewDate={doc.timeline.viewDate}
                  fullDateFormat={doc.timeline.fullDateFormat}
                  migrations={doc.migrations}
                  onMoveEarlier={() => moveSelectedWithinPeriod(-1)}
                  onMoveLater={() => moveSelectedWithinPeriod(1)}
                  canvasScheme={canvasSchemeFor(doc.theme.background)}
                />
              ) : (
                <div className="inspector-empty">
                  <Settings2 />
                  <h3>No node selected</h3>
                  <p>Add a node or select one from the roadmap.</p>
                  <Button onClick={addMigration}>
                    <Plus /> Add node
                  </Button>
                </div>
              )
            ) : (
              <DesignInspector
                doc={doc}
                commit={commit}
                advancedOpen={advancedOpen}
                setAdvancedOpen={setAdvancedOpen}
              />
            )}
          </aside>
        )}
      </section>

      <footer className="app-footnote">
        <span>
          <ShieldCheck /> Runs entirely in your browser — your plan never
          leaves your device.
        </span>
        <span>
          Icon artwork from the open-source{' '}
          <a
            href="https://github.com/homarr-labs/dashboard-icons"
            rel="noopener noreferrer"
            target="_blank"
          >
            Dashboard Icons
          </a>{' '}
          project, served from this site. All product names and logos are
          property of their respective owners and appear for identification
          only.
        </span>
      </footer>

      {notice && (
        <output className="toast">
          <Check />
          {notice}
          <button onClick={() => setNotice('')} aria-label="Dismiss">
            <X />
          </button>
        </output>
      )}
      <AlertDialog
        open={Boolean(confirmAction)}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                confirmAction?.action();
                setConfirmAction(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function MigrationInspector({
  migration,
  update,
  onDuplicate,
  onDelete,
  onUpload,
  setNotice,
  viewDate,
  fullDateFormat,
  migrations,
  onMoveEarlier,
  onMoveLater,
  canvasScheme,
}: {
  migration: Migration;
  update: (recipe: (item: Migration) => void) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onUpload: (file: File | undefined, side: 'source' | 'replacement') => void;
  setNotice: (message: string) => void;
  viewDate: string;
  fullDateFormat: RoadmapDocument['timeline']['fullDateFormat'];
  migrations: Migration[];
  onMoveEarlier: () => void;
  onMoveLater: () => void;
  canvasScheme: 'light' | 'dark';
}) {
  const reached = migrationIsReached(migration, viewDate);
  const usingSide = reached ? 'replacement' : 'source';
  const otherSide = reached ? 'source' : 'replacement';
  return (
    <div className="inspector-scroll node-editor">
      <section className="inspector-section compact">
        <div className="section-title">
          <div>
            <p className="eyebrow">SELECTED NODE</p>
            <h2>
              {migration.replacement.label.replace(/\n/g, ' ') ||
                migration.source.label.replace(/\n/g, ' ') ||
                'New roadmap node'}
            </h2>
          </div>
          <span className={`status-badge ${reached ? 'completed' : 'planned'}`}>
            {reached ? 'Using open source' : 'Planned'}
          </span>
        </div>
        <p className="node-help">
          Set the date and both app groups. The viewing date handles lane
          placement and the crossover automatically.
        </p>
      </section>
      <CategoryEditor migration={migration} update={update} />
      <AppChooser
        side={usingSide}
        entry={migration[usingSide]}
        step="2"
        eyebrow="USING NOW"
        heading="Apps used at the viewing date"
        update={update}
        onUpload={onUpload}
        setNotice={setNotice}
        canvasScheme={canvasScheme}
      />
      <AppChooser
        side={otherSide}
        entry={migration[otherSide]}
        step="3"
        eyebrow="REPLACED / PLANNED"
        heading={reached ? 'Apps this switch replaced' : 'Apps planned next'}
        update={update}
        onUpload={onUpload}
        setNotice={setNotice}
        canvasScheme={canvasScheme}
      />
      <FlexibleTimelineEditor
        migration={migration}
        migrations={migrations}
        update={update}
        viewDate={viewDate}
        fullDateFormat={fullDateFormat}
        onMoveEarlier={onMoveEarlier}
        onMoveLater={onMoveLater}
      />
      <section className="inspector-section item-actions">
        <Button variant="outline" onClick={onDuplicate}>
          <Copy /> Duplicate node
        </Button>
        <Button variant="destructive" onClick={onDelete}>
          <Trash2 /> Remove
        </Button>
      </section>
    </div>
  );
}

function CategoryEditor({
  migration,
  update,
}: {
  migration: Migration;
  update: (recipe: (item: Migration) => void) => void;
}) {
  return (
    <section className="app-group category-group">
      <div className="app-group-heading">
        <span className="step-number">1</span>
        <div>
          <p className="eyebrow">CATEGORY · OPTIONAL</p>
          <h3>What kind of switch is this?</h3>
        </div>
      </div>
      <div className="field-row">
        <Field label="Category label">
          <Input
            value={migration.categoryLabel}
            onChange={(event) =>
              update((item) => {
                item.categoryLabel = event.target.value;
              })
            }
            placeholder="e.g. Smart home"
          />
        </Field>
        <Field label="Generic icon">
          <select
            value={migration.categoryIcon}
            onChange={(event) =>
              update((item) => {
                item.categoryIcon = event.target.value as CategoryIconId;
              })
            }
          >
            {CATEGORY_ICONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="category-help">
        Leave the label empty to omit this category from the graphic.
      </p>
    </section>
  );
}

function FlexibleTimelineEditor({
  migration,
  migrations,
  update,
  viewDate,
  fullDateFormat,
  onMoveEarlier,
  onMoveLater,
}: {
  migration: Migration;
  migrations: Migration[];
  update: (recipe: (item: Migration) => void) => void;
  viewDate: string;
  fullDateFormat: RoadmapDocument['timeline']['fullDateFormat'];
  onMoveEarlier: () => void;
  onMoveLater: () => void;
}) {
  const precision = migration.displayPrecision || migration.datePrecision;
  const referenceDate = migration.date || viewDate || todayIsoDate();
  const year = Number(referenceDate.slice(0, 4));
  const month = Number(referenceDate.slice(5, 7)) || 1;
  const quarter = (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  const periodKey = migrationPeriodKey(migration);
  const peers = migrations.filter(
    (item) => migrationPeriodKey(item) === periodKey,
  );
  const peerPosition = peers.findIndex((item) => item.id === migration.id);
  const shownLabel = migrationDisplayLabel(
    migration,
    'quarter',
    fullDateFormat,
  );

  const choosePrecision = (nextPrecision: Migration['datePrecision']) =>
    update((item) => {
      item.useFlexibleDate = true;
      item.displayPrecision = nextPrecision;
      if (!item.date && nextPrecision !== 'date') {
        item.date = `${year}-01-01`;
        item.datePrecision = nextPrecision;
        item.timeLabel = formatNodeDate(item.date, nextPrecision);
      }
    });

  const setYear = (nextYear: number) =>
    update((item) => {
      const suffix =
        item.date && item.datePrecision === 'date'
          ? item.date.slice(4)
          : '-01-01';
      item.date = `${nextYear}${suffix}`;
      if (item.datePrecision !== 'date') item.datePrecision = 'year';
      item.displayPrecision = 'year';
      item.useFlexibleDate = true;
      item.timeLabel = formatNodeDate(item.date, item.datePrecision);
    });

  const setQuarter = (nextQuarter: 1 | 2 | 3 | 4) =>
    update((item) => {
      const currentQuarter = item.date
        ? Math.floor((Number(item.date.slice(5, 7)) - 1) / 3) + 1
        : undefined;
      if (item.datePrecision !== 'date' || currentQuarter !== nextQuarter) {
        item.date = quarterStartDate(year, nextQuarter);
        item.datePrecision = 'quarter';
      }
      item.displayPrecision = 'quarter';
      item.useFlexibleDate = true;
      item.timeLabel = formatNodeDate(item.date, item.datePrecision);
    });

  const setExactDate = (date: string) =>
    update((item) => {
      item.date = date;
      item.datePrecision = 'date';
      item.displayPrecision = 'date';
      item.useFlexibleDate = true;
      item.timeLabel = formatNodeDate(date, 'date');
    });

  return (
    <section className="app-group flexible-date-group">
      <div className="app-group-heading">
        <span className="step-number">4</span>
        <div>
          <p className="eyebrow">TIMELINE & ORDER</p>
          <h3>When should this appear?</h3>
        </div>
        <span className="date-summary">{shownLabel}</span>
      </div>

      <div className="flexible-label">DATE SHOWN</div>
      <div className="flexible-precision" aria-label="Date shown">
        {(
          [
            ['year', 'Year'],
            ['quarter', 'Year + quarter'],
            ['date', 'Full date'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={precision === value ? 'active' : ''}
            aria-pressed={precision === value}
            onClick={() => choosePrecision(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {precision === 'year' && (
        <Field label="Year">
          <Input
            type="number"
            min={1900}
            max={2200}
            value={year}
            onChange={(event) =>
              setYear(
                Math.min(
                  2200,
                  Math.max(1900, Number(event.target.value) || year),
                ),
              )
            }
          />
        </Field>
      )}

      {precision === 'quarter' && (
        <div className="flexible-quarter-row">
          <Field label="Year">
            <Input
              type="number"
              min={1900}
              max={2200}
              value={year}
              onChange={(event) => {
                const nextYear = Math.min(
                  2200,
                  Math.max(1900, Number(event.target.value) || year),
                );
                update((item) => {
                  item.date = quarterStartDate(nextYear, quarter);
                  item.datePrecision = 'quarter';
                  item.displayPrecision = 'quarter';
                  item.useFlexibleDate = true;
                  item.timeLabel = formatNodeDate(item.date, 'quarter');
                });
              }}
            />
          </Field>
          <div className="flexible-quarter-choice">
            <span>Quarter</span>
            <div>
              {([1, 2, 3, 4] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={quarter === value ? 'active' : ''}
                  aria-pressed={quarter === value}
                  onClick={() => setQuarter(value)}
                >
                  Q{value}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {precision === 'date' && (
        <Field label="Exact date">
          <Input
            type="date"
            value={migration.datePrecision === 'date' ? migration.date : ''}
            onChange={(event) => setExactDate(event.target.value)}
          />
        </Field>
      )}

      <p className="flexible-help">
        {precision !== 'date' && migration.datePrecision === 'date'
          ? `The exact date stays saved for accurate “as of” views; viewers only see ${shownLabel}.`
          : precision === 'date' && migration.datePrecision !== 'date'
            ? 'Choose an exact date before showing a full date.'
            : 'Show only what you really know — no made-up day required.'}
      </p>

      <div className="position-divider" />
      <div className="flexible-label">
        POSITION WITHIN {shownLabel.toUpperCase()}
      </div>
      <div className="position-controls">
        <button
          type="button"
          disabled={peerPosition <= 0}
          onClick={onMoveEarlier}
        >
          <ArrowLeft /> Earlier
        </button>
        <span>
          {peers.length > 1
            ? `${peerPosition + 1} of ${peers.length}`
            : 'Only node'}
        </span>
        <button
          type="button"
          disabled={peerPosition < 0 || peerPosition >= peers.length - 1}
          onClick={onMoveLater}
        >
          Later <ArrowRight />
        </button>
      </div>
      <p className="position-help">
        Order matching labels without inventing a more precise date.
      </p>
    </section>
  );
}

function AppChooser({
  side,
  entry,
  step,
  eyebrow,
  heading,
  update,
  onUpload,
  setNotice,
  canvasScheme,
}: {
  side: 'source' | 'replacement';
  entry: Migration['source'];
  step: '2' | '3';
  eyebrow: string;
  heading: string;
  update: (recipe: (item: Migration) => void) => void;
  onUpload: (file: File | undefined, side: 'source' | 'replacement') => void;
  setNotice: (message: string) => void;
  canvasScheme: 'light' | 'dark';
}) {
  const [catalog, setCatalog] = useState<DashboardIcon[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const isBigTech = side === 'source';
  useEffect(() => {
    let active = true;
    loadDashboardIcons()
      .then((icons) => {
        if (active) {
          setCatalog(icons);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (active) {
          setLoading(false);
          setNotice(
            error instanceof Error
              ? error.message
              : 'The icon catalog could not be opened.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [setNotice]);
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = terms.length
      ? catalog.filter((icon) =>
          terms.every((term) => icon.searchText.includes(term)),
        )
      : catalog;
    return matches.slice(0, 24);
  }, [catalog, query]);
  // Holds every id of a selected icon's variant pair, so a logo added on one
  // canvas scheme still reads as selected (and cannot be re-added) after the
  // canvas flips it to its other variant.
  const selectedIds = useMemo(() => {
    const ids = new Set(
      entry.icons
        .filter((icon) => icon.source === 'dashboard')
        .map((icon) => icon.id),
    );
    for (const item of catalog) {
      if (!item.colors) continue;
      const pair = [item.id, item.colors.light, item.colors.dark].filter(
        (id): id is string => Boolean(id),
      );
      if (pair.some((id) => ids.has(id))) for (const id of pair) ids.add(id);
    }
    return ids;
  }, [entry.icons, catalog]);
  // The open-source side leads with the MOS catalog: every app that ships in
  // the official catalog is a suggested replacement, generated from the same
  // manifests the site and Suite Manager read.
  const mosSuggestions = useMemo(
    () =>
      isBigTech
        ? []
        : mosApps.filter(
            (app) => app.hasIcon && mosAppMatchesQuery(app, query),
          ),
    [isBigTech, query],
  );
  const matchedMosApps = useMemo(
    () => (isBigTech ? [] : mosAppsForIcons(entry.icons)),
    [isBigTech, entry.icons],
  );
  const pushIcon = (created: IconRef) =>
    update((item) => {
      const previousNames = item[side].icons.map((current) => current.name);
      const keepInSync =
        !item[side].label || item[side].label === appLabel(previousNames);
      item[side].icons.push(created);
      item[side].category = isBigTech ? 'proprietary' : 'independent';
      if (keepInSync)
        item[side].label = appLabel([...previousNames, created.name]);
    });
  const addIcon = async (icon: DashboardIcon) => {
    if (selectedIds.has(icon.id) || addingId) return;
    setAddingId(icon.id);
    try {
      const created = await createDashboardIcon({
        id: icon.colors?.[canvasScheme] ?? icon.id,
        name: icon.name,
      });
      pushIcon(created);
      setNotice(
        `${icon.name} added to ${isBigTech ? 'Big Tech' : 'Open Source'}`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The icon could not be added.',
      );
    } finally {
      setAddingId('');
    }
  };
  const addMosApp = async (app: MosApp) => {
    const iconId = `mos-app-${app.id}`;
    if (selectedIds.has(iconId) || addingId) return;
    setAddingId(iconId);
    try {
      pushIcon(await createMosAppIcon(app));
      setNotice(`${app.name} added — it runs on My Own Suite`);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The icon could not be added.',
      );
    } finally {
      setAddingId('');
    }
  };
  const removeIcon = (index: number) =>
    update((item) => {
      const previousNames = item[side].icons.map((icon) => icon.name);
      const keepInSync = item[side].label === appLabel(previousNames);
      item[side].icons.splice(index, 1);
      if (keepInSync)
        item[side].label = appLabel(item[side].icons.map((icon) => icon.name));
    });
  return (
    <section className={`app-group ${isBigTech ? 'big-tech' : 'open-source'}`}>
      <div className="app-group-heading">
        <span className="step-number">{step}</span>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{heading}</h3>
        </div>
        <span className="fixed-category">
          {isBigTech ? 'Big Tech' : 'Open Source'}
        </span>
      </div>
      <div className="current-icons selected-apps">
        {entry.icons.map((icon, index) => (
          <div key={`${icon.id}-${index}`} className="current-icon">
            <IconPreview icon={icon} />
            <span>{icon.name}</span>
            <button
              onClick={() => removeIcon(index)}
              aria-label={`Remove ${icon.name}`}
            >
              <X />
            </button>
          </div>
        ))}
        {!entry.icons.length && (
          <p className="empty-selection">No apps selected yet</p>
        )}
      </div>
      {matchedMosApps.length > 0 && (
        <p className="mos-hint">
          <ShieldCheck />
          <span>
            {matchedMosApps.map((app, index) => (
              <span key={app.id}>
                {index > 0 && (index === matchedMosApps.length - 1 ? ' and ' : ', ')}
                <a
                  href={mosAppDocsUrl(app.id)}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {app.name}
                </a>
              </span>
            ))}{' '}
            {matchedMosApps.length === 1 ? 'runs' : 'run'} on My Own Suite —
            privacy-reviewed, installed in a couple of clicks.
          </span>
        </p>
      )}
      <label className="icon-search">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search apps, services, categories…"
          aria-label={`Search local icons for ${isBigTech ? 'Big Tech' : 'Open Source'}`}
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Clear icon search">
            <X />
          </button>
        )}
      </label>
      <div className="library-meta">
        <span>
          <Library />{' '}
          {catalog.length
            ? `${catalog.length.toLocaleString()} local SVG icons`
            : 'Local SVG icon catalog'}
        </span>
        <small>
          {query
            ? `${results.length}${results.length === 24 ? '+' : ''} shown`
            : 'Popular picks'}
        </small>
      </div>
      <div
        className="icon-library"
        aria-label={`Icon results for ${isBigTech ? 'Big Tech' : 'Open Source'}`}
      >
        {mosSuggestions.length > 0 && (
          <>
            <div className="library-divider">
              <ShieldCheck /> On My Own Suite · privacy-reviewed
            </div>
            {mosSuggestions.map((app) => {
              const iconId = `mos-app-${app.id}`;
              return (
                <button
                  key={app.id}
                  className={`mos-tile ${selectedIds.has(iconId) ? 'selected' : ''}`}
                  disabled={selectedIds.has(iconId) || Boolean(addingId)}
                  onClick={() => addMosApp(app)}
                  title={`${selectedIds.has(iconId) ? 'Added' : 'Add'} ${app.name}`}
                >
                  <img src={mosAppIconUrl(app.id)} alt="" loading="lazy" />
                  <span>{app.name}</span>
                  {selectedIds.has(iconId) && <Check />}
                </button>
              );
            })}
            <div className="library-divider">All apps & services</div>
          </>
        )}
        {loading ? (
          <p className="catalog-state">Opening the local icon library…</p>
        ) : results.length ? (
          results.map((icon) => (
            <button
              key={icon.id}
              className={selectedIds.has(icon.id) ? 'selected' : ''}
              disabled={selectedIds.has(icon.id) || Boolean(addingId)}
              onClick={() => addIcon(icon)}
              title={`${selectedIds.has(icon.id) ? 'Added' : 'Add'} ${icon.name}`}
            >
              <img src={dashboardIconUrl(icon.id)} alt="" loading="lazy" />
              <span>{icon.name}</span>
              {selectedIds.has(icon.id) && <Check />}
            </button>
          ))
        ) : (
          <p className="catalog-state">
            No match. Try a brand, product, or category.
          </p>
        )}
      </div>
      <input
        ref={uploadRef}
        type="file"
        hidden
        accept="image/svg+xml,image/png,.svg,.png"
        onChange={(event) => {
          onUpload(event.target.files?.[0], side);
          event.currentTarget.value = '';
        }}
      />
      <div className="app-group-footer">
        <Button
          variant="outline"
          size="sm"
          onClick={() => uploadRef.current?.click()}
        >
          <Upload /> Upload your own
        </Button>
        <span>Icons stay local and are embedded in exports.</span>
      </div>
      <Field label="Display label">
        <Textarea
          rows={2}
          value={entry.label}
          onChange={(event) =>
            update((item) => {
              item[side].label = event.target.value;
              item[side].category = isBigTech ? 'proprietary' : 'independent';
            })
          }
          placeholder={
            isBigTech
              ? 'e.g. Google Drive + Dropbox'
              : 'e.g. Nextcloud + Seafile'
          }
        />
      </Field>
    </section>
  );
}

function appLabel(names: string[]) {
  return names.join(' +\n');
}

function DesignInspector({
  doc,
  commit,
  advancedOpen,
  setAdvancedOpen,
}: {
  doc: RoadmapDocument;
  commit: (recipe: (draft: RoadmapDocument) => void) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (open: boolean) => void;
}) {
  const activeScheme = (['light', 'dark'] as const).find((scheme) =>
    matchesCanvasTheme(doc.theme, CANVAS_THEMES[scheme]),
  );
  // Besides swapping the palette, re-point monochrome logos at their variant
  // for the target scheme (apple ↔ apple-light and friends); clearing the
  // dataUrl lets the hydration effect embed the new artwork.
  const applyScheme = async (scheme: 'light' | 'dark') => {
    const variants = await loadIconVariantIndex().catch(() => null);
    commit((draft) => {
      draft.theme = { ...draft.theme, ...CANVAS_THEMES[scheme] };
      if (!variants) return;
      for (const migration of draft.migrations)
        for (const side of [migration.source, migration.replacement])
          for (const icon of side.icons) {
            if (icon.source !== 'dashboard') continue;
            const target = variants.get(icon.id)?.[scheme];
            if (target && target !== icon.id) {
              icon.id = target;
              delete icon.dataUrl;
            }
          }
    });
  };
  return (
    <div className="inspector-scroll">
      <section className="inspector-section compact">
        <p className="eyebrow">GRAPHIC</p>
        <h2>Story & appearance</h2>
      </section>
      <section className="inspector-section">
        <SwitchRow
          label="Show title"
          checked={doc.metadata.showTitle}
          onCheckedChange={(checked) =>
            commit((draft) => {
              draft.metadata.showTitle = checked;
            })
          }
        />
        {doc.metadata.showTitle && (
          <Field label="Title">
            <Input
              value={doc.metadata.title}
              onChange={(event) =>
                commit((draft) => {
                  draft.metadata.title = event.target.value;
                })
              }
            />
          </Field>
        )}
        <SwitchRow
          label="Show subtitle"
          checked={doc.metadata.showSubtitle}
          onCheckedChange={(checked) =>
            commit((draft) => {
              draft.metadata.showSubtitle = checked;
            })
          }
        />
        {doc.metadata.showSubtitle && (
          <Field label="Subtitle">
            <Textarea
              rows={2}
              value={doc.metadata.subtitle}
              onChange={(event) =>
                commit((draft) => {
                  draft.metadata.subtitle = event.target.value;
                })
              }
            />
          </Field>
        )}
        <SwitchRow
          label="Show categories"
          description="Adds independent category labels above the app lanes."
          checked={doc.metadata.showCategories}
          onCheckedChange={(checked) =>
            commit((draft) => {
              draft.metadata.showCategories = checked;
            })
          }
        />
        {doc.metadata.showCategories && (
          <Field label="Category style">
            <select
              value={doc.metadata.categoryDisplay}
              onChange={(event) =>
                commit((draft) => {
                  draft.metadata.categoryDisplay = event.target.value as
                    | 'text'
                    | 'icon'
                    | 'both';
                })
              }
            >
              <option value="text">Text labels</option>
              <option value="icon">Generic icons</option>
              <option value="both">Icons + labels</option>
            </select>
          </Field>
        )}
      </section>
      <section className="inspector-section">
        <p className="eyebrow">LABELS</p>
        <div className="field-row">
          <Field label="Top lane">
            <Input
              value={doc.labels.usingNow}
              onChange={(event) =>
                commit((draft) => {
                  draft.labels.usingNow = event.target.value;
                })
              }
            />
          </Field>
          <Field label="Bottom lane">
            <Input
              value={doc.labels.replacedPlanned}
              onChange={(event) =>
                commit((draft) => {
                  draft.labels.replacedPlanned = event.target.value;
                })
              }
            />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Independent legend">
            <Input
              value={doc.labels.independent}
              onChange={(event) =>
                commit((draft) => {
                  draft.labels.independent = event.target.value;
                })
              }
            />
          </Field>
          <Field label="Proprietary legend">
            <Input
              value={doc.labels.proprietary}
              onChange={(event) =>
                commit((draft) => {
                  draft.labels.proprietary = event.target.value;
                })
              }
            />
          </Field>
        </div>
        <Field label="Timeline label">
          <Input
            value={doc.labels.timeline}
            onChange={(event) =>
              commit((draft) => {
                draft.labels.timeline = event.target.value;
              })
            }
          />
        </Field>
        <div className="field">
          <span>Full-date order</span>
          <div className="timeline-date-display" aria-label="Full-date order">
            {(
              [
                ['dmy', 'DD/MM/YYYY'],
                ['mdy', 'MM/DD/YYYY'],
              ] as const
            ).map(([format, label]) => (
              <button
                key={format}
                type="button"
                className={
                  doc.timeline.fullDateFormat === format ? 'active' : ''
                }
                onClick={() =>
                  commit((draft) => {
                    draft.timeline.fullDateFormat = format;
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="inspector-section">
        <p className="eyebrow">COLORS</p>
        <div className="field">
          <span>Canvas theme</span>
          <div className="timeline-date-display" aria-label="Canvas theme">
            {(
              [
                ['light', 'Light'],
                ['dark', 'Dark'],
              ] as const
            ).map(([scheme, label]) => (
              <button
                key={scheme}
                type="button"
                className={activeScheme === scheme ? 'active' : ''}
                aria-pressed={activeScheme === scheme}
                onClick={() => applyScheme(scheme)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="color-grid">
          <ColorField
            label="Open source"
            value={doc.theme.independent}
            onChange={(value) =>
              commit((draft) => {
                draft.theme.independent = value;
              })
            }
          />
          <ColorField
            label="Big Tech"
            value={doc.theme.proprietary}
            onChange={(value) =>
              commit((draft) => {
                draft.theme.proprietary = value;
              })
            }
          />
          <ColorField
            label="Text"
            value={doc.theme.text}
            onChange={(value) =>
              commit((draft) => {
                draft.theme.text = value;
              })
            }
          />
          <ColorField
            label="Timeline"
            value={doc.theme.timeline}
            onChange={(value) =>
              commit((draft) => {
                draft.theme.timeline = value;
              })
            }
          />
          <ColorField
            label="Background"
            value={doc.theme.background}
            onChange={(value) =>
              commit((draft) => {
                draft.theme.background = value;
              })
            }
          />
        </div>
        <SwitchRow
          label="Transparent background"
          checked={doc.theme.transparent}
          onCheckedChange={(checked) =>
            commit((draft) => {
              draft.theme.transparent = checked;
            })
          }
        />
      </section>
      <section className="inspector-section">
        <p className="eyebrow">OUTPUT</p>
        <Field label="Filename">
          <Input
            value={doc.export.filename}
            onChange={(event) =>
              commit((draft) => {
                draft.export.filename =
                  event.target.value.replace(/[^a-zA-Z0-9._-]/g, '-') ||
                  'roadmap';
              })
            }
          />
        </Field>
        <Field label="Width behavior">
          <select
            value={doc.layout.widthMode}
            onChange={(event) =>
              commit((draft) => {
                draft.layout.widthMode = event.target
                  .value as RoadmapDocument['layout']['widthMode'];
              })
            }
          >
            <option value="fit">Fit to width</option>
            <option value="auto">Automatic width</option>
            <option value="manual">Manual width (grows if needed)</option>
          </select>
        </Field>
        <div className="field-row">
          <NumberField
            label="Width"
            value={doc.layout.width}
            min={760}
            max={8000}
            onChange={(value) =>
              commit((draft) => {
                draft.layout.width = value;
              })
            }
          />
          <NumberField
            label="Height"
            value={doc.layout.height}
            min={640}
            max={5000}
            onChange={(value) =>
              commit((draft) => {
                draft.layout.height = value;
              })
            }
          />
        </div>
        <SwitchRow
          label="Show social safe area"
          description="Preview guide only; never included in exports."
          checked={doc.layout.showSafeArea}
          onCheckedChange={(checked) =>
            commit((draft) => {
              draft.layout.showSafeArea = checked;
            })
          }
        />
        <SwitchRow
          label="Simulate square crop"
          checked={doc.layout.simulateSquareCrop}
          onCheckedChange={(checked) =>
            commit((draft) => {
              draft.layout.simulateSquareCrop = checked;
            })
          }
        />
      </section>
      <section className="inspector-section">
        <p className="eyebrow">SOCIAL FOOTER</p>
        <SwitchRow
          label="My Own Suite mark"
          description="Invites others to plan their own journey."
          checked={doc.branding.myOwnSuite}
          onCheckedChange={(checked) =>
            commit((draft) => {
              draft.branding.myOwnSuite = checked;
            })
          }
        />
        {doc.branding.myOwnSuite && (
          <Field label="Website label">
            <Input
              value={doc.branding.siteLabel}
              onChange={(event) =>
                commit((draft) => {
                  draft.branding.siteLabel = event.target.value;
                })
              }
            />
          </Field>
        )}
        <p className="tiny-note">
          The footer mark appears on tall social canvases only.
        </p>
      </section>
      <section className="inspector-section advanced-section">
        <button
          className="advanced-toggle"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          aria-expanded={advancedOpen}
        >
          <div>
            <Settings2 />
            <span>
              <strong>Advanced layout</strong>
              <small>Geometry and spacing</small>
            </span>
          </div>
          <ChevronDown className={advancedOpen ? 'rotated' : ''} />
        </button>
        {advancedOpen && (
          <div className="advanced-grid">
            <NumberField
              label="Outer margin"
              value={doc.layout.outerMargin}
              min={24}
              max={300}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.outerMargin = value;
                })
              }
            />
            <NumberField
              label="Minimum gap"
              value={doc.layout.minNodeGap}
              min={8}
              max={300}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.minNodeGap = value;
                })
              }
            />
            <NumberField
              label="Preferred gap"
              value={doc.layout.preferredNodeGap}
              min={20}
              max={500}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.preferredNodeGap = value;
                })
              }
            />
            <NumberField
              label="Minimum node"
              value={doc.layout.minNodeWidth}
              min={54}
              max={280}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.minNodeWidth = value;
                })
              }
            />
            <NumberField
              label="Icon size"
              value={doc.layout.iconSize}
              min={24}
              max={110}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.iconSize = value;
                })
              }
            />
            <NumberField
              label="Lane separation"
              value={doc.layout.laneSeparation}
              min={130}
              max={650}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.laneSeparation = value;
                })
              }
            />
            <NumberField
              label="Curve tension"
              value={doc.layout.curveTension}
              min={0.35}
              max={1.4}
              step={0.05}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.curveTension = value;
                })
              }
            />
          </div>
        )}
      </section>
    </div>
  );
}

function matchesCanvasTheme(
  theme: RoadmapDocument['theme'],
  candidate: CanvasTheme,
) {
  return (Object.keys(candidate) as (keyof CanvasTheme)[]).every(
    (key) => theme[key].toLowerCase() === candidate[key].toLowerCase(),
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) =>
          onChange(
            Math.min(max, Math.max(min, Number(event.target.value) || min)),
          )
        }
      />
    </Field>
  );
}
function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="switch-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="color-field">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span>
        {label}
        <small>{value}</small>
      </span>
    </label>
  );
}
function IconPreview({ icon }: { icon: IconRef }) {
  if (!icon.dataUrl) return <span className="icon-preview-empty" aria-hidden="true" />;
  return <img src={icon.dataUrl} alt="" />;
}
function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('The PNG could not be read.'));
    reader.onerror = () => reject(new Error('The PNG could not be read.'));
    reader.readAsDataURL(file);
  });
}
