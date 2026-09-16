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
  iconIdForScheme,
  loadDashboardIcons,
  loadIconVariantIndex,
  type DashboardIcon,
} from '@/lib/dashboard-icon-library';
import { CATEGORY_ICONS, type CategoryIconId } from '@/lib/category-icons';
import {
  applyIconArtwork,
  resolveMissingIconArtwork,
} from '@/lib/icon-hydration';
import { blobToDataUrl, svgTextToDataUrl } from '@/lib/icon-library';
import {
  createMosAppIcon,
  mosAppDocsUrl,
  mosAppIconUrl,
  mosAppMatchesQuery,
  mosApps,
  mosAppsForIcons,
  mosIconId,
  type MosApp,
} from '@/lib/mos-catalog';
import { computeLayout, type RoadmapLayout } from '@/lib/roadmap-layout';
import {
  downloadText,
  exportableRoadmapSvg,
  rasterizeSvg,
  type RasterFormat,
} from '@/lib/roadmap-export';
import {
  activeProject,
  addProject,
  createProject,
  forkExample,
  libraryIsFull,
  loadLibrary,
  removeProject,
  renameProject,
  roadmapJson,
  saveLibrary,
  uniqueProjectName,
  withActiveDoc,
  MAX_PROJECTS,
  MAX_PROJECT_NAME,
  type RoadmapLibrary,
} from '@/lib/roadmap-library';
import { shareUrlFor, takePendingSharedRoadmap } from '@/lib/share-link';
import {
  CANVAS_THEMES,
  LAYOUT_RANGES,
  LIMITS,
  ROADMAP_TEMPLATES,
  SIDE_NAMES,
  addIconToEntry,
  canvasSchemeFor,
  cloneRoadmap,
  createMigration,
  formatNodeDate,
  isIsoDate,
  migrationDisplayLabel,
  migrationIsReached,
  migrationOrderKey,
  presets,
  quarterStartDate,
  removeIconFromEntry,
  todayIsoDate,
  uniqueId,
  validateRoadmap,
  type CanvasTheme,
  type IconRef,
  type Migration,
  type RoadmapDocument,
  type RoadmapTemplate,
  type Side,
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
  TriangleAlert,
  Undo2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

type InspectorTab = 'migration' | 'design';
type SaveState = 'saving' | 'saved' | 'unsaved';
type ConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => void;
} | null;

// Read once at module scope: it consumes the #plan= fragment, and React
// StrictMode would otherwise run a state initializer twice and lose it.
const pendingShared = takePendingSharedRoadmap();

// A shared link opens as a roadmap of its own rather than over whatever the
// visitor had open, so remixing someone else's plan can never cost them their
// own. A full library cannot take it, and says so rather than dropping it.
function openSharedRoadmap(library: RoadmapLibrary) {
  if (!pendingShared) return { library, notice: '' };
  if (libraryIsFull(library))
    return {
      library,
      notice: `This browser already holds ${MAX_PROJECTS} roadmaps, so the shared plan could not be opened. Delete one, then open the link again.`,
    };
  return {
    library: addProject(
      library,
      createProject(
        uniqueProjectName(library, 'Shared roadmap'),
        pendingShared,
      ),
    ),
    notice: 'Shared plan opened as a new roadmap.',
  };
}

