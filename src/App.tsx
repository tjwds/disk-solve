import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Category, DupGroup, DupReport, Node, ScanResult, TimeMachineStatus } from "./lib/types";
import { squarify, type Tile } from "./lib/treemap";
import { fmtBytes, fmtRelTime, isStale } from "./lib/format";
import { reclaimable, largestDirNamed, largestDirOfCategory, type Suggestion } from "./lib/suggestions";
import { typeStats, buildColorMap, colorForNode, type LegendEntry } from "./lib/filetypes";
import { sortItems, resolveFilter, collectByName, withoutAggregates, parentName, shortenPath, type SortKey, type SortDir } from "./lib/listview";
import { removePaths } from "./lib/tree";
import { baseName, keeperOf, pruneDupReport } from "./lib/dups";
import { makeDemoTree, demoDuplicates } from "./lib/demo";
import { errText, isMissing, isUnresponsive, trashFailureText } from "./lib/errmsg";
import { notify } from "./lib/notify";
import { demoImages, leafName } from "./lib/sort";
import * as api from "./lib/api";
import SortFlow from "./SortFlow";
import { ViewSeg, type SegView } from "./ViewSeg";

const CAT_COLOR: Record<Category, string> = {
  dev: "#5b8def", video: "#e8716d", audio: "#c189d6", photo: "#f0a35e", docs: "#3fb0a4",
  apps: "#76c269", system: "#9aa1ad", cache: "#c5cad3", archive: "#d8b65c", trash: "#b8939c", other: "#b9bfca",
};
// The Finder app face: a squircle with two eyes, a nose, and a smile — distinct
// from the monochrome open/navigate controls so "Reveal in Finder" reads clearly.
const ICON_REVEAL = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M9 8.5v2" /><path d="M15 8.5v2" /><path d="M12 10.6v1.6l1.4 .9" /><path d="M8.5 15q3.5 2.5 7 0" /></svg>
);
const ICON_TRASH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
);
const ICON_OPEN = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6" /></svg>
);
const ICON_TERMINAL = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" /></svg>
);

interface ScanEvent { files: number; bytes: number; total: number }
interface ScanProgress { files: number; bytes: number; pct: number }
interface DupEvent { hashed: number; total: number; bytes: number }
type ViewMode = "treemap" | "list" | "dups";
interface ListSource { key: string; label: string; nameFromParent: boolean }
interface ConfirmData { title: string; detail: string; confirmLabel: string; onOk: () => void }

function findChain(root: Node, targetPath: string): Node[] {
  const chain: Node[] = [];
  const dfs = (node: Node): boolean => {
    chain.push(node);
    if (node.path === targetPath) return true;
    for (const c of node.children) if (dfs(c)) return true;
    chain.pop();
    return false;
  };
  return dfs(root) ? chain : [root];
}

// The folder within `root`'s subtree whose children include `target` (matched by
// identity, not path — aggregate "N smaller items" nodes all share an empty path).
// Lets a click on an aggregate tile drill into the folder that holds those items.
function parentOf(root: Node, target: Node): Node | null {
  let found: Node | null = null;
  const dfs = (n: Node): boolean => {
    for (const c of n.children) {
      if (c === target) { found = n; return true; }
      if (dfs(c)) return true;
    }
    return false;
  };
  dfs(root);
  return found;
}

// Re-anchor a navigation stack into a freshly edited tree by path. Nodes present
// in the (pruned) tree are re-anchored so their sizes update; folders that only
// exist in the full tree (reached by drilling a fetched list row) are kept as-is.
// Stops at an ancestor that was itself trashed.
function remapStack(tree: Node, old: Node[], removed: string[] = []): Node[] {
  const out: Node[] = [];
  for (const node of old) {
    if (removed.includes(node.path)) break;
    const chain = findChain(tree, node.path);
    const hit = chain[chain.length - 1];
    out.push(hit.path === node.path ? hit : node);
  }
  return out.length ? out : [tree];
}

