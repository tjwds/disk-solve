import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "./lib/api";
import { errText, isMissing } from "./lib/errmsg";
import { fmtBytes } from "./lib/format";
import {
  defaultSettings, demoImages, leafName, moveItem,
  type Destination, type ImageFile, type SortSettings,
} from "./lib/sort";
import { ViewSeg, type SegView } from "./ViewSeg";

// ---- icons (match the app's stroke style) ------------------------------------
const S = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const IcImage = () => <svg viewBox="0 0 24 24" {...S}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>;
const IcDoc = () => <svg viewBox="0 0 24 24" {...S}><path d="M14 2v6h6" /><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /></svg>;
const IcVideo = () => <svg viewBox="0 0 24 24" {...S}><rect x="3" y="5" width="14" height="14" rx="2" /><path d="M21 8l-4 4 4 4z" /></svg>;
const IcAudio = () => <svg viewBox="0 0 24 24" {...S}><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>;
const IcFolder = () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>;
const IcCheck = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>;
const IcTrash = () => <svg viewBox="0 0 24 24" {...S}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>;
const IcSkip = () => <svg viewBox="0 0 24 24" {...S}><path d="M5 4l10 8-10 8z" /><path d="M19 5v14" /></svg>;
const IcUndo = () => <svg viewBox="0 0 24 24" {...S}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-4" /></svg>;
const IcGear = () => <svg viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.3 1.8 2 2 0 11-2.8 2.8 1.6 1.6 0 00-2.7 1.1 2 2 0 11-4 0 1.6 1.6 0 00-2.7-1.1 2 2 0 11-2.8-2.8 1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1 2 2 0 110-4 1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8 2 2 0 112.8-2.8 1.6 1.6 0 002.7-1.1 2 2 0 114 0 1.6 1.6 0 002.7 1.1 2 2 0 112.8 2.8 1.6 1.6 0 00-.3 1.8 1.6 1.6 0 001.5 1 2 2 0 110 4 1.6 1.6 0 00-1.5 1z" /></svg>;
const IcClose = () => <svg viewBox="0 0 24 24" {...S}><path d="M18 6L6 18M6 6l12 12" /></svg>;
const IcChevron = () => <svg viewBox="0 0 24 24" {...S}><path d="M9 18l6-6-6-6" /></svg>;
const IcBack = () => <svg viewBox="0 0 24 24" {...S}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>;
const IcPlus = () => <svg viewBox="0 0 24 24" {...S}><path d="M12 5v14M5 12h14" /></svg>;
const IcDesktop = () => <svg viewBox="0 0 24 24" {...S}><rect x="2" y="4" width="20" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></svg>;
const IcDownload = () => <svg viewBox="0 0 24 24" {...S}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></svg>;
const IcReveal = () => <svg viewBox="0 0 24 24" {...S}><path d="M3 7h6l2 2h10v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>;
const IcGrip = () => <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" /></svg>;

const FOLDER_COLORS = ["var(--c-photo)", "var(--c-docs)", "var(--c-audio)", "var(--c-archive)", "var(--c-dev)", "var(--c-video)"];
const FOLDER_BADGE = ["#f0a35e", "#3fb0a4", "#c189d6", "#d8b65c", "#5b8def", "#e8716d"];
const PHOTOS_BADGE = "#a855f7";
const SKIP_BADGE = "#9aa1ad";

function destColor(d: Destination, i: number): string {
  return d.kind === "photos" ? "" : FOLDER_COLORS[i % FOLDER_COLORS.length];
}
function destBadge(d: Destination, i: number): string {
  return d.kind === "photos" ? PHOTOS_BADGE : FOLDER_BADGE[i % FOLDER_BADGE.length];
}
function DestIcon({ dest, index, sm }: { dest: Destination; index: number; sm?: boolean }) {
  if (dest.kind === "photos") return <span className={"sf-dico photos" + (sm ? " sm" : "")} />;
  return <span className={"sf-dico" + (sm ? " sm" : "")} style={{ background: destColor(dest, index) }}><IcFolder /></span>;
}

// ---- status & summary types --------------------------------------------------
type Status =
  | { type: "file"; destId: string; destName: string }
  | { type: "trash" }
  | { type: "skip" };

interface UndoEntry { index: number; prev: Status | null; undo: () => Promise<void>; removed: boolean }

interface Summary {
  filed: number; trashed: number; skipped: number; reclaimable: number;
  byDest: { name: string; count: number; badge: string }[];
}

/** Which screen to open on mount. Anything but "overview" is a demo deep link
 *  used by the screenshot tool (see scripts/screenshot.sh). */
type SortInitial = "overview" | "locations" | "reviewer" | "complete";

interface DemoSeed { statuses: (Status | null)[]; idx: number; history: UndoEntry[] }

// Demo-only: a representative finished session, so the summary screen renders
// standalone for a screenshot.
const DEMO_SUMMARY: Summary = {
  filed: 31, trashed: 40, skipped: 13, reclaimable: 1_181_116_006,
  byDest: [
    { name: "Pictures", count: 18, badge: "#f0a35e" },
    { name: "Apple Photos", count: 9, badge: "#a855f7" },
    { name: "Screenshots", count: 4, badge: "#3fb0a4" },
  ],
};