export default function Home() {
  const [opened] = useState(() => openSharedRoadmap(loadLibrary()));
  const [library, setLibrary] = useState<RoadmapLibrary>(opened.library);
  const [history, setHistory] = useState(() => ({
    past: [] as RoadmapDocument[],
    present: activeProject(library).doc,
    future: [] as RoadmapDocument[],
  }));
  const doc = history.present;
  const project = activeProject(library);
  const [selectedId, setSelectedId] = useState(doc.migrations[0]?.id ?? '');
  const [mode, setMode] = useState<'edit' | 'view'>('edit');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('migration');
  const [zoom, setZoom] = useState(0.56);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [notice, setNotice] = useState(opened.notice);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const hydrationAttempts = useRef(new Set<string>());
  // Whether the pending autosave carries an edit (as opposed to artwork
  // embedded or a plan merely opened), which is what "edited 2m ago" means.
  const editedRef = useRef(false);
  // Refs, so committing an edit can read the library without making every
  // control depend on it.
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const docRef = useRef(doc);
  docRef.current = doc;
  const layout = useMemo(() => computeLayout(doc), [doc]);
  const selectedIndex = doc.migrations.findIndex(
    (item) => item.id === selectedId,
  );
  const selected =
    selectedIndex >= 0 ? doc.migrations[selectedIndex] : undefined;

  // Edits land in whichever roadmap is open. Switching roadmaps writes the
  // open one first, so a pending save can never spill into its neighbour.
  const activeId = library.activeId;
  useEffect(() => {
    const timer = setTimeout(() => {
      const current = libraryRef.current;
      if (current.activeId !== activeId) return;
      const next = withActiveDoc(current, doc, editedRef.current);
      editedRef.current = false;
      const stored = saveLibrary(next);
      libraryRef.current = next;
      setLibrary(next);
      setSaveState(stored ? 'saved' : 'unsaved');
    }, 350);
    return () => clearTimeout(timer);
  }, [doc, activeId]);

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

  const publishLibrary = useCallback((next: RoadmapLibrary) => {
    libraryRef.current = next;
    setLibrary(next);
    if (!saveLibrary(next)) setSaveState('unsaved');
  }, []);

  const commit = useCallback(
    (recipe: (draft: RoadmapDocument) => void) => {
      // The first edit to the example forks it into a roadmap of your own: the
      // example has to stay in the list, exactly as it shipped, for anyone who
      // wants to look at it again or start over from it.
      const current = libraryRef.current;
      const open = activeProject(current);
      if (open?.example && libraryIsFull(current)) {
        setNotice(
          `This browser holds ${MAX_PROJECTS} roadmaps, so the example cannot be copied to edit. Delete one to start another.`,
        );
        return;
      }
      setSaveState('saving');
      editedRef.current = true;
      if (open?.example) {
        const edited = cloneRoadmap(docRef.current);
        recipe(edited);
        const { library: next, project: copy } = forkExample(current, edited);
        libraryRef.current = next;
        publishLibrary(next);
        setHistory({ past: [docRef.current], present: copy.doc, future: [] });
        setNotice(
          `Editing started “${copy.name}” — “${open.name}” stays as the example.`,
        );
        return;
      }
      setHistory((history) => {
        const next = cloneRoadmap(history.present);
        recipe(next);
        return {
          past: [...history.past.slice(-79), history.present],
          present: next,
          future: [],
        };
      });
    },
    [publishLibrary],
  );

  const undo = () => {
    setSaveState('saving');
    editedRef.current = true;
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
    editedRef.current = true;
    setHistory((current) => {
      if (!current.future.length) return current;
      return {
        past: [...current.past, current.present],
        present: current.future[0],
        future: current.future.slice(1),
      };
    });
  };

  // Resolved inside the recipe: an icon fetch may finish after the selection
  // or the order has moved on.
  const updateSelected = (recipe: (item: Migration) => void) => {
    const id = selectedId;
    commit((draft) => {
      const item = draft.migrations.find((entry) => entry.id === id);
      if (item) recipe(item);
    });
  };

  // Every roadmap switch goes through here: the open document is written back
  // first, then the newly opened one starts with a clean undo history.
  const openProject = (id: string) => {
    const saved = withActiveDoc(library, doc);
    const target = saved.projects.find((entry) => entry.id === id);
    if (!target) return;
    publishLibrary({ ...saved, activeId: id });
    setHistory({ past: [], present: target.doc, future: [] });
    setSelectedId(target.doc.migrations[0]?.id ?? '');
    setInspectorTab('migration');
    setSaveState('saved');
  };

  const startProject = (name: string, source: RoadmapDocument) => {
    const saved = withActiveDoc(library, doc);
    if (libraryIsFull(saved)) {
      setNotice(
        `This browser holds ${MAX_PROJECTS} roadmaps. Delete one to start another.`,
      );
      return;
    }
    const created = createProject(uniqueProjectName(saved, name), source);
    publishLibrary(addProject(saved, created));
    setHistory({ past: [], present: created.doc, future: [] });
    setSelectedId(created.doc.migrations[0]?.id ?? '');
    setInspectorTab('migration');
    setSaveState('saved');
    setNotice(`“${created.name}” is ready to edit.`);
  };

  const newProject = (template: RoadmapTemplate) =>
    startProject(template.name, template.build());

  const duplicateProject = () => startProject(project.name, doc);

  const deleteProject = () =>
    setConfirmAction({
      title: `Delete “${project.name}”?`,
      description:
        'This roadmap is removed from this browser. Export it as JSON first if you might want it back.',
      confirmLabel: 'Delete roadmap',
      action: () => {
        const next = removeProject(library, project.id);
        publishLibrary(next);
        const opened = activeProject(next);
        setHistory({ past: [], present: opened.doc, future: [] });
        setSelectedId(opened.doc.migrations[0]?.id ?? '');
        setNotice(`“${project.name}” deleted.`);
      },
    });

  const applyRename = (name: string) => {
    publishLibrary(renameProject(library, project.id, name));
    setRenaming(null);
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
    if (copy.source.label) copy.source.label = `${copy.source.label} copy`;
    commit((draft) => draft.migrations.splice(selectedIndex + 1, 0, copy));
    setSelectedId(copy.id);
  };

  const removeSelected = () => {
    if (!selected) return;
    setConfirmAction({
      title: `Remove “${selected.replacement.label || selected.source.label || 'untitled node'}”?`,
      description:
        'This removes the node from the roadmap. You can still undo the change afterward.',
      confirmLabel: 'Remove',
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
      const key = migrationOrderKey(draft.migrations[index]);
      const peerIndexes = draft.migrations
        .map((item, itemIndex) => ({ item, itemIndex }))
        .filter(({ item }) => migrationOrderKey(item) === key)
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

  // Fit means the whole graphic is on screen, not just its width: a canvas
  // that follows its content is often taller than it is wide, and fitting the
  // width alone left the timeline and the legend below the fold. The reserved
  // height also clears the edit bar floating over the top of the artboard.
  // A zoom chosen by hand is kept until the next explicit Fit; the automatic
  // fit follows the canvas only while nobody has touched the zoom.
  const manualZoom = useRef(false);
  const fitPreview = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // The viewport centres the artboard inside 48px of padding on every side;
    // anything wider than that spills past the padding into a scrollbar, and
    // one scrollbar brings on the other.
    const byWidth = (viewport.clientWidth - 96) / layout.width;
    const byHeight =
      (viewport.clientHeight - (mode === 'edit' ? 140 : 96)) / layout.height;
    manualZoom.current = false;
    setZoom(clampZoom(Math.min(byWidth, byHeight)));
  }, [layout.width, layout.height, mode]);
  const zoomBy = (delta: number) => {
    manualZoom.current = true;
    setZoom((value) => clampZoom(value + delta));
  };

  useEffect(() => {
    manualZoom.current = false;
  }, [mode]);
  useEffect(() => {
    if (!manualZoom.current) fitPreview();
  }, [fitPreview]);

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
          await exportableRoadmapSvg(svgRef.current),
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
      // A loaded file opens as its own roadmap, next to the ones already
      // here, instead of overwriting whatever was open.
      startProject(
        file.name.replace(/\.json$/i, '') || 'Loaded roadmap',
        result.value,
      );
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
                <Button
                  variant="outline"
                  className="wide-only"
                  onClick={saveJson}
                >
                  <Save /> Save JSON
                </Button>
              </>
            )}
            <Button variant="outline" onClick={shareLink}>
              <Link2 /> Share link
            </Button>
            <ExportMenu onExport={exportGraphic} />
          </div>
        </div>
        <div className="topbar-row topbar-controls">
          <ProjectSwitcher
            library={library}
            onOpen={openProject}
            onNew={newProject}
            onRename={() => setRenaming(project.name)}
            onDuplicate={duplicateProject}
            onDelete={deleteProject}
          />
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
                onChange={(event) => {
                  const viewDate = event.target.value;
                  if (!isIsoDate(viewDate)) return;
                  commit((draft) => {
                    draft.timeline.viewDate = viewDate;
                  });
                }}
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
              <span className={`save-state ${saveState}`} role="status">
                {saveState === 'unsaved' ? <TriangleAlert /> : <Check />}{' '}
                {saveState === 'saved'
                  ? 'Saved locally'
                  : saveState === 'saving'
                    ? 'Saving…'
                    : 'Not saved — this browser’s storage is full or blocked'}
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
                onClick={() => zoomBy(-0.1)}
                aria-label="Zoom out"
              >
                <Minus />
              </Button>
              <button
                className="zoom-value"
                onClick={fitPreview}
                title="Fit the whole graphic on screen"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => zoomBy(0.1)}
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
                layout={layout}
                className="roadmap-svg"
                interactive={mode === 'edit'}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setInspectorTab('migration');
                }}
                onAdd={addMigration}
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
                      title: `Reset “${project.name}” to the example?`,
                      description:
                        'This replaces the open roadmap with the starting example, theme and labels included. Your other roadmaps are untouched, and this one can be brought back with Undo.',
                      confirmLabel: 'Reset roadmap',
                      action: () => {
                        const fresh = ROADMAP_TEMPLATES[0].build();
                        setSaveState('saving');
                        editedRef.current = true;
                        setHistory((current) => ({
                          past: [...current.past, current.present],
                          present: fresh,
                          future: [],
                        }));
                        setSelectedId(fresh.migrations[0]?.id ?? '');
                      },
                    })
                  }
                >
                  <RotateCcw /> Reset to example
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
                layout={layout}
                commit={commit}
                advancedOpen={advancedOpen}
                setAdvancedOpen={setAdvancedOpen}
              />
            )}
          </aside>
        )}
      </section>

      <footer className="app-footnote">
        <span className="app-footnote-promise">
          <ShieldCheck /> Runs entirely in your browser — your plan never leaves
          your device.
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
              {confirmAction?.confirmLabel ?? 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RenameDialog
        name={renaming}
        onCancel={() => setRenaming(null)}
        onSave={applyRename}
      />
    </main>
  );
}