export default function App() {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [stack, setStack] = useState<Node[]>([]);
  const [hover, setHover] = useState<Node | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const [tm, setTm] = useState<TimeMachineStatus | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [partial, setPartial] = useState<Node | null>(null); // tree built so far, shown while scanning
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("treemap");
  const [listSource, setListSource] = useState<ListSource | null>(null);
  const [listItems, setListItems] = useState<Node[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "size", dir: "desc" });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmData | null>(null);
  const [dups, setDups] = useState<DupReport | null>(null);
  const [dupScanning, setDupScanning] = useState(false);
  const [dupProgress, setDupProgress] = useState<{ hashed: number; total: number } | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [sortInitial, setSortInitial] = useState<"overview" | "locations" | "reviewer" | "complete">("overview");
  const [sortScope, setSortScope] = useState<string | null>(null); // folder to "Organize"; null = all configured sources
  const [loose, setLoose] = useState<{ count: number; bytes: number; sources: string[] } | null>(null);
  const sortOpenRef = useRef(false);
  sortOpenRef.current = sortOpen;
  const ranOnce = useRef(false);
  const dupRunRef = useRef(0); // ignore results from a superseded duplicate scan

  // Every failure lands here. It's a notice, not a mode: the scan already in
  // memory stays on screen and stays usable, and the message can be dismissed.
  const reportError = useCallback((e: unknown) => setError(errText(e)), []);

  // Collect the duplicate report once hashing (which began with the scan) drains.
  const runDups = useCallback((demoTree?: Node) => {
    const id = ++dupRunRef.current;
    setDupScanning(true);
    const work = api.isTauri() ? api.findDuplicates() : Promise.resolve(demoDuplicates(demoTree!));
    work
      .then((report) => {
        if (id !== dupRunRef.current) return; // a newer scan started
        setDups(report);
        setDupScanning(false);
      })
      .catch((e) => {
        if (id !== dupRunRef.current) return;
        setDupScanning(false);
        setError(errText(e));
      });
  }, []);

  const runScan = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      setProgress(null);
      setPartial(null); // the previous scan's preview shouldn't linger into this one
      dupRunRef.current++; // invalidate any in-flight duplicate scan
      setDups(null);
      setDupProgress(null);
      setDupScanning(true); // hashing starts on the backend together with the scan
      try {
        const result = await api.scanPath(path);
        setScan(result);
        setStack([result.tree]);
        setSelected(null);
        setListSource(null);
        setChecked(new Set());
        // Scans of a large disk can run for a while, so ping the user when one
        // finishes — but only if they've switched away from the window, since a
        // notification over the treemap they're already watching is just noise.
        if (!document.hasFocus()) {
          notify("Scan complete", `${result.files.toLocaleString()} files · ${fmtBytes(result.tree.size)}`);
        }
        runDups(); // collect the report once the streamed hashing finishes
      } catch (e) {
        // The previous scan (if any) is still in state, so the view it's showing
        // stays put; the message says why this one didn't replace it.
        setError(errText(e));
        setDupScanning(false);
      } finally {
        setLoading(false);
        setProgress(null);
      }
    },
    [runDups],
  );

  // Count the loose images across the configured source folders, for the sidebar
  // shortcut. Read-only (lstat + read_dir); refreshed on mount and when the sort
  // flow closes, since a sorting session may have filed or trashed some.
  const refreshLoose = useCallback(async () => {
    try {
      if (!api.isTauri()) {
        const imgs = demoImages();
        setLoose({ count: imgs.length, bytes: imgs.reduce((s, i) => s + i.size, 0), sources: [...new Set(imgs.map((i) => i.source))] });
        return;
      }
      const s = await api.loadSettings();
      const imgs = await api.listLooseImages(s.sources);
      setLoose({ count: imgs.length, bytes: imgs.reduce((s, i) => s + i.size, 0), sources: s.sources.map(leafName) });
    } catch {
      /* keep the prior count on failure */
    }
  }, []);

  const closeSort = useCallback(() => { setSortOpen(false); refreshLoose(); }, [refreshLoose]);

  // Anything that failed without a handler — a fire-and-forget action, a stray
  // rejection — becomes a dismissible notice instead of vanishing into the
  // console (or, in the worst case, leaving the user staring at a stale view).
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      e.preventDefault(); // we're showing it; no need for the console's version too
      console.error("disk-solve: unhandled rejection", e.reason);
      reportError(e.reason);
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, [reportError]);

  // The backend's streamed events. Only Tauri emits them; subscribing in the
  // browser demo just rejects (there is no IPC bridge), so don't.
  useEffect(() => {
    if (!api.isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    listen<ScanEvent>("scan-progress", (e) => {
      const { files, bytes, total } = e.payload;
      setProgress({ files, bytes, pct: total > 0 ? Math.min(0.99, bytes / total) : 0 });
    }).then((u) => (unlisten = u), reportError);
    return () => unlisten?.();
  }, [reportError]);

  useEffect(() => {
    if (!api.isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    listen<DupEvent>("dup-progress", (e) => {
      setDupProgress({ hashed: e.payload.hashed, total: e.payload.total });
    }).then((u) => (unlisten = u), reportError);
    return () => unlisten?.();
  }, [reportError]);

  // Snapshots of the tree as the scan builds it, rendered behind the overlay.
  useEffect(() => {
    if (!api.isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    listen<Node>("scan-partial", (e) => setPartial(e.payload)).then((u) => (unlisten = u), reportError);
    return () => unlisten?.();
  }, [reportError]);

  useEffect(() => { refreshLoose(); }, [refreshLoose]);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    if (!api.isTauri()) {
      const demo = makeDemoTree();
      setScan({ tree: demo, files: demo.item_count, dirs: 0, errors: 0 });
      setStack([demo]);
      setHome("/demo");
      setTm({ local_snapshots: 3, latest_backup: "/Volumes/Backups" });
      runDups(demo);
      // Demo-only: the screenshot generator opens a view via URL hash
      // (#list, #filter=node_modules, #dups, #scanning). Ignored by the real app.
      const f = /filter=([\w-]+)/.exec(window.location.hash);
      if (f) { setListSource(resolveFilter(f[1])); setView("list"); }
      else if (window.location.hash.includes("sort")) {
        const h = window.location.hash;
        setSortInitial(h.includes("locations") ? "locations" : h.includes("review") ? "reviewer" : h.includes("done") || h.includes("complete") ? "complete" : "overview");
        setSortOpen(true);
      }
      else if (window.location.hash.includes("dups")) setView("dups");
      else if (window.location.hash.includes("list")) setView("list");
      else if (window.location.hash.includes("scanning")) {
        // Freeze the app mid-scan: the demo tree stands in for the partial tree
        // that the Rust scanner streams, rendered behind the scanning overlay.
        setPartial(demo);
        setProgress({ files: 48213, bytes: 92 * 1024 ** 3, pct: 0.62 });
        setLoading(true);
      }
      return;
    }
    (async () => {
      const h = await api.homeDir();
      setHome(h);
      api.timeMachineStatus().then(setTm).catch(() => {});
      if (h) await runScan(h);
      else setError("Could not locate your home directory.");
    })();
  }, [runScan, runDups]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sortOpenRef.current) return; // the sort flow owns the keyboard while open
      if (e.key === "Escape") setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Selection resets when the visible set changes.
  useEffect(() => setChecked(new Set()), [listSource, stack]);

  const tree = scan?.tree ?? null;
  const root = stack[stack.length - 1] ?? null;
  const focus = hover ?? selected ?? root;

  const { map: colorMap, legend } = useMemo(() => buildColorMap(tree ? typeStats(tree) : []), [tree]);

  const drill = useCallback(
    (node: Node) => {
      if (!tree || !node.is_dir) return;
      const chain = findChain(tree, node.path);
      // Folders not in the pruned tree (reached via a fetched list row) aren't in
      // `chain`; navigate to the fetched node directly so the list can load it.
      if (chain[chain.length - 1].path === node.path) setStack(chain);
      else setStack((s) => [...s, node]);
      setSelected(null);
      setListSource(null);
    },
    [tree],
  );

  // Fetch a folder's full, unpruned children for the list view. In Tauri this
  // comes from the backend (the UI holds only the pruned tree); in the browser
  // demo the client tree is already complete, so read it directly.
  const loadChildren = useCallback(
    async (path: string): Promise<Node[]> => {
      if (api.isTauri()) return api.listChildren(path);
      if (!tree) return [];
      const chain = findChain(tree, path);
      const node = chain[chain.length - 1];
      return node.path === path ? node.children : [];
    },
    [tree],
  );

  // Load the list view's rows whenever the view, active filter, or folder changes.
  useEffect(() => {
    if (view !== "list") return;
    let cancelled = false;
    (async () => {
      setListLoading(true);
      try {
        let items: Node[] = [];
        if (tree && listSource?.key === "node_modules") {
          items = collectByName(tree, "node_modules"); // the folders to reclaim
        } else {
          const target =
            listSource?.key === "caches" ? (tree ? largestDirOfCategory(tree, "cache")?.path : undefined)
            : listSource?.key === "derived" ? (tree ? largestDirNamed(tree, "DerivedData")?.path : undefined)
            : root?.path;
          if (target) items = await loadChildren(target);
        }
        if (!cancelled) setListItems(withoutAggregates(items));
      } catch (e) {
        if (!cancelled) reportError(e);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, listSource, root?.path, tree, loadChildren, reportError]);

  const setViewMode = useCallback((m: ViewMode) => {
    setView(m);
    if (m === "list") setListSource(null); // manual List = current folder
  }, []);

  const onRecommend = useCallback((s: Suggestion) => {
    if (s.action === "openTrash") {
      api.openTrash().catch(reportError);
      return;
    }
    if (s.action === "list") {
      setListSource(resolveFilter(s.key));
      setView("list");
    }
  }, []);

  const onSort = useCallback((key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }, []);

  const checkedNodes = listItems.filter((n) => n.path && checked.has(n.path));
  const checkedBytes = checkedNodes.reduce((s, n) => s + n.size, 0);

  const toggleCheck = useCallback((path: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    const paths = listItems.filter((n) => n.path).map((n) => n.path);
    setChecked((s) => (paths.every((p) => s.has(p)) ? new Set() : new Set(paths)));
  }, [listItems]);

  // Prune trashed paths from the in-memory tree (no re-scan), drop them from the
  // visible list, and re-anchor the navigation stack into the updated tree. The
  // backend prunes its retained tree too, so a re-fetch stays consistent.
  const applyTrashed = useCallback(
    (paths: string[]) => {
      if (!scan || paths.length === 0) return;
      const next = removePaths(scan.tree, paths);
      setScan({ ...scan, tree: next, files: next.item_count });
      setStack((s) => remapStack(next, s, paths));
      setListItems((items) => items.filter((n) => !paths.includes(n.path)));
      setSelected((sel) => (sel && paths.includes(sel.path) ? null : sel));
      setDups((d) => (d ? pruneDupReport(d, paths) : d));
    },
    [scan],
  );

  const trashPaths = useCallback(
    (paths: string[], label: string) => {
      if (paths.length === 0 || stack.length === 0) return;
      setConfirm({
        title: `Move ${label} to the Trash?`,
        detail: "It goes to the macOS Trash (recoverable) — nothing is permanently deleted.",
        confirmLabel: "Move to Trash",
        onOk: async () => {
          // One item failing is not the batch failing: keep going, and apply
          // whatever actually reached the Trash. The exception is macOS itself
          // not answering — every remaining item would sit through the same
          // timeout, so give up rather than freeze for minutes.
          const done: string[] = [];
          const failed: string[] = [];
          let stopped = false;
          for (const p of paths) {
            try {
              await api.moveToTrash(p);
              done.push(p);
            } catch (e) {
              if (isMissing(e)) {
                done.push(p); // already gone — let the row leave the view
              } else if (isUnresponsive(e)) {
                failed.push(errText(e));
                stopped = true;
                break;
              } else {
                failed.push(errText(e));
              }
            }
          }
          if (done.length) applyTrashed(done);
          setError(trashFailureText({ total: paths.length, done: done.length, failed, stopped }));
        },
      });
    },
    [stack, applyTrashed],
  );

  const onTreemapTrash = useCallback(() => {
    if (selected?.path) trashPaths([selected.path], `${selected.name} (${fmtBytes(selected.size)})`);
  }, [selected, trashPaths]);

  // The error is all there is to show: no tree in memory, and nothing on its way.
  const scanFailed = !!error && !root && !loading;

  // Open the sort flow either scoped to a folder (Organize on the current folder,
  // straight into the reviewer) or unscoped (the sidebar's top-level overview).
  const openSort = (scope: string | null, initial: "overview" | "reviewer") => {
    setSortScope(scope);
    setSortInitial(initial);
    setSortOpen(true);
  };
  const selectSeg = (m: SegView) => {
    if (m === "organize") {
      // Mid-scan the navigation stack is stale (or empty), so scoping to the
      // "current" folder would land on a leftover directory — fall back to the
      // top-level Get organized overview instead.
      const scope = loading ? null : (root?.path ?? null);
      openSort(scope, scope ? "reviewer" : "overview");
      return;
    }
    if (sortOpen) closeSort();
    setViewMode(m);
  };

  if (sortOpen) return <SortFlow home={home} initial={sortInitial} scope={sortScope} onClose={closeSort} onSelectView={selectSeg} />;

  return (
    <div className="app">
      {/* Rescan falls back to the home directory: after a scan that failed there
          is no stack to re-run, and that's exactly when it's wanted. */}
      <Toolbar root={stack[0] ?? null} loading={loading} view={view} onSelectView={selectSeg} onRescan={() => { const p = stack[0]?.path ?? home; if (p) runScan(p); }} />
      <div className="body">
        <Sidebar root={root} tm={tm} colorMap={colorMap} onRecommend={onRecommend} dups={dups} dupScanning={dupScanning} dupProgress={dupProgress} scanning={loading} onOpenDups={() => setView("dups")} loose={loose} onOrganize={() => openSort(null, "overview")} />
        <main className="content">
          {/* A failed action is a notice over the view it failed in — whatever is
              on screen stays on screen, and stays usable. The error only takes
              the content area when there's no scan to show behind it, and then
              it comes with a way out. */}
          {error && !scanFailed && <ErrorBar text={error} onDismiss={() => setError(null)} />}
          {scanFailed ? (
            <>
              <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
              <ScanFailed text={error!} onRetry={home ? () => runScan(home) : undefined} />
            </>
          ) : loading || !root ? (
            <>
              <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
              <ScanStage partial={partial} progress={progress} />
            </>
          ) : view === "list" ? (
            <>
              {listSource ? (
                <FilterBar label={listSource.label} count={listItems.length} bytes={listItems.reduce((s, n) => s + n.size, 0)} onClear={() => setListSource(null)} />
              ) : (
                <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
              )}
              <ListView
                key={listSource ? `f:${listSource.key}` : `d:${root.path}`}
                items={listItems}
                loading={listLoading}
                sort={sort}
                onSort={onSort}
                checked={checked}
                nameFromParent={listSource?.nameFromParent ?? false}
                home={home}
                onToggleCheck={toggleCheck}
                onToggleAll={toggleAll}
                onDrill={drill}
                onReveal={(n) => api.revealInFinder(n.path).catch(reportError)}
                onTerminal={(n) => api.openTerminalHere(dirOf(n)).catch(reportError)}
                onTrashOne={(n) => trashPaths([n.path], `${n.name} (${fmtBytes(n.size)})`)}
              />
            </>
          ) : view === "dups" ? (
            <DupsView
              report={dups}
              scanning={dupScanning}
              progress={dupProgress}
              home={home}
              onReveal={(p) => api.revealInFinder(p).catch(reportError)}
              onTrashPaths={trashPaths}
            />
          ) : (
            <>
              <Breadcrumb stack={stack} onJump={(i) => setStack(stack.slice(0, i + 1))} />
              <Treemap root={root} colorMap={colorMap} selected={selected} onHover={setHover} onSelect={setSelected} onDrill={drill} />
              <Legend legend={legend} />
            </>
          )}
        </main>
      </div>
      {view === "dups" ? (
        <DupsInspector report={dups} scanning={dupScanning} />
      ) : view === "list" ? (
        <ListInspector
          count={checkedNodes.length}
          bytes={checkedBytes}
          onReveal={() => { if (checkedNodes[0]) api.revealInFinder(checkedNodes[0].path).catch(reportError); }}
          onTrash={() => trashPaths(checkedNodes.map((n) => n.path), `${checkedNodes.length} item${checkedNodes.length === 1 ? "" : "s"} (${fmtBytes(checkedBytes)})`)}
        />
      ) : (
        <Inspector node={focus} selected={selected} onTrash={onTreemapTrash} onError={reportError} />
      )}
      {confirm && <ConfirmModal data={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// A failed action, reported without taking the view away. Dismissible, because
// the next thing the user does shouldn't have to be about the last thing that
// went wrong.
function ErrorBar({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div className="errbar" role="alert">
      <span className="errbar-txt">{text}</span>
      <button className="errbar-x" title="Dismiss" onClick={onDismiss}>✕</button>
    </div>
  );
}

// The one case where an error does own the content area: the scan failed, so
// there is no tree to show behind it. It always offers the way back.
function ScanFailed({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="state">
      <div className="state-card">
        <div className="state-msg">{text}</div>
        {onRetry && <button className="btn primary" onClick={onRetry}>Try again</button>}
      </div>
    </div>
  );
}

function ConfirmModal({ data, onClose }: { data: ConfirmData; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{data.title}</div>
        <div className="modal-detail">{data.detail}</div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={() => { data.onOk(); onClose(); }}>{data.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Toolbar({ root, loading, view, onSelectView, onRescan }: { root: Node | null; loading: boolean; view: ViewMode; onSelectView: (m: SegView) => void; onRescan: () => void }) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="app-name">disk<span className="dot">·</span>solve</div>
      <div className="toolbar">
        <div className="vol">{root ? root.name : "—"}</div>
        <ViewSeg view={view} onSelect={onSelectView} />
        <button className="btn primary" onClick={onRescan} disabled={loading}>{loading ? "Scanning…" : "Rescan"}</button>
      </div>
    </div>
  );
}

function Scanning({ progress }: { progress: ScanProgress | null }) {
  const pct = progress ? Math.round(progress.pct * 100) : 0;
  const text = progress
    ? `Scanned ${progress.files.toLocaleString()} files · ${fmtBytes(progress.bytes)}${progress.pct > 0 ? ` · ${pct}%` : ""}`
    : "Scanning…";
  return (
    <div className="scanning">
      <div className={"scanbar" + (progress && progress.pct > 0 ? "" : " indet")}>
        <div className="scanbar-fill" style={progress && progress.pct > 0 ? { width: `${pct}%` } : undefined} />
      </div>
      <div className="scan-count">{text}</div>
      <div className="scan-hint">Feel free to tab away — you'll get a notification when the scan is done.</div>
    </div>
  );
}

// While a scan runs, render the partial tree (streamed from the backend) and lay
// a frosted overlay carrying the progress over it, so the treemap is visibly
// built in the background.
function ScanStage({ partial, progress }: { partial: Node | null; progress: ScanProgress | null }) {
  return (
    <div className="scanstage">
      {partial && partial.children.length > 0 && <PreviewTreemap root={partial} />}
      <div className="scan-overlay">
        <Scanning progress={progress} />
      </div>
    </div>
  );
}

// A static, non-interactive treemap of the scan-in-progress tree, colored by
// category. No labels or hit targets — it sits behind the overlay as a preview.
function PreviewTreemap({ root }: { root: Node }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const tiles = useMemo(() => squarify(root, dims.w, dims.h), [root, dims]);

  return (
    <div className="treemap preview" ref={ref} aria-hidden>
      {tiles.map((t, i) =>
        t.group ? (
          <div key={i} className="cell grp" style={{ left: t.x, top: t.y, width: Math.max(0, t.w), height: Math.max(0, t.h) }} />
        ) : (
          <div key={i} className="cell" style={{ left: t.x, top: t.y, width: Math.max(0, t.w), height: Math.max(0, t.h), background: CAT_COLOR[t.node.category] }} />
        ),
      )}
    </div>
  );
}

function Sidebar({ root, tm, colorMap, onRecommend, dups, dupScanning, dupProgress, scanning, onOpenDups, loose, onOrganize }: {
  root: Node | null;
  tm: TimeMachineStatus | null;
  colorMap: Map<string, string>;
  onRecommend: (s: Suggestion) => void;
  dups: DupReport | null;
  dupScanning: boolean;
  dupProgress: { hashed: number; total: number } | null;
  scanning: boolean;
  onOpenDups: () => void;
  loose: { count: number; bytes: number; sources: string[] } | null;
  onOrganize: () => void;
}) {
  // The candidate total only settles once the disk walk ends, so show a
  // determinate bar then; while the walk is still streaming files, animate.
  const dupPct = dupProgress && dupProgress.total > 0 ? Math.round((dupProgress.hashed / dupProgress.total) * 100) : 0;
  const dupDeterminate = !scanning && !!dupProgress && dupProgress.total > 0;
  const suggestions = useMemo(() => (root ? reclaimable(root) : []), [root]);
  const segments = useMemo(() => {
    if (!root) return [] as { ext: string; bytes: number; color: string }[];
    const stats = typeStats(root);
    const top = stats.slice(0, 16);
    const rest = stats.slice(16).reduce((s, t) => s + t.bytes, 0);
    const segs = top.map((t) => ({ ext: t.ext, bytes: t.bytes, color: colorMap.get(t.ext) ?? "var(--neutral)" }));
    if (rest > 0) segs.push({ ext: "other", bytes: rest, color: "var(--neutral)" });
    return segs;
  }, [root, colorMap]);

  return (
    <aside className="sidebar">
      <div className="side-sec">
        <div className="gauge-top">
          <span className="disk">{root ? root.name : "—"}</span>
          <span className="cap">{fmtBytes(root?.size ?? 0)}</span>
        </div>
        <div className="bar">
          {segments.map((s) => (
            <div key={s.ext} style={{ flexGrow: s.bytes, background: s.color }} title={`${s.ext} · ${fmtBytes(s.bytes)}`} />
          ))}
        </div>
        <div className="gauge-key">{root?.item_count.toLocaleString() ?? 0} items</div>
      </div>

      <div className="side-sec">
        <h3 className="side-h">Time Machine</h3>
        <div className="status">
          <div className="txt">
            <div className="t1">{tm?.latest_backup ? "Backed up" : "No backup detected"}</div>
            <div className="t2">{tm ? `${tm.local_snapshots} local snapshot${tm.local_snapshots === 1 ? "" : "s"}` : "…"}</div>
          </div>
        </div>
      </div>

      <div className="side-sec">
        <h3 className="side-h">Duplicates</h3>
        {dupScanning ? (
          <div className="dupscan">
            <div className="dupscan-head">
              <span className="t1">Scanning…</span>
              {dupDeterminate && <span className="dupscan-pct">{dupPct}%</span>}
            </div>
            <div className={"scanbar" + (dupDeterminate ? "" : " indet")}>
              <div className="scanbar-fill" style={dupDeterminate ? { width: `${dupPct}%` } : undefined} />
            </div>
            <div className="t2">
              {dupProgress && dupProgress.hashed > 0
                ? `${dupProgress.hashed.toLocaleString()} file${dupProgress.hashed === 1 ? "" : "s"} checked${dupDeterminate ? ` of ${dupProgress.total.toLocaleString()}` : ""}`
                : "looking for duplicate files…"}
            </div>
          </div>
        ) : dups && dups.groups.length > 0 ? (
          <div className="rec" onClick={onOpenDups} title="Review duplicate files">
            <div className="rbody">
              <div className="r1">{dups.groups.length} duplicate set{dups.groups.length === 1 ? "" : "s"}</div>
              <div className="r2">
                <span className="r2t">Identical files</span>
                <span className="amt">{fmtBytes(dups.reclaimable)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="status">
            <div className="txt">
              <div className="t2">{dups ? "None found" : "…"}</div>
            </div>
          </div>
        )}
      </div>

      <div className="side-sec">
        <h3 className="side-h">Loose images</h3>
        {loose && loose.count > 0 ? (
          <div className="rec" onClick={onOrganize} title="Sort loose images">
            <div className="rbody">
              <div className="r1">{loose.count.toLocaleString()} loose image{loose.count === 1 ? "" : "s"}</div>
              <div className="r2">
                <span className="r2t">{loose.sources.join(" · ") || "Get organized"}</span>
                <span className="amt">{fmtBytes(loose.bytes)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="status">
            <div className="txt">
              <div className="t2">{loose ? "No loose images to sort" : "…"}</div>
            </div>
          </div>
        )}
      </div>

      <div className="side-sec" style={{ paddingBottom: 0 }}>
        <h3 className="side-h">Recommended</h3>
      </div>
      <div className="recs">
        {/* The suggestions are derived from the prior tree, so hide them while a
            (re)scan is in flight rather than offering stale, possibly-gone targets. */}
        {!scanning && suggestions.map((s) => (
          <div className="rec" key={s.key} onClick={() => onRecommend(s)}>
            <div className="rbody">
              <div className="r1">{s.title}</div>
              <div className="r2">
                <span className="r2t">{s.subtitle}</span>
                <span className="amt">{fmtBytes(s.bytes)}</span>
              </div>
            </div>
            <button className="rec-btn" onClick={(e) => { e.stopPropagation(); onRecommend(s); }}>
              {s.action === "openTrash" ? "Open Trash in Finder" : "View in list view"}
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Breadcrumb({ stack, onJump }: { stack: Node[]; onJump: (i: number) => void }) {
  return (
    <div className="crumbs">
      {stack.map((node, i) => {
        const isCur = i === stack.length - 1;
        return (
          <span key={node.path} className="crumb-wrap">
            {i > 0 && <span className="sep">›</span>}
            <span className={"crumb" + (isCur ? " cur" : "")} onClick={() => !isCur && onJump(i)}>{node.name}</span>
          </span>
        );
      })}
      {stack.length > 1 && <span className="crumb-hint">Esc to go up</span>}
      {stack.length > 0 && (
        <span className="right">{fmtBytes(stack[stack.length - 1].size)} · {stack[stack.length - 1].item_count.toLocaleString()} items</span>
      )}
    </div>
  );
}

function FilterBar({ label, count, bytes, onClear }: { label: string; count: number; bytes: number; onClear: () => void }) {
  return (
    <div className="crumbs">
      <span className="crumb cur">Filtered</span>
      <span className="sep">›</span>
      <span className="filterchip">
        {label}
        <button className="x" title="Clear filter" onClick={onClear}>✕</button>
      </span>
      <span className="right">{count} item{count === 1 ? "" : "s"} · {fmtBytes(bytes)}</span>
    </div>
  );
}

function SortHead({ label, col, sort, onSort, cls }: { label: string; col: SortKey; sort: { key: SortKey; dir: SortDir }; onSort: (k: SortKey) => void; cls: string }) {
  const active = sort.key === col;
  return (
    <span className={cls + (active ? " sorted" : "")} onClick={() => onSort(col)}>
      {label}
      {active && <span className="arr">{sort.dir === "desc" ? " ▾" : " ▴"}</span>}
    </span>
  );
}

const ROW_H = 46; // .lrow height (px); rows are fixed-height, so the list can be windowed
const ROW_OVERSCAN = 8;

function ListView({
  items, loading, sort, onSort, checked, nameFromParent, home, onToggleCheck, onToggleAll, onDrill, onReveal, onTerminal, onTrashOne,
}: {
  items: Node[];
  loading: boolean;
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  checked: Set<string>;
  nameFromParent: boolean;
  home: string | null;
  onToggleCheck: (path: string) => void;
  onToggleAll: () => void;
  onDrill: (n: Node) => void;
  onReveal: (n: Node) => void;
  onTerminal: (n: Node) => void;
  onTrashOne: (n: Node) => void;
}) {
  const sorted = useMemo(() => sortItems(items, sort.key, sort.dir), [items, sort]);
  const maxSize = sorted.reduce((m, n) => Math.max(m, n.size), 1);
  const checkable = sorted.filter((n) => n.path);
  const allChecked = checkable.length > 0 && checkable.every((n) => checked.has(n.path));

  // Window the body: only the rows in view are in the DOM, so a folder with
  // thousands of items opens instantly and scrolls smoothly. Folder/filter
  // changes remount this (a `key` upstream); re-sorting jumps back to the top.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(640);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [sort]);

  const total = sorted.length;
  const maxScroll = Math.max(0, total * ROW_H - viewport);
  const st = Math.min(scrollTop, maxScroll); // tolerate a stale scrollTop after items shrink
  const start = Math.max(0, Math.floor(st / ROW_H) - ROW_OVERSCAN);
  const end = Math.min(total, Math.ceil((st + viewport) / ROW_H) + ROW_OVERSCAN);

  return (
    <div className="listwrap">
      <div className="lhead">
        <span className="lh-check"><input type="checkbox" checked={allChecked} onChange={onToggleAll} /></span>
        <SortHead label="Name" col="name" sort={sort} onSort={onSort} cls="lh-name" />
        <SortHead label="Size" col="size" sort={sort} onSort={onSort} cls="lh-size" />
        <SortHead label="Items" col="items" sort={sort} onSort={onSort} cls="lh-items" />
        <SortHead label="Last modified" col="mtime" sort={sort} onSort={onSort} cls="lh-used" />
      </div>
      <div className="lbody" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {total === 0 ? (
          <div className="state">{loading ? "Loading…" : "Nothing here."}</div>
        ) : (
          <>
            <div style={{ height: start * ROW_H }} />
            {sorted.slice(start, end).map((n) => {
              const name = nameFromParent ? parentName(n.path) : n.name;
              const isChecked = !!n.path && checked.has(n.path);
              const stale = isStale(n.mtime);
              return (
                <div
                  key={n.path}
                  className={"lrow" + (isChecked ? " sel" : "")}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("input,button")) return;
                    if (n.path) onToggleCheck(n.path);
                  }}
                  onDoubleClick={() => n.is_dir && onDrill(n)}
                >
                  <span className="l-check"><input type="checkbox" checked={isChecked} disabled={!n.path} onChange={() => n.path && onToggleCheck(n.path)} /></span>
                  <span className="l-name">
                    <i className="dot" style={{ background: CAT_COLOR[n.category] }} />
                    <span className="nm"><span className="t">{name}</span><small>{shortenPath(n.path, home) || "aggregated"}</small></span>
                  </span>
                  <span className="l-size">
                    <span className="szbar"><span className="szfill" style={{ width: `${Math.round((n.size / maxSize) * 100)}%`, background: CAT_COLOR[n.category] }} /></span>
                    <b>{fmtBytes(n.size)}</b>
                  </span>
                  <span className="l-items">{n.is_dir ? n.item_count.toLocaleString() : ""}</span>
                  <span className={"l-used" + (stale ? " stale" : "")}>{fmtRelTime(n.mtime)}</span>
                  {n.path && (
                    <span className="l-act">
                      {n.is_dir && (
                        <button className="iact" title="Open folder" onClick={(e) => { e.stopPropagation(); onDrill(n); }}>{ICON_OPEN}</button>
                      )}
                      <button className="iact" title="Reveal in Finder" onClick={(e) => { e.stopPropagation(); onReveal(n); }}>{ICON_REVEAL}</button>
                      <button className="iact" title="Open Terminal Here" onClick={(e) => { e.stopPropagation(); onTerminal(n); }}>{ICON_TERMINAL}</button>
                      <button className="iact danger" title="Move to Trash" onClick={(e) => { e.stopPropagation(); onTrashOne(n); }}>{ICON_TRASH}</button>
                    </span>
                  )}
                </div>
              );
            })}
            <div style={{ height: (total - end) * ROW_H }} />
          </>
        )}
      </div>
    </div>
  );
}

function Treemap({
  root, colorMap, selected, onHover, onSelect, onDrill,
}: {
  root: Node;
  colorMap: Map<string, string>;
  selected: Node | null;
  onHover: (n: Node | null) => void;
  onSelect: (n: Node) => void;
  onDrill: (n: Node) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hoverFolder, setHoverFolder] = useState<Tile | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const tiles = useMemo(() => squarify(root, dims.w, dims.h), [root, dims]);
  useEffect(() => setHoverFolder(null), [root]);

  const selTile = useMemo(
    () => (selected && selected.path ? tiles.find((t) => !t.group && t.node.path === selected.path) : undefined),
    [tiles, selected],
  );

  return (
    <div className="treemap" ref={ref} onMouseLeave={() => onHover(null)}>
      {tiles.map((t, i) => {
        const color = colorForNode(t.node, colorMap);
        const isAgg = t.node.path === "";
        const cls = "cell" + (t.group ? " grp" : isAgg ? " agg" : color ? "" : " neutral");
        const showLabel = !t.group && t.w > 46 && t.h > 20;
        return (
          <div
            key={i}
            className={cls}
            style={{ left: t.x, top: t.y, width: Math.max(0, t.w), height: Math.max(0, t.h), background: t.group ? undefined : color ?? undefined }}
            title={t.group ? "Double-click to view in tree view" : t.node.name}
            onMouseEnter={() => onHover(t.node)}
            onClick={() => {
              if (t.group) return;
              if (isAgg) {
                // Drill into the folder these folded-away items belong to; if the
                // aggregate is already a direct child of the view, just select it.
                const parent = parentOf(root, t.node);
                if (parent && parent !== root) onDrill(parent);
                else onSelect(t.node);
              } else {
                onSelect(t.node);
              }
            }}
            onDoubleClick={() => t.group && onDrill(t.node)}
          >
            {showLabel && (
              <span className={"lbl" + (isAgg ? " agg-lbl" : "")}>
                <span className="n">{t.node.name}</span>
                {t.h > 34 && <span className="s">{fmtBytes(t.node.size)}</span>}
              </span>
            )}
          </div>
        );
      })}
      {selTile && <div className="tm-overlay sel" style={{ left: selTile.x, top: selTile.y, width: selTile.w, height: selTile.h }} />}
      {hoverFolder && <div className="tm-overlay folder" style={{ left: hoverFolder.x, top: hoverFolder.y, width: hoverFolder.w, height: hoverFolder.h }} />}
      {tiles.filter((t) => t.labeled).map((t, i) => (
        <div
          key={"g" + i}
          className="glabel"
          style={{ left: t.x + 5, top: t.y + 4, maxWidth: Math.max(42, t.w - 10) }}
          onMouseEnter={() => { onHover(t.node); setHoverFolder(t); }}
          onMouseLeave={() => setHoverFolder(null)}
          onClick={() => onDrill(t.node)}
        >
          <span className="gn">{t.node.name}</span>
          <span className="gs">{fmtBytes(t.node.size)}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ legend }: { legend: LegendEntry[] }) {
  if (legend.length === 0) return <div className="legend" />;
  return (
    <div className="legend">
      {legend.slice(0, 12).map((l) => (
        <span key={l.ext}><i style={{ background: l.color }} />{l.ext === "(none)" ? "no ext" : l.ext}</span>
      ))}
    </div>
  );
}

function dirOf(node: Node): string {
  if (node.is_dir) return node.path;
  const parent = node.path.replace(/\/[^/]*$/, "");
  return parent.length > 0 ? parent : "/";
}

function Inspector({ node, selected, onTrash, onError }: { node: Node | null; selected: Node | null; onTrash: () => void; onError: (e: unknown) => void }) {
  const target = selected ?? node;
  const canAct = !!target && target.path.length > 0;
  const canTrash = !!selected && selected.path.length > 0;
  return (
    <div className="inspector">
      <div className="insp-meta">
        <div className="insp-path">{node ? node.path || node.name : "—"}</div>
        <div className="insp-sub">{node ? `${fmtBytes(node.size)} · ${node.item_count.toLocaleString()} items` : ""}</div>
      </div>
      <div className="insp-actions">
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.revealInFinder(target!.path).catch(onError)}>Reveal in Finder</button>
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.openTerminalHere(dirOf(target!)).catch(onError)}>Open Terminal Here</button>
        <button className="btn" disabled={!canAct} onClick={() => canAct && api.quickLook(target!.path).catch(onError)}>Quick Look</button>
        <button className="btn danger" disabled={!canTrash} onClick={onTrash}>Move to Trash</button>
      </div>
    </div>
  );
}

function ListInspector({ count, bytes, onReveal, onTrash }: { count: number; bytes: number; onReveal: () => void; onTrash: () => void }) {
  return (
    <div className={"inspector" + (count === 0 ? " empty" : "")}>
      <div className="insp-meta">
        <div className="insp-path">{count === 0 ? "Select items to reclaim" : `${count} item${count === 1 ? "" : "s"} selected`}</div>
        <div className="insp-sub">{count === 0 ? "Tick rows to act on them" : `${fmtBytes(bytes)} · recoverable`}</div>
      </div>
      <div className="insp-actions">
        <button className="btn" disabled={count === 0} onClick={onReveal}>Reveal in Finder</button>
        <button className="btn danger" disabled={count === 0} onClick={onTrash}>Move {count} to Trash · {fmtBytes(bytes)}</button>
      </div>
    </div>
  );
}

const DUP_CHUNK = 24; // duplicate sets rendered per frame, so the tab opens instantly

function DupsView({ report, scanning, progress, home, onReveal, onTrashPaths }: {
  report: DupReport | null;
  scanning: boolean;
  progress: { hashed: number; total: number } | null;
  home: string | null;
  onReveal: (path: string) => void;
  onTrashPaths: (paths: string[], label: string) => void;
}) {
  const groups = report?.groups ?? [];
  // A big duplicate set can be a lot of DOM; render it a chunk at a time so
  // switching to this tab paints the top sets immediately and fills in the rest.
  const [shown, setShown] = useState(DUP_CHUNK);
  useEffect(() => setShown(DUP_CHUNK), [report]);
  useEffect(() => {
    if (shown >= groups.length) return;
    const id = requestAnimationFrame(() => setShown((s) => s + DUP_CHUNK));
    return () => cancelAnimationFrame(id);
  }, [shown, groups.length]);

  if (scanning) {
    const has = progress && progress.total > 0;
    const pct = has ? Math.round((progress!.hashed / progress!.total) * 100) : 0;
    return (
      <div className="state">
        <div className="scanning">
          <div className={"scanbar" + (has ? "" : " indet")}>
            <div className="scanbar-fill" style={has ? { width: `${pct}%` } : undefined} />
          </div>
          <div className="scan-count">
            {has ? `Checking ${progress!.hashed.toLocaleString()} / ${progress!.total.toLocaleString()} candidates · ${pct}%` : "Looking for duplicate files…"}
          </div>
        </div>
      </div>
    );
  }
  if (groups.length === 0) {
    return <div className="state">No duplicate files found ({fmtBytes(1 << 20)} and larger).</div>;
  }

  return (
    <div className="dupwrap">
      <div className="crumbs">
        <span className="crumb cur">Duplicates</span>
        <span className="right">{groups.length} set{groups.length === 1 ? "" : "s"} · {fmtBytes(report!.reclaimable)} reclaimable</span>
      </div>
      <div className="dupbody">
        {groups.slice(0, shown).map((g, gi) => (
          <DupGroupCard key={g.paths[0] || gi} group={g} home={home} onReveal={onReveal} onTrashPaths={onTrashPaths} />
        ))}
      </div>
    </div>
  );
}

// Memoized so progressively revealing more sets re-renders only the new cards.
const DupGroupCard = memo(function DupGroupCard({ group, home, onReveal, onTrashPaths }: {
  group: DupGroup;
  home: string | null;
  onReveal: (path: string) => void;
  onTrashPaths: (paths: string[], label: string) => void;
}) {
  const keep = keeperOf(group);
  const extras = group.paths.filter((p) => p !== keep);
  return (
    <div className="dupgroup">
      <div className="dg-head">
        <span className="dg-name">{baseName(keep)}</span>
        <span className="dg-meta">{fmtBytes(group.size)} each · {group.paths.length} copies · reclaim {fmtBytes(group.reclaimable)}</span>
        <button className="btn danger sm" onClick={() => onTrashPaths(extras, `${extras.length} extra cop${extras.length === 1 ? "y" : "ies"} of ${baseName(keep)} (${fmtBytes(group.reclaimable)})`)}>
          Trash {extras.length} extra{extras.length === 1 ? "" : "s"}
        </button>
      </div>
      {group.paths.map((p) => {
        const isKeep = p === keep;
        return (
          <div className={"dupfile" + (isKeep ? " keep" : "")} key={p}>
            <span className="df-path">{shortenPath(p, home)}</span>
            {isKeep ? (
              <span className="df-act">
                <span className="df-tag">Keep</span>
                <button className="iact" title="Reveal in Finder (then Space to Quick Look)" onClick={() => onReveal(p)}>{ICON_REVEAL}</button>
              </span>
            ) : (
              <span className="df-act">
                <button className="iact" title="Reveal in Finder" onClick={() => onReveal(p)}>{ICON_REVEAL}</button>
                <button className="iact danger" title="Move to Trash" onClick={() => onTrashPaths([p], `${baseName(p)} (${fmtBytes(group.size)})`)}>{ICON_TRASH}</button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
});

function DupsInspector({ report, scanning }: { report: DupReport | null; scanning: boolean }) {
  const sets = report?.groups.length ?? 0;
  const title = scanning ? "Scanning for duplicates…" : sets === 0 ? "No duplicates found" : `${sets} duplicate set${sets === 1 ? "" : "s"}`;
  const sub = sets > 0 ? `${fmtBytes(report!.reclaimable)} reclaimable · keeps one copy of each` : scanning ? "Reading and checking files in the background" : "Nothing to reclaim here";
  return (
    <div className={"inspector" + (sets === 0 ? " empty" : "")}>
      <div className="insp-meta">
        <div className="insp-path">{title}</div>
        <div className="insp-sub">{sub}</div>
      </div>
    </div>
  );
}