// Demo-only: a representative mid-review state, so the reviewer screen renders
// standalone (a few thumbnails resolved, the rest pending) for a screenshot.
function demoReviewSeed(queue: ImageFile[], dests: Destination[]): DemoSeed {
  const statuses: (Status | null)[] = queue.map(() => null);
  const fileTo = (d?: Destination): Status => (d ? { type: "file", destId: d.id, destName: d.name } : { type: "skip" });
  if (queue.length > 0) statuses[0] = fileTo(dests[0]);
  if (queue.length > 1) statuses[1] = fileTo(dests[1] ?? dests[0]);
  if (queue.length > 2) statuses[2] = { type: "trash" };
  if (queue.length > 3) statuses[3] = { type: "skip" };
  const history: UndoEntry[] = [];
  statuses.forEach((s, i) => { if (s) history.push({ index: i, prev: null, undo: async () => {}, removed: s.type !== "skip" }); });
  return { statuses, idx: Math.min(4, Math.max(0, queue.length - 1)), history };
}

// =============================================================================
export default function SortFlow({ home, onClose, initial = "overview", scope = null, onSelectView }: {
  home: string | null; onClose: () => void; initial?: SortInitial; scope?: string | null; onSelectView?: (m: SegView) => void;
}) {
  const tauri = api.isTauri();
  const [settings, setSettings] = useState<SortSettings | null>(null);
  const [images, setImages] = useState<ImageFile[] | null>(null);
  const [step, setStep] = useState<"overview" | "reviewer" | "complete">(
    initial === "reviewer" ? "reviewer" : initial === "complete" ? "complete" : "overview",
  );
  // Filing locations is an overlay, not a step, so opening it mid-review keeps
  // the reviewer mounted (and its session intact) underneath.
  const [settingsOpen, setSettingsOpen] = useState(initial === "locations");
  const [queue, setQueue] = useState<ImageFile[]>([]);
  const [summary, setSummary] = useState<Summary | null>(initial === "complete" && !tauri ? DEMO_SUMMARY : null);
  const [session, setSession] = useState(0); // bump to remount the reviewer fresh
  const [error, setError] = useState<string | null>(null);

  // Load settings once.
  useEffect(() => {
    (async () => {
      try {
        if (tauri) { setSettings(await api.loadSettings()); return; }
        const saved = localStorage.getItem("disksolve.sortSettings");
        setSettings(saved ? (JSON.parse(saved) as SortSettings) : defaultSettings(home ?? "/demo"));
      } catch {
        setSettings(defaultSettings(home ?? "~"));
      }
    })();
  }, [tauri, home]);

  // (Re)load the loose images whenever the folder set changes. A `scope` (the
  // folder the user clicked "Organize" on) overrides the configured sources and
  // opens the reviewer directly for that one folder.
  const folders = scope ? [scope] : (settings?.sources ?? []);
  const sourceKey = folders.join("|");
  // When scoped, `sourceKey` doesn't depend on settings, so the effect would run
  // once before settings load (and bail) and never again. Re-run when settings
  // first arrive so the scoped reviewer actually loads.
  const settingsReady = settings != null;
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    (async () => {
      try {
        const all = tauri ? await api.listLooseImages(folders) : demoImages();
        // In the browser demo a scope can only narrow the canned image set.
        const imgs = !tauri && scope ? all.filter((i) => i.source === leafName(scope)) : all;
        if (!cancelled) {
          setImages(imgs);
          // A scope (or the screenshot deep link) opens the reviewer straight away.
          if ((scope || initial === "reviewer") && imgs.length) {
            setQueue(imgs); setSession((s) => s + 1); setStep("reviewer");
          }
        }
      } catch (e) {
        if (!cancelled) { setError(errText(e)); setImages([]); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauri, sourceKey, settingsReady]);

  const persistSettings = useCallback((next: SortSettings) => {
    setSettings(next);
    if (tauri) api.saveSettings(next).catch((e) => setError(errText(e)));
    else localStorage.setItem("disksolve.sortSettings", JSON.stringify(next));
  }, [tauri]);

  const startPile = useCallback((subset: ImageFile[]) => {
    if (subset.length === 0) return;
    setQueue(subset);
    setSession((s) => s + 1);
    setStep("reviewer");
  }, []);

  const onComplete = useCallback((s: Summary) => { setSummary(s); setStep("complete"); }, []);

  // Keep the master image list in sync as the reviewer resolves files, so the
  // overview counts update and a re-entered session never offers a file that has
  // already been moved or trashed (which would fail with "path does not exist").
  const removeImage = useCallback((path: string) => {
    setImages((imgs) => (imgs ? imgs.filter((i) => i.path !== path) : imgs));
  }, []);
  const restoreImage = useCallback((img: ImageFile) => {
    setImages((imgs) => (imgs && !imgs.some((i) => i.path === img.path) ? [img, ...imgs] : imgs));
  }, []);

  const stepCtx = step === "reviewer" ? "Sorting images" : step === "complete" ? "Sorting complete" : "Get organized";

  return (
    <div className="app sortflow">
      <SortTitlebar ctx={stepCtx} onClose={onClose} onSettings={() => setSettingsOpen(true)} view="organize" onSelectView={onSelectView} />
      {error && <div className="sf-error" onClick={() => setError(null)}>{error} · click to dismiss</div>}

      {!settings || !images ? (
        <div className="sf-flow"><div className="state">Loading…</div></div>
      ) : step === "reviewer" ? (
        <Reviewer
          key={session}
          queue={queue} destinations={settings.destinations} tauri={tauri} active={!settingsOpen}
          demoSeed={!tauri && initial === "reviewer" && queue.length ? demoReviewSeed(queue, settings.destinations) : undefined}
          onComplete={onComplete} onExit={() => setStep("overview")} onError={setError}
          onRemoveImage={removeImage} onRestoreImage={restoreImage}
        />
      ) : step === "complete" ? (
        <Complete summary={summary!} tauri={tauri} onSortMore={() => setStep("overview")} onClose={onClose} onSettings={() => setSettingsOpen(true)} />
      ) : scope ? (
        <ScopedEmpty folder={scope} onBack={onClose} />
      ) : (
        <Overview settings={settings} images={images} onStart={startPile} onSettings={() => setSettingsOpen(true)} />
      )}

      {settingsOpen && settings && images && (
        <div className="sf-overlay">
          <SortTitlebar ctx="Filing locations" onClose={() => setSettingsOpen(false)} />
          <SettingsPanel settings={settings} images={images} tauri={tauri} home={home} onChange={persistSettings} onClose={() => setSettingsOpen(false)} />
        </div>
      )}
    </div>
  );
}

// ---- titlebar ----------------------------------------------------------------
function SortTitlebar({ ctx, onClose, onSettings, view, onSelectView }: {
  ctx: string; onClose: () => void; onSettings?: () => void; view?: SegView; onSelectView?: (m: SegView) => void;
}) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="app-name">disk<span className="dot">·</span>solve</div>
      <span className="sf-tb-sep">›</span>
      <span className="sf-tb-ctx">{ctx}</span>
      <div className="sf-tb-tools">
        {onSelectView && <ViewSeg view={view ?? "organize"} onSelect={onSelectView} />}
        {onSettings && (<button className="sf-iconbtn" title="Filing locations" onClick={onSettings}><IcGear /></button>)}
        {/* The seg itself navigates out of the sort flow, so the close button is
            only needed where there's no seg (the Filing locations overlay). */}
        {!onSelectView && <button className="sf-iconbtn" title="Close" onClick={onClose}><IcClose /></button>}
      </div>
    </div>
  );
}