const ZOOM_RANGE = { min: 0.1, max: 2 };
const clampZoom = (value: number) =>
  Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, value));

// Closes a popover on a click outside it or on Escape.
function useDismiss(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [root, open, close]);
}

function ExportMenu({
  onExport,
}: {
  onExport: (format: 'svg' | RasterFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);
  const choose = (format: 'svg' | RasterFormat) => {
    setOpen(false);
    onExport(format);
  };
  return (
    <div className="export-menu" ref={root}>
      <Button className="export-main" onClick={() => onExport('png')}>
        <Download /> Export PNG
      </Button>
      <button
        className="export-more"
        aria-label="More export formats"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown />
      </button>
      {open && (
        <div className="export-popover" role="menu">
          <button role="menuitem" onClick={() => choose('svg')}>
            <FileDown /> Editable SVG <small>Self-contained vector</small>
          </button>
          <button role="menuitem" onClick={() => choose('webp')}>
            <ImageDown /> WebP <small>Compact social image</small>
          </button>
        </div>
      )}
    </div>
  );
}

function RenameDialog({
  name,
  onCancel,
  onSave,
}: {
  name: string | null;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (name !== null) setDraft(name);
  }, [name]);
  return (
    <AlertDialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rename roadmap</AlertDialogTitle>
          <AlertDialogDescription>
            Only you see this name — it labels the roadmap in the switcher, not
            on the graphic.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          autoFocus
          value={draft}
          maxLength={MAX_PROJECT_NAME}
          aria-label="Roadmap name"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSave(draft);
          }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onSave(draft)}>
            Save name
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ProjectSwitcher({
  library,
  onOpen,
  onNew,
  onRename,
  onDuplicate,
  onDelete,
}: {
  library: RoadmapLibrary;
  onOpen: (id: string) => void;
  onNew: (template: RoadmapTemplate) => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState<'list' | 'new' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const active = activeProject(library);
  const close = useCallback(() => setOpen(null), []);
  useDismiss(root, open !== null, close);
  const choose = (run: () => void) => {
    setOpen(null);
    run();
  };
  return (
    <div className="project-switcher" ref={root}>
      <button
        className="project-current"
        aria-expanded={open === 'list'}
        onClick={() => setOpen(open === 'list' ? null : 'list')}
      >
        <Library />
        <span>
          <small>ROADMAP</small>
          <strong>{active.name}</strong>
        </span>
        <ChevronDown className={open === 'list' ? 'rotated' : ''} />
      </button>
      <button
        className="project-add"
        aria-label="Start a new roadmap"
        title="Start a new roadmap"
        aria-expanded={open === 'new'}
        onClick={() => setOpen(open === 'new' ? null : 'new')}
      >
        <Plus />
      </button>
      {open === 'list' && (
        <div className="project-popover">
          <p className="project-popover-head">Your roadmaps</p>
          <div className="project-list">
            {library.projects.map((entry) => (
              <button
                key={entry.id}
                className={entry.id === active.id ? 'selected' : ''}
                onClick={() => choose(() => onOpen(entry.id))}
              >
                <Check
                  style={{
                    visibility: entry.id === active.id ? 'visible' : 'hidden',
                  }}
                />
                <span>
                  {entry.name}
                  <small>
                    {entry.doc.migrations.length} node
                    {entry.doc.migrations.length === 1 ? '' : 's'} ·{' '}
                    {entry.example ? 'example' : editedLabel(entry.updatedAt)}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <div className="project-actions">
            <button onClick={() => choose(onRename)}>
              <Pencil /> Rename
            </button>
            <button onClick={() => choose(onDuplicate)}>
              <Copy /> Duplicate
            </button>
            <button
              className="danger"
              disabled={library.projects.length < 2 || Boolean(active.example)}
              title={
                active.example
                  ? 'The example is always kept — editing it starts a copy.'
                  : library.projects.length < 2
                    ? 'This is your only roadmap.'
                    : undefined
              }
              onClick={() => choose(onDelete)}
            >
              <Trash2 /> Delete
            </button>
          </div>
        </div>
      )}
      {open === 'new' && (
        <div className="project-popover new-roadmap">
          <p className="project-popover-head">Start a new roadmap</p>
          {ROADMAP_TEMPLATES.map((template) => (
            <button
              key={template.id}
              onClick={() => choose(() => onNew(template))}
            >
              <LayoutTemplate />
              {template.name}
              <small>{template.description}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function editedLabel(updatedAt: number) {
  const minutes = Math.round((Date.now() - updatedAt) / 60_000);
  if (minutes < 1) return 'edited just now';
  if (minutes < 60) return `edited ${minutes}m ago`;
  if (minutes < 1440) return `edited ${Math.round(minutes / 60)}h ago`;
  return `edited ${new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
  }).format(updatedAt)}`;
}

function MigrationInspector({
  migration,
  update,
  onDuplicate,
  onDelete,
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
        key={usingSide}
        side={usingSide}
        entry={migration[usingSide]}
        step="2"
        eyebrow="USING NOW"
        heading="Apps used at the viewing date"
        update={update}
        setNotice={setNotice}
        canvasScheme={canvasScheme}
      />
      <AppChooser
        key={otherSide}
        side={otherSide}
        entry={migration[otherSide]}
        step="3"
        eyebrow="REPLACED / PLANNED"
        heading={reached ? 'Apps this switch replaced' : 'Apps planned next'}
        update={update}
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
  const precision = migration.displayPrecision;
  const referenceDate = migration.date || viewDate || todayIsoDate();
  const year = Number(referenceDate.slice(0, 4));
  const month = Number(referenceDate.slice(5, 7)) || 1;
  const quarter = (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  const orderKey = migrationOrderKey(migration);
  const peers = migrations.filter(
    (item) => migrationOrderKey(item) === orderKey,
  );
  const peerPosition = peers.findIndex((item) => item.id === migration.id);
  const shownLabel = migrationDisplayLabel(migration, fullDateFormat);

  const choosePrecision = (nextPrecision: Migration['datePrecision']) =>
    update((item) => {
      item.displayPrecision = nextPrecision;
      if (!item.date && nextPrecision !== 'date') {
        item.date = `${year}-01-01`;
        item.datePrecision = nextPrecision;
      }
    });

  // A year or quarter chosen on top of an exact date keeps the exact date,
  // so the “as of” view stays accurate while the graphic prints less.
  const setYear = (nextYear: number) =>
    update((item) => {
      const suffix =
        item.date && item.datePrecision === 'date'
          ? item.date.slice(4)
          : '-01-01';
      item.date = `${nextYear}${suffix}`;
      if (item.datePrecision !== 'date') item.datePrecision = 'year';
      item.displayPrecision = 'year';
    });

  const setQuarter = (nextQuarter: 1 | 2 | 3 | 4, inYear = year) =>
    update((item) => {
      const currentQuarter = item.date
        ? Math.floor((Number(item.date.slice(5, 7)) - 1) / 3) + 1
        : undefined;
      const currentYear = Number(item.date.slice(0, 4));
      if (
        item.datePrecision !== 'date' ||
        currentQuarter !== nextQuarter ||
        currentYear !== inYear
      ) {
        item.date = quarterStartDate(inYear, nextQuarter);
        item.datePrecision = 'quarter';
      }
      item.displayPrecision = 'quarter';
    });

  const setExactDate = (date: string) => {
    if (date && !isIsoDate(date)) return;
    update((item) => {
      item.date = date;
      item.datePrecision = 'date';
      item.displayPrecision = 'date';
    });
  };

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
        <NumberField
          label="Year"
          value={year}
          min={1900}
          max={2200}
          onChange={setYear}
        />
      )}

      {precision === 'quarter' && (
        <div className="flexible-quarter-row">
          <NumberField
            label="Year"
            value={year}
            min={1900}
            max={2200}
            onChange={(nextYear) => setQuarter(quarter, nextYear)}
          />
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

      {peers.length > 1 && (
        <>
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
              {peerPosition + 1} of {peers.length}
            </span>
            <button
              type="button"
              disabled={peerPosition >= peers.length - 1}
              onClick={onMoveLater}
            >
              Later <ArrowRight />
            </button>
          </div>
          <p className="position-help">
            Order matching labels without inventing a more precise date.
          </p>
        </>
      )}
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
  setNotice,
  canvasScheme,
}: {
  side: Side;
  entry: Migration['source'];
  step: '2' | '3';
  eyebrow: string;
  heading: string;
  update: (recipe: (item: Migration) => void) => void;
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
  const sideFull = entry.icons.length >= LIMITS.iconsPerSide;
  const pushIcon = (created: IconRef) => {
    update((item) => {
      item[side].category = isBigTech ? 'proprietary' : 'independent';
      addIconToEntry(item[side], created);
    });
    setNotice(`${created.name} added to ${SIDE_NAMES[side]}`);
  };
  const refuse = (error: unknown, fallback: string) =>
    setNotice(error instanceof Error ? error.message : fallback);
  const addIcon = async (icon: DashboardIcon) => {
    if (selectedIds.has(icon.id) || addingId || sideFull) return;
    setAddingId(icon.id);
    try {
      pushIcon(
        await createDashboardIcon({
          id: iconIdForScheme(icon.id, icon.colors, canvasScheme),
          name: icon.name,
        }),
      );
    } catch (error) {
      refuse(error, 'The icon could not be added.');
    } finally {
      setAddingId('');
    }
  };
  const addMosApp = async (app: MosApp) => {
    if (selectedIds.has(mosIconId(app)) || addingId || sideFull) return;
    setAddingId(mosIconId(app));
    try {
      pushIcon(await createMosAppIcon(app));
    } catch (error) {
      refuse(error, 'The icon could not be added.');
    } finally {
      setAddingId('');
    }
  };
  const uploadIcon = async (file: File | undefined) => {
    if (!file || sideFull) return;
    if (!['image/svg+xml', 'image/png'].includes(file.type)) {
      setNotice('Choose an SVG or PNG icon.');
      return;
    }
    if (file.size > 1_500_000) {
      setNotice('Please keep icon files below 1.5 MB.');
      return;
    }
    try {
      pushIcon({
        id: uniqueId('upload'),
        name: file.name.replace(/\.[^.]+$/, ''),
        source: 'upload',
        dataUrl:
          file.type === 'image/svg+xml'
            ? svgTextToDataUrl(await file.text(), uniqueId('svg'))
            : await blobToDataUrl(file),
      });
    } catch (error) {
      refuse(error, 'The icon could not be read.');
    }
  };
  const removeIcon = (index: number) =>
    update((item) => removeIconFromEntry(item[side], index));
  return (
    <section className={`app-group ${isBigTech ? 'big-tech' : 'open-source'}`}>
      <div className="app-group-heading">
        <span className="step-number">{step}</span>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{heading}</h3>
        </div>
        <span className="fixed-category">{SIDE_NAMES[side]}</span>
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
                {index > 0 &&
                  (index === matchedMosApps.length - 1 ? ' and ' : ', ')}
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
          aria-label={`Search local icons for ${SIDE_NAMES[side]}`}
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
        aria-label={`Icon results for ${SIDE_NAMES[side]}`}
      >
        {mosSuggestions.length > 0 && (
          <>
            <div className="library-divider">
              <ShieldCheck /> On My Own Suite · privacy-reviewed
            </div>
            {mosSuggestions.map((app) => {
              const iconId = mosIconId(app);
              return (
                <button
                  key={app.id}
                  className={`mos-tile ${selectedIds.has(iconId) ? 'selected' : ''}`}
                  disabled={
                    selectedIds.has(iconId) || Boolean(addingId) || sideFull
                  }
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
              disabled={
                selectedIds.has(icon.id) || Boolean(addingId) || sideFull
              }
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
          uploadIcon(event.target.files?.[0]);
          event.currentTarget.value = '';
        }}
      />
      <div className="app-group-footer">
        <Button
          variant="outline"
          size="sm"
          disabled={sideFull}
          onClick={() => uploadRef.current?.click()}
        >
          <Upload /> Upload your own
        </Button>
        <span>
          {sideFull
            ? `Up to ${LIMITS.iconsPerSide} icons per side.`
            : 'Icons stay local and are embedded in exports.'}
        </span>
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

function DesignInspector({
  doc,
  layout,
  commit,
  advancedOpen,
  setAdvancedOpen,
}: {
  doc: RoadmapDocument;
  layout: RoadmapLayout;
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
            const target = iconIdForScheme(
              icon.id,
              variants.get(icon.id),
              scheme,
            );
            if (target !== icon.id) {
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
                    'text' | 'icon' | 'both';
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
        <p className="eyebrow">SIZE & SPACING</p>
        <SliderField
          label="Text size"
          hint="Raise this when the graphic will be shown small — in a blog column, for instance."
          value={doc.layout.textScale}
          min={LAYOUT_RANGES.textScale.min}
          max={LAYOUT_RANGES.textScale.max}
          step={0.05}
          format={(value) => `${Math.round(value * 100)}%`}
          onChange={(value) =>
            commit((draft) => {
              draft.layout.textScale = value;
            })
          }
        />
        <SliderField
          label="Space between nodes"
          hint="The gap between neighbouring columns. Tighten it for a long roadmap, open it up for a short one."
          value={doc.layout.nodeSpacing}
          min={LAYOUT_RANGES.nodeSpacing.min}
          max={LAYOUT_RANGES.nodeSpacing.max}
          step={2}
          format={(value) => `${Math.round(value)} px`}
          onChange={(value) =>
            commit((draft) => {
              draft.layout.nodeSpacing = value;
            })
          }
        />
        {layout.spread > 1 && (
          <p className="field-note">
            The canvas is wider than this roadmap needs, so nodes are spread to
            fill it and this gap is only a minimum. Switch the canvas width to{' '}
            <strong>Fit the roadmap</strong> below to space them exactly.
          </p>
        )}
        <SliderField
          label="Distance between lanes"
          hint="Vertical room between the top and bottom rows."
          value={doc.layout.laneSeparation}
          min={LAYOUT_RANGES.laneSeparation.min}
          max={LAYOUT_RANGES.laneSeparation.max}
          step={5}
          format={(value) => `${Math.round(value)} px`}
          onChange={(value) =>
            commit((draft) => {
              draft.layout.laneSeparation = value;
            })
          }
        />
        <SliderField
          label="Icon size"
          value={doc.layout.iconSize}
          min={LAYOUT_RANGES.iconSize.min}
          max={LAYOUT_RANGES.iconSize.max}
          step={2}
          format={(value) => `${Math.round(value)} px`}
          onChange={(value) =>
            commit((draft) => {
              draft.layout.iconSize = value;
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
        <Field label="Canvas size">
          <select
            value={doc.layout.widthMode}
            onChange={(event) =>
              commit((draft) => {
                draft.layout.widthMode = event.target
                  .value as RoadmapDocument['layout']['widthMode'];
              })
            }
          >
            <option value="auto">Fit the roadmap</option>
            <option value="fixed">Exact size (grows if needed)</option>
          </select>
        </Field>
        {doc.layout.widthMode === 'fixed' ? (
          <div className="field-row">
            <NumberField
              label="Width"
              value={doc.layout.width}
              min={LAYOUT_RANGES.width.min}
              max={LAYOUT_RANGES.width.max}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.width = value;
                })
              }
            />
            <NumberField
              label="Height"
              value={doc.layout.height}
              min={LAYOUT_RANGES.height.min}
              max={LAYOUT_RANGES.height.max}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.height = value;
                })
              }
            />
          </div>
        ) : (
          <p className="field-note">
            The canvas is exactly as tall and wide as the roadmap needs, so
            hiding the title or tightening the spacing shrinks it.
          </p>
        )}
        <p className="field-note">
          Exports at {layout.width} × {layout.height} px.
        </p>
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
              min={LAYOUT_RANGES.outerMargin.min}
              max={LAYOUT_RANGES.outerMargin.max}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.outerMargin = value;
                })
              }
            />
            <NumberField
              label="Minimum node width"
              value={doc.layout.minNodeWidth}
              min={LAYOUT_RANGES.minNodeWidth.min}
              max={LAYOUT_RANGES.minNodeWidth.max}
              onChange={(value) =>
                commit((draft) => {
                  draft.layout.minNodeWidth = value;
                })
              }
            />
            <NumberField
              label="Curve tension"
              value={doc.layout.curveTension}
              min={LAYOUT_RANGES.curveTension.min}
              max={LAYOUT_RANGES.curveTension.max}
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
// Typed freely, clamped once the field is left: clamping per keystroke made
// “2027” impossible to type past a minimum of 1900.
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
  const [draft, setDraft] = useState<string | null>(null);
  const settle = () => {
    if (draft === null) return;
    const typed = Number(draft);
    if (draft.trim() && Number.isFinite(typed))
      onChange(Math.min(max, Math.max(min, typed)));
    setDraft(null);
  };
  return (
    <Field label={label}>
      <Input
        type="number"
        value={draft ?? value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={settle}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </Field>
  );
}
// A setting whose whole point is to be dragged and watched: the number field
// it replaces made spacing feel like a guess. The control's own look is the
// shared mos-range; this owns only the row around it.
function SliderField({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="slider-field">
      <label>
        <span>{label}</span>
        <output>{format(value)}</output>
        <input
          className="mos-range"
          type="range"
          aria-label={label}
          style={
            {
              '--mos-range-fill': `${((value - min) / (max - min)) * 100}%`,
            } as React.CSSProperties
          }
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
      {hint && <small>{hint}</small>}
    </div>
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
  if (!icon.dataUrl)
    return <span className="icon-preview-empty" aria-hidden="true" />;
  return <img src={icon.dataUrl} alt="" />;
}