// Shown when "Organize" is clicked on a folder with no loose images at its top
// level — the scoped flow has nothing to put in the reviewer.
function ScopedEmpty({ folder, onBack }: { folder: string; onBack: () => void }) {
  return (
    <div className="sf-flow">
      <div className="sf-inner narrow">
        <div className="sf-hero">
          <div className="sf-check"><IcCheck /></div>
          <h1 className="sf-h1">Nothing to sort here</h1>
          <p className="sf-lede">No loose images at the top level of <b>{leafName(folder)}</b>.</p>
        </div>
        <div className="sf-done-actions"><button className="btn" onClick={onBack}>Back to disk view</button></div>
      </div>
    </div>
  );
}

// ---- overview ----------------------------------------------------------------
function Overview({ settings, images, onStart, onSettings }: {
  settings: SortSettings; images: ImageFile[]; onStart: (subset: ImageFile[]) => void; onSettings: () => void;
}) {
  const piles = settings.sources.map((src) => {
    const label = leafName(src);
    const items = images.filter((i) => i.source === label);
    const bytes = items.reduce((s, i) => s + i.size, 0);
    return { src, label, items, bytes };
  });

  return (
    <div className="sf-flow">
      <div className="sf-inner">
        <h1 className="sf-h1">Get organized</h1>

        <div className="sf-typeseg">
          <button className="on"><IcImage /> Images <span className="sf-dim">· {images.length}</span></button>
          <button className="soon"><IcDoc /> Documents <span className="sf-soon">soon</span></button>
          <button className="soon"><IcVideo /> Video <span className="sf-soon">soon</span></button>
          <button className="soon"><IcAudio /> Audio <span className="sf-soon">soon</span></button>
        </div>

        <div className="sf-piles">
          {piles.map((p) => (
            <button key={p.src} className="sf-pile" disabled={p.items.length === 0} onClick={() => onStart(p.items)}>
              <span className="sf-pile-ico">{p.label === "Downloads" ? <IcDownload /> : <IcDesktop />}</span>
              <span className="sf-pile-meta">
                <span className="sf-pile-t">{p.label}</span>
                <span className="sf-pile-s">{p.items.length === 0 ? "No loose images" : <><b>{p.items.length} image{p.items.length === 1 ? "" : "s"}</b> · {fmtBytes(p.bytes)}</>}</span>
              </span>
              {p.items.length > 0 && <span className="sf-go">Sort <IcChevron /></span>}
            </button>
          ))}
          {piles.length > 1 && images.length > 0 && (
            <button className="sf-pile all" onClick={() => onStart(images)}>
              <span className="sf-pile-ico accent"><svg viewBox="0 0 24 24" {...S}><path d="M4 7h16M4 12h16M4 17h10" /></svg></span>
              <span className="sf-pile-meta">
                <span className="sf-pile-t">All loose images</span>
                <span className="sf-pile-s"><b>{images.length} images</b> · {fmtBytes(images.reduce((s, i) => s + i.size, 0))} · newest first</span>
              </span>
              <span className="sf-go">Sort all <IcChevron /></span>
            </button>
          )}
        </div>

        <div className="sf-destcard">
          <div className="sf-destcard-top">
            <h3 className="sf-sech">Filing locations for images</h3>
            <button className="sf-link" onClick={onSettings}><IcGear /> Configure</button>
          </div>
          <div className="sf-dests">
            {settings.destinations.map((d, i) => (
              <div className="sf-dest" key={d.id}>
                <span className="sf-key">{i + 1}</span>
                <DestIcon dest={d} index={i} sm />
                <span><span className="sf-dn">{d.name}</span><div className="sf-dp">{d.kind === "photos" ? "Import to library" : d.path}</div></span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- settings ----------------------------------------------------------------
function SettingsPanel({ settings, images, tauri, home, onChange, onClose }: {
  settings: SortSettings; images: ImageFile[]; tauri: boolean; home: string | null;
  onChange: (s: SortSettings) => void; onClose: () => void;
}) {
  // Pointer-based drag reorder (HTML5 DnD is unreliable in WebKit). While
  // dragging, `live` holds the working order; it's persisted on pointer-up.
  const listRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<Destination[] | null>(null);
  const [live, setLive] = useState<Destination[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const list = live ?? settings.destinations;

  const pickFolder = useCallback(async (prompt: string): Promise<string | null> => {
    if (tauri) return api.chooseFolder(prompt);
    const p = window.prompt(prompt, `${home ?? "~"}/`);
    return p && p.trim() ? p.trim().replace(/\/+$/, "") : null;
  }, [tauri, home]);

  const setDestinations = (destinations: Destination[]) => onChange({ ...settings, destinations });
  const setSources = (sources: string[]) => onChange({ ...settings, sources });

  const removeDest = (id: string) => setDestinations(settings.destinations.filter((d) => d.id !== id));
  const addFolderDest = async () => {
    const path = await pickFolder("Choose a filing location");
    if (!path || settings.destinations.some((d) => d.path === path)) return;
    setDestinations([...settings.destinations, { id: path, name: leafName(path), kind: "folder", path }]);
  };
  const addPhotos = () => {
    if (settings.destinations.some((d) => d.kind === "photos")) return;
    setDestinations([...settings.destinations, { id: "apple-photos", name: "Apple Photos", kind: "photos", path: null }]);
  };

  const startDrag = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    const init = settings.destinations.slice();
    liveRef.current = init;
    setLive(init);
    setDragId(id);
  };

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const cur = liveRef.current;
      const container = listRef.current;
      if (!cur || !container) return;
      const rows = Array.from(container.querySelectorAll<HTMLElement>(".sf-drow"));
      let target = rows.length - 1;
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { target = k; break; }
      }
      const from = cur.findIndex((d) => d.id === dragId);
      if (from === -1 || from === target) return;
      const next = moveItem(cur, from, target);
      liveRef.current = next;
      setLive(next);
    };
    const onUp = () => {
      if (liveRef.current) onChange({ ...settings, destinations: liveRef.current });
      liveRef.current = null;
      setLive(null);
      setDragId(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragId, settings, onChange]);

  const removeSource = (src: string) => setSources(settings.sources.filter((s) => s !== src));
  const addSource = async () => {
    const path = await pickFolder("Choose a folder to tidy");
    if (!path || settings.sources.includes(path)) return;
    setSources([...settings.sources, path]);
  };

  return (
    <>
      <div className="sf-flow">
        <div className="sf-inner narrow">
          <h1 className="sf-h1 sm">Filing locations</h1>

          <div className="sf-typeseg">
            <button className="on"><IcImage /> Images</button>
            <button className="soon"><IcDoc /> Documents</button>
            <button className="soon"><IcVideo /> Video</button>
            <button className="soon"><IcAudio /> Audio</button>
          </div>

          <h3 className="sf-sech">File images to</h3>
          <p className="sf-subh">Drag to reorder. The order sets the number keys.</p>
          <div className="sf-deslist" ref={listRef}>
            {list.map((d, i) => (
              <div key={d.id} className={"sf-drow" + (dragId === d.id ? " dragging" : "")}>
                <span className="sf-grip" title="Drag to reorder" onPointerDown={(e) => startDrag(e, d.id)}><IcGrip /></span>
                <span className="sf-key">{i + 1}</span>
                <DestIcon dest={d} index={i} />
                <span className="sf-dmeta">
                  <div className="sf-dn">{d.name}</div>
                  <div className="sf-dp">{d.kind === "photos" ? "Imports into Photos, then removes the original" : d.path}</div>
                </span>
                <span className={"sf-tag" + (d.kind === "photos" ? " import" : "")}>{d.kind === "photos" ? "Import" : "Move here"}</span>
                <button className="sf-rm" title="Remove" onClick={() => removeDest(d.id)}><IcClose /></button>
              </div>
            ))}
          </div>

          <div className="sf-addrow">
            <button className="sf-addbtn" onClick={addFolderDest}><IcPlus /> Add a folder…</button>
            {!settings.destinations.some((d) => d.kind === "photos") && (
              <button className="sf-addbtn" onClick={addPhotos}><span className="sf-pico" /> Add Apple Photos</button>
            )}
          </div>

          <h3 className="sf-sech">Folders to tidy</h3>
          <p className="sf-subh">disk·solve looks for loose images in these folders.</p>
          <div className="sf-srclist">
            {settings.sources.map((src) => {
              const label = leafName(src);
              const count = images.filter((i) => i.source === label).length;
              return (
                <div className="sf-srcrow" key={src}>
                  <span className="sf-srcico">{label === "Downloads" ? <IcDownload /> : <IcDesktop />}</span>
                  <span className="sf-dmeta"><div className="sf-dn">{label}</div><div className="sf-dp">{src}</div></span>
                  <span className="sf-srccount">{count} image{count === 1 ? "" : "s"}</span>
                  <button className="sf-rm" title="Remove" onClick={() => removeSource(src)}><IcClose /></button>
                </div>
              );
            })}
            <button className="sf-addbtn wide" onClick={addSource}><IcPlus /> Add a folder…</button>
          </div>
        </div>
      </div>
      <div className="sf-footbar">
        <button className="btn" onClick={onClose}><IcBack /> Back</button>
        <span className="sf-hint">Changes save automatically</span>
        <span className="sf-spacer" />
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

// Filmstrip windowing: thumbnail row stride (80px cell + 8px gap) and how many
// extra rows to render beyond the viewport so scrolling never reveals a gap.
const THUMB_STRIDE = 88;
const THUMB_OVERSCAN = 6;

// ---- reviewer ----------------------------------------------------------------
function Reviewer({ queue, destinations, tauri, active, demoSeed, onComplete, onExit, onError, onRemoveImage, onRestoreImage }: {
  queue: ImageFile[]; destinations: Destination[]; tauri: boolean; active: boolean; demoSeed?: DemoSeed;
  onComplete: (s: Summary) => void; onExit: () => void; onError: (e: string) => void;
  onRemoveImage: (path: string) => void; onRestoreImage: (img: ImageFile) => void;
}) {
  const dests = destinations.slice(0, 9); // keys 1–9
  const [idx, setIdx] = useState(demoSeed?.idx ?? 0);
  const [statuses, setStatuses] = useState<(Status | null)[]>(() => demoSeed?.statuses ?? queue.map(() => null));
  const [history, setHistory] = useState<UndoEntry[]>(() => demoSeed?.history ?? []);
  const [toast, setToast] = useState<{ text: string; badge: string; icon: "check" | "trash" | "skip" | "undo" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dims, setDims] = useState<Record<string, string>>({});
  const toastTimer = useRef<number | undefined>(undefined);

  // Window the filmstrip: only the thumbnails in view are mounted, so a pile of
  // hundreds/thousands of images opens at once instead of building every cell
  // (and its <img>) up front. Mirrors the list view's windowing in App.tsx.
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripScroll, setStripScroll] = useState(0);
  const [stripH, setStripH] = useState(640);

  const processed = statuses.filter(Boolean).length;
  const done = processed === queue.length;

  const flashToast = useCallback((t: { text: string; badge: string; icon: "check" | "trash" | "skip" | "undo" }) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const advance = useCallback((from: number, next: (Status | null)[]) => {
    let j = from + 1;
    while (j < queue.length && next[j]) j++;
    if (j < queue.length) { setIdx(j); return; }
    let k = 0;
    while (k < queue.length && next[k]) k++;
    setIdx(k < queue.length ? k : Math.min(from, queue.length - 1));
  }, [queue.length]);

  const act = useCallback(async (kind: "file" | "trash" | "skip", dest?: Destination) => {
    if (!active || busy || done) return;
    const i = idx;
    const f = queue[i];
    if (!f || statuses[i]) return;
    let status: Status;
    let undo: () => Promise<void> = async () => {};
    let removed = false;
    try {
      if (kind === "file" && dest) {
        if (tauri) {
          if (dest.kind === "photos") {
            const trashed = await run(setBusy, () => api.fileToPhotos(f.path));
            undo = () => api.sortRestore(trashed, f.path);
          } else if (dest.path) {
            const moved = await run(setBusy, () => api.fileImage(f.path, dest.path!));
            undo = () => api.sortRestore(moved, f.path);
          }
        }
        removed = true;
        status = { type: "file", destId: dest.id, destName: dest.name };
        flashToast({ text: `Filed to ${dest.name}`, badge: destBadge(dest, dests.indexOf(dest)), icon: "check" });
      } else if (kind === "trash") {
        if (tauri) { const trashed = await run(setBusy, () => api.sortTrash(f.path)); undo = () => api.sortRestore(trashed, f.path); }
        removed = true;
        status = { type: "trash" };
        flashToast({ text: `Moved ${f.name} to Trash`, badge: "var(--red)", icon: "trash" });
      } else {
        status = { type: "skip" };
        flashToast({ text: `Skipped — left in ${f.source}`, badge: SKIP_BADGE, icon: "skip" });
      }
    } catch (e) {
      // The file is already gone (e.g. moved/trashed outside this session): don't
      // get stuck — drop it from the queue and move on instead of erroring.
      if (isMissing(e)) {
        onRemoveImage(f.path);
        const next = statuses.slice();
        next[i] = { type: "skip" };
        setStatuses(next);
        flashToast({ text: `${f.name} is no longer there`, badge: SKIP_BADGE, icon: "skip" });
        advance(i, next);
        return;
      }
      onError(errText(e));
      return; // don't advance or record on a real failure
    }
    if (removed) onRemoveImage(f.path);
    const next = statuses.slice();
    next[i] = status;
    setStatuses(next);
    setHistory((h) => [...h, { index: i, prev: null, undo, removed }]);
    advance(i, next);
  }, [active, busy, done, idx, queue, statuses, tauri, dests, flashToast, advance, onError, onRemoveImage]);

  const undoLast = useCallback(async () => {
    if (!active || busy || history.length === 0) return;
    const entry = history[history.length - 1];
    try { await run(setBusy, entry.undo); }
    catch (e) { onError(errText(e)); return; }
    if (entry.removed) onRestoreImage(queue[entry.index]);
    const next = statuses.slice();
    next[entry.index] = entry.prev;
    setStatuses(next);
    setHistory((h) => h.slice(0, -1));
    setIdx(entry.index);
    flashToast({ text: "Undid the last action", badge: SKIP_BADGE, icon: "undo" });
  }, [active, busy, history, statuses, queue, flashToast, onError, onRestoreImage]);

  const move = useCallback((d: number) => setIdx((i) => Math.max(0, Math.min(queue.length - 1, i + d))), [queue.length]);

  // Keyboard: read the latest handler via a ref so the listener stays stable.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (!active) return; // the settings overlay is open — it owns input
    if (e.metaKey || e.ctrlKey) { if (e.key === "z" || e.key === "Z") { e.preventDefault(); undoLast(); } return; }
    if (e.altKey) return;
    const k = e.key;
    if (k === "ArrowRight") { e.preventDefault(); move(1); return; }
    if (k === "ArrowLeft") { e.preventDefault(); move(-1); return; }
    if (k === "0") { e.preventDefault(); act("trash"); return; }
    if (k === "s" || k === "S") { e.preventDefault(); act("skip"); return; }
    if (k >= "1" && k <= "9") { const di = Number(k) - 1; if (di < dests.length) { e.preventDefault(); act("file", dests[di]); } }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Measure the filmstrip's height so the visible window tracks its real size.
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setStripH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const summary = useMemo((): Summary => {
    let filed = 0, trashed = 0, skipped = 0, reclaimable = 0;
    const byDest = new Map<string, { name: string; count: number; badge: string }>();
    statuses.forEach((s, i) => {
      if (!s) return;
      if (s.type === "file") {
        filed++;
        const di = dests.findIndex((d) => d.id === s.destId);
        const d = destinations.find((d) => d.id === s.destId);
        const key = s.destId;
        const cur = byDest.get(key) ?? { name: s.destName, count: 0, badge: d ? destBadge(d, di) : PHOTOS_BADGE };
        cur.count++; byDest.set(key, cur);
        if (d?.kind === "photos") reclaimable += queue[i].size; // original goes to Trash
      } else if (s.type === "trash") { trashed++; reclaimable += queue[i].size; }
      else skipped++;
    });
    return { filed, trashed, skipped, reclaimable, byDest: [...byDest.values()] };
  }, [statuses, dests, destinations, queue]);

  const cur = queue[idx];
  const curDim = cur ? (dims[cur.path] ?? cur.dim) : undefined;

  // Visible slice of the filmstrip, with overscan above and below.
  const tTotal = queue.length;
  const tStart = Math.max(0, Math.floor(stripScroll / THUMB_STRIDE) - THUMB_OVERSCAN);
  const tEnd = Math.min(tTotal, Math.ceil((stripScroll + stripH) / THUMB_STRIDE) + THUMB_OVERSCAN);

  return (
    <div className="sf-rbody">
      {/* filmstrip */}
      <aside className="sf-strip">
        <div className="sf-strip-h">
          <div className="sf-pcap"><span>Reviewed</span><b>{processed} / {queue.length}</b></div>
          <div className="sf-pbar"><i style={{ width: `${(processed / Math.max(1, queue.length)) * 100}%` }} /></div>
        </div>
        <div className="sf-strip-list" ref={stripRef} onScroll={(e) => setStripScroll(e.currentTarget.scrollTop)}>
          <div style={{ height: tStart * THUMB_STRIDE }} />
          {queue.slice(tStart, tEnd).map((f, j) => {
            const i = tStart + j;
            return (
              <div key={f.path} className={"sf-thumb" + (i === idx ? " cur" : "") + (statuses[i] ? " done" : "")} onClick={() => setIdx(i)}>
                <img src={previewSrc(f, tauri)} alt="" draggable={false} loading="lazy" decoding="async" />
                <span className="sf-num">{i + 1}</span>
                <Badge status={statuses[i]} dests={dests} />
              </div>
            );
          })}
          <div style={{ height: (tTotal - tEnd) * THUMB_STRIDE }} />
        </div>
      </aside>

      {/* stage */}
      <main className="sf-stage">
        <div className="sf-stage-head">
          <span className="sf-srcico">{cur?.source === "Downloads" ? <IcDownload /> : <IcDesktop />}</span>
          <div className="sf-sh-meta">
            <div className="sf-fn">{cur?.name ?? "—"}</div>
            <div className="sf-path">{cur ? sourcePath(cur) : ""}</div>
          </div>
          <div className="sf-exifs">
            {curDim && <span className="sf-exif">{curDim}</span>}
            {cur && <span className="sf-exif">{fmtBytes(cur.size)}</span>}
            {cur && <span className="sf-exif">{cur.ext.toUpperCase()}</span>}
          </div>
          {tauri && cur && (
            <button className="sf-iconbtn" title="Show in Finder" onClick={() => api.revealInFinder(cur.path).catch((e) => onError(errText(e)))}>
              <IcReveal />
            </button>
          )}
        </div>
        <div className="sf-stage-view">
          <button className="sf-nav prev" title="Previous (←)" onClick={() => move(-1)}><svg viewBox="0 0 24 24" {...S}><path d="M15 18l-6-6 6-6" /></svg></button>
          {cur && (
            <div className="sf-frame">
              <img
                src={previewSrc(cur, tauri)} alt={cur.name} draggable={false}
                onLoad={(e) => {
                  const im = e.currentTarget;
                  if (im.naturalWidth && !cur.previewUrl) setDims((d) => ({ ...d, [cur.path]: `${im.naturalWidth} × ${im.naturalHeight}` }));
                }}
              />
            </div>
          )}
          <button className="sf-nav next" title="Next (→)" onClick={() => move(1)}><IcChevron /></button>
          {toast && (
            <div className="sf-toast show">
              <span className="sf-tdot" style={{ background: toast.badge }}>{toastIcon(toast.icon)}</span>
              <span>{toast.text}</span>
            </div>
          )}
          {done && (
            <div className="sf-done show">
              <div className="sf-done-card">
                <div className="sf-done-check"><IcCheck /></div>
                <h2>All caught up</h2>
                <p>You reviewed every image in this batch.</p>
                <div className="sf-done-stats">
                  <div className="sf-dstat f"><b>{summary.filed}</b><span>filed</span></div>
                  <div className="sf-dstat t"><b>{summary.trashed}</b><span>trashed</span></div>
                  <div className="sf-dstat s"><b>{summary.skipped}</b><span>skipped</span></div>
                </div>
                <div className="sf-done-actions">
                  <button className="btn" onClick={onExit}>Sort something else</button>
                  <button className="btn primary" onClick={() => onComplete(summary)}>View summary <IcChevron /></button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* action panel */}
      <aside className="sf-panel">
        <div className="sf-panel-h">File this image to</div>
        <div className="sf-acts">
          {dests.map((d, i) => (
            <button key={d.id} className="sf-act" onClick={() => act("file", d)} disabled={busy || done}>
              <span className="sf-key">{i + 1}</span>
              <DestIcon dest={d} index={i} />
              <span className="sf-am"><div className="sf-am-t">{d.name}</div><div className="sf-am-p">{d.kind === "photos" ? "Import to library" : d.path}</div></span>
            </button>
          ))}
          <div className="sf-actdiv">or</div>
          <button className="sf-act trash" onClick={() => act("trash")} disabled={busy || done}>
            <span className="sf-key red">0</span>
            <span className="sf-dico gico"><IcTrash /></span>
            <span className="sf-am"><div className="sf-am-t">Move to Trash</div><div className="sf-am-p">Recoverable until you empty it</div></span>
          </button>
          <button className="sf-act skip" onClick={() => act("skip")} disabled={busy || done}>
            <span className="sf-key ghost">S</span>
            <span className="sf-dico sico"><IcSkip /></span>
            <span className="sf-am"><div className="sf-am-t">Skip for now</div><div className="sf-am-p">Leave it where it is</div></span>
          </button>
        </div>
        <div className="sf-panel-foot">
          <button className="sf-undo" onClick={undoLast} disabled={busy || history.length === 0}><IcUndo /> Undo <span className="sf-key">⌘Z</span></button>
          <div className="sf-undo-meta">{history.length ? <><b>{history.length}</b> action{history.length === 1 ? "" : "s"} can be undone</> : "Nothing to undo yet"}</div>
        </div>
      </aside>

      {/* shortcut legend */}
      <div className="sf-legend">
        <span className="sf-lg"><span className="sf-keys"><span className="sf-key">1</span>–<span className="sf-key">9</span></span> File to location</span>
        <span className="sf-lg"><span className="sf-key">0</span> Trash</span>
        <span className="sf-lg"><span className="sf-key">S</span> Skip</span>
        <span className="sf-lg"><span className="sf-key">⌘Z</span> Undo</span>
        <span className="sf-lg"><span className="sf-keys"><span className="sf-key">←</span><span className="sf-key">→</span></span> Browse</span>
      </div>
    </div>
  );
}

function Badge({ status, dests }: { status: Status | null; dests: Destination[] }) {
  if (!status) return null;
  if (status.type === "file") {
    const i = dests.findIndex((d) => d.id === status.destId);
    const d = dests[i];
    const color = d ? destBadge(d, i) : PHOTOS_BADGE;
    return <span className="sf-badge" style={{ background: color }}><IcCheck /></span>;
  }
  if (status.type === "trash") return <span className="sf-badge" style={{ background: "var(--red)" }}><IcTrash /></span>;
  return <span className="sf-badge" style={{ background: SKIP_BADGE }}><IcSkip /></span>;
}

// ---- complete ----------------------------------------------------------------
function Complete({ summary, tauri, onSortMore, onClose, onSettings }: {
  summary: Summary; tauri: boolean;
  onSortMore: () => void; onClose: () => void; onSettings: () => void;
}) {
  const total = summary.filed + summary.trashed + summary.skipped;
  const maxCount = Math.max(1, ...summary.byDest.map((d) => d.count));
  const emptyTrash = () => { if (tauri) api.openTrash().catch(() => {}); };

  return (
    <>
      <div className="sf-flow">
        <div className="sf-inner narrow">
          <div className="sf-hero">
            <div className="sf-check"><IcCheck /></div>
            <h1 className="sf-h1">Sorting complete</h1>
            <p className="sf-lede">You reviewed <b>{total} image{total === 1 ? "" : "s"}</b> in this session. Here's where everything went.</p>
          </div>

          <div className="sf-stats">
            <div className="sf-stat filed"><div className="num">{summary.filed}</div><div className="lab">Filed away</div></div>
            <div className="sf-stat trashed"><div className="num">{summary.trashed}</div><div className="lab">Sent to Trash</div></div>
            <div className="sf-stat skipped"><div className="num">{summary.skipped}</div><div className="lab">Skipped</div></div>
            <div className="sf-stat space"><div className="num">{fmtBytes(summary.reclaimable)}</div><div className="lab">Reclaimable</div></div>
          </div>

          {summary.byDest.length > 0 && (
            <>
              <h3 className="sf-sech">Where things went</h3>
              <div className="sf-card">
                {summary.byDest.map((d) => (
                  <div className="sf-brow" key={d.name}>
                    <span className="sf-bdot" style={{ background: d.badge }} />
                    <span className="sf-dn">{d.name}</span>
                    <span className="sf-bcount">
                      <span className="sf-btrack"><i style={{ width: `${(d.count / maxCount) * 100}%`, background: d.badge }} /></span>
                      <b>{d.count}</b>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {summary.trashed > 0 && (
            <div className="sf-callout">
              <div className="sf-ci"><IcTrash /></div>
              <div className="sf-cm">
                <div className="sf-ct">{summary.trashed} image{summary.trashed === 1 ? "" : "s"} in the Trash</div>
                <div className="sf-cs">Frees {fmtBytes(summary.reclaimable)} once emptied. Nothing is deleted until you do.</div>
              </div>
              <button className="btn danger" onClick={emptyTrash}>Open Trash</button>
            </div>
          )}
          {summary.skipped > 0 && (
            <div className="sf-skipnote">
              <div className="sf-si"><IcSkip /></div>
              <div><b>{summary.skipped} skipped</b> — left exactly where they were.</div>
            </div>
          )}
        </div>
      </div>
      <div className="sf-footbar">
        <button className="btn" onClick={onClose}>Done</button>
        <span className="sf-spacer" />
        <button className="btn" onClick={onSettings}><IcGear /> Filing locations</button>
        <button className="btn primary" onClick={onSortMore}>Sort more <IcChevron /></button>
      </div>
    </>
  );
}

// ---- helpers -----------------------------------------------------------------
function previewSrc(f: ImageFile, tauri: boolean): string {
  if (f.previewUrl) return f.previewUrl;
  return tauri ? convertFileSrc(f.path) : "";
}
function sourcePath(f: ImageFile): string {
  // Demo paths look like /demo/Desktop/x; show a ~-style path either way.
  return f.path.replace(/^\/demo/, "~").replace(/^\/Users\/[^/]+/, "~");
}
function toastIcon(icon: "check" | "trash" | "skip" | "undo") {
  return icon === "check" ? <IcCheck /> : icon === "trash" ? <IcTrash /> : icon === "undo" ? <IcUndo /> : <IcSkip />;
}
/** Run an async op with a busy flag so double-presses can't race the filesystem. */
async function run<T>(setBusy: (b: boolean) => void, op: () => Promise<T>): Promise<T> {
  setBusy(true);
  try { return await op(); }
  finally { setBusy(false); }
}
