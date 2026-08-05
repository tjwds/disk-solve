//! Tauri command surface for disk-solve.
//!
//! Safety posture:
//! - `scan_path` is read-only (see [`scan`]).
//! - `move_to_trash` is the only destructive command. It validates the target
//!   against the *last scanned root* held in app state and moves it to the
//!   macOS Trash (recoverable). It can never be aimed outside what was scanned.

mod actions;
mod backup;
mod category;
mod dups;
mod errmsg;
mod power;
mod safety;
mod scan;
mod sort;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

/// Streamed to the frontend as `scan-progress` while a scan runs. The bar shows
/// `bytes / total` (a real, monotonic fraction); `total` is the volume's used bytes.
#[derive(Clone, serde::Serialize)]
struct ScanProgress {
    files: u64,
    bytes: u64,
    total: u64,
}

/// Bytes currently used on the filesystem containing `path`, via statvfs. Returns
/// 0 if it can't be determined (the UI then falls back to a count-only indicator).
fn volume_used_bytes(path: &Path) -> u64 {
    use std::os::unix::ffi::OsStrExt;
    let Ok(cpath) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return 0;
    };
    // SAFETY: cpath is a valid NUL-terminated C string; stat is zero-initialized.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(cpath.as_ptr(), &mut stat) == 0 {
            let frsize = stat.f_frsize as u64;
            let total = stat.f_blocks as u64 * frsize;
            let free = stat.f_bfree as u64 * frsize;
            total.saturating_sub(free)
        } else {
            0
        }
    }
}

/// State from the most recent scan. `move_to_trash` refuses any target that is
/// not inside `scan_root`, so the frontend can never ask us to trash an arbitrary
/// path. `tree` retains the full, unpruned scan so the list view can fetch a
/// folder's complete contents (the treemap gets a pruned copy over IPC).
#[derive(Default)]
struct AppState {
    scan_root: Mutex<Option<PathBuf>>,
    tree: Mutex<Option<scan::Node>>,
    /// Bumped whenever a new scan starts, so an in-flight duplicate scan over the
    /// previous tree cancels itself instead of finishing wasted work.
    generation: Arc<AtomicU64>,
    /// Duplicate detection started during the scan; `find_duplicates` finalizes it.
    dup_pipeline: Mutex<Option<Arc<dups::Pipeline>>>,
}

/// Streamed to the frontend as `dup-progress` while duplicate detection runs.
#[derive(Clone, serde::Serialize)]
struct DupProgressEvent {
    hashed: u64,
    total: u64,
    bytes: u64,
}

#[derive(serde::Serialize)]
struct ScanResult {
    tree: scan::Node,
    files: u64,
    dirs: u64,
    errors: u64,
}

#[tauri::command]
async fn scan_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanResult, String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("Path must be absolute".into());
    }
    if !p.is_dir() {
        return Err("Path is not a directory".into());
    }
    // A new scan invalidates any duplicate scan still hashing the previous tree.
    state.generation.fetch_add(1, Ordering::SeqCst);
    let my_gen = state.generation.load(Ordering::SeqCst);
    // Run the (potentially long) parallel scan on a blocking thread so the UI never
    // freezes. A separate poller emits progress ~10x/sec by reading the shared
    // atomics, decoupling event emission from the scan's hot path.
    let target = p.clone();
    let progress = Arc::new(scan::Progress::default());
    let done = Arc::new(AtomicBool::new(false));
    let total = volume_used_bytes(&p);

    // The partial tree, built as the walk proceeds, so the treemap can fill in
    // behind the scanning overlay. Shared with the poller, which snapshots it.
    let live = scan::live_root(&p);

    // Duplicate detection starts now and hashes files as the walk streams them in,
    // so it overlaps the scan instead of waiting for it. `find_duplicates` finalizes.
    let dup_progress = Arc::new(dups::DupProgress::default());
    let (pipeline, sink) =
        dups::Pipeline::start(state.generation.clone(), my_gen, dups::MIN_DUP_SIZE, dup_progress.clone());

    let poll_app = app.clone();
    let poll_progress = progress.clone();
    let poll_dup = dup_progress.clone();
    let poll_live = live.clone();
    let poll_done = done.clone();
    let poller = std::thread::spawn(move || {
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(100));
            tick += 1;
            let _ = poll_app.emit(
                "scan-progress",
                ScanProgress {
                    files: poll_progress.files.load(Ordering::Relaxed),
                    bytes: poll_progress.bytes.load(Ordering::Relaxed),
                    total,
                },
            );
            // Hashing overlaps the walk, so report its progress from the start too.
            let _ = poll_app.emit(
                "dup-progress",
                DupProgressEvent {
                    hashed: poll_dup.hashed.load(Ordering::Relaxed),
                    total: poll_dup.total.load(Ordering::Relaxed),
                    bytes: poll_dup.bytes.load(Ordering::Relaxed),
                },
            );
            // ~3x/sec, snapshot the partial tree (more costly to build than the
            // counters above) and push it so the building treemap stays current.
            if tick % 3 == 0 {
                let snap = scan::live_snapshot(&poll_live);
                if !snap.children.is_empty() {
                    let _ = poll_app.emit("scan-partial", snap);
                }
            }
            if poll_done.load(Ordering::Relaxed) {
                break;
            }
        }
    });

    let scan_progress = progress.clone();
    let scan_live = live.clone();
    let (full, files, dirs, errors) = tauri::async_runtime::spawn_blocking(move || {
        // Hold an App Nap assertion for the whole walk so throughput stays high
        // even if the user switches away from the window. Suppression is
        // process-wide, so this also protects the duplicate-hashing workers
        // running concurrently. Dropped when the walk returns.
        let _awake = power::KeepAwake::begin("Scanning disk usage");
        let full = scan::scan_with_sink(&target, &scan_progress, Some(&sink as &dyn scan::FileSink), Some(scan_live));
        // `sink` drops here, closing the file stream so the pipeline can wind down.
        (
            full,
            scan_progress.files.load(Ordering::Relaxed),
            scan_progress.dirs_scanned.load(Ordering::Relaxed),
            scan_progress.errors.load(Ordering::Relaxed),
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    done.store(true, Ordering::Relaxed);
    let _ = poller.join();

    // Pruned copy crosses to the UI for the treemap; the full tree stays here so
    // the list view can request any folder's complete contents.
    let min_size = (full.size / 20_000).max(1_048_576); // >= 1 MB, ~0.005% of total
    let tree = scan::pruned(&full, min_size, 80);
    *state.tree.lock().unwrap() = Some(full);
    *state.scan_root.lock().unwrap() = Some(p);
    *state.dup_pipeline.lock().unwrap() = Some(pipeline);
    Ok(ScanResult { tree, files, dirs, errors })
}

/// Returns the real, unpruned direct children of the directory at `path` from the
/// retained scan (one level, children stripped) for the list view. Read-only.
#[tauri::command]
fn list_children(state: State<AppState>, path: String) -> Result<Vec<scan::Node>, String> {
    let guard = state.tree.lock().unwrap();
    let tree = guard.as_ref().ok_or("Scan a folder first")?;
    let dir = scan::find_dir(tree, &path).ok_or("Folder not found in the last scan")?;
    Ok(dir.children.iter().map(scan::shallow).collect())
}

/// Finalize the duplicate scan that started during `scan_path`: wait for the
/// streamed hashing to drain and return the grouped report. Reads file contents
/// to hash (never writes); the heavy work already overlapped the disk walk, so
/// by the time the frontend calls this (after the tree renders) it is often
/// nearly done. A poller emits `dup-progress` until it finishes.
#[tauri::command]
async fn find_duplicates(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<dups::DupReport, String> {
    let pipeline = state
        .dup_pipeline
        .lock()
        .unwrap()
        .take()
        .ok_or("Scan a folder first")?;

    let done = Arc::new(AtomicBool::new(false));
    let poll_app = app.clone();
    let poll_progress = pipeline.progress();
    let poll_done = done.clone();
    let poller = std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(150));
        let _ = poll_app.emit(
            "dup-progress",
            DupProgressEvent {
                hashed: poll_progress.hashed.load(Ordering::Relaxed),
                total: poll_progress.total.load(Ordering::Relaxed),
                bytes: poll_progress.bytes.load(Ordering::Relaxed),
            },
        );
        if poll_done.load(Ordering::Relaxed) {
            break;
        }
    });

    let report = tauri::async_runtime::spawn_blocking(move || {
        // Any hashing still draining here is just as throttled by App Nap as the
        // walk was, so hold the assertion until the report is assembled.
        let _awake = power::KeepAwake::begin("Checking for duplicate files");
        pipeline.finish()
    })
    .await
    .map_err(|e| e.to_string())?;

    done.store(true, Ordering::Relaxed);
    let _ = poller.join();
    Ok(report)
}

#[tauri::command]
fn move_to_trash(state: State<AppState>, path: String) -> Result<String, String> {
    let root = state
        .scan_root
        .lock()
        .unwrap()
        .clone()
        .ok_or("Scan a folder before trashing anything")?;
    let outcome = actions::move_to_trash(&PathBuf::from(&path), &root, &actions::SystemTrasher);
    // Keep the retained tree in sync so a re-fetched list reflects the removal.
    // A failure whose target isn't on disk any more (someone else moved it) counts:
    // the entry is stale either way, and the frontend drops those rows too.
    let gone = outcome.is_ok() || std::fs::symlink_metadata(&path).is_err();
    if gone {
        if let Some(tree) = state.tree.lock().unwrap().as_mut() {
            scan::remove_path(tree, &path);
        }
    }
    outcome
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    actions::reveal_in_finder(&PathBuf::from(path))
}

#[tauri::command]
fn open_terminal_here(path: String) -> Result<(), String> {
    actions::open_terminal_here(&PathBuf::from(path))
}

#[tauri::command]
fn quick_look(path: String) -> Result<(), String> {
    actions::quick_look(&PathBuf::from(path))
}

/// Opens the user's Trash in Finder so they can review and empty it themselves.
/// The app never empties the Trash or hard-deletes anything.
#[tauri::command]
fn open_trash() -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("Could not locate the home directory")?;
    actions::open_path(&PathBuf::from(home).join(".Trash"))
}

#[tauri::command]
fn time_machine_status() -> backup::TimeMachineStatus {
    backup::time_machine_status()
}

/// Default starting point for the first scan: the user's home directory.
#[tauri::command]
fn home_dir() -> Option<String> {
    std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned())
}

// ---- "Get organized" sort flow ------------------------------------------------

fn home_path() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not locate the home directory".to_string())
}

/// Where the sort flow's settings live (JSON in the app config dir).
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("sort-settings.json"))
}

/// Load saved filing settings, or first-run defaults if none are stored (or the
/// file is unreadable/corrupt — we never block the UI on a bad config file).
#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<sort::Settings, String> {
    let home = home_path()?;
    if let Ok(txt) = std::fs::read_to_string(settings_path(&app)?) {
        if let Ok(s) = serde_json::from_str::<sort::Settings>(&txt) {
            return Ok(s);
        }
    }
    // First run: never suggest a folder the user doesn't actually have.
    Ok(sort::Settings::defaults(&home).retaining_existing(|p| Path::new(p).exists()))
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: sort::Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let txt = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| e.to_string())
}

/// List the loose images at the top level of each folder, newest first.
#[tauri::command]
fn list_loose_images(folders: Vec<String>) -> Vec<sort::ImageFile> {
    sort::list_loose_images(&folders)
}

/// Move an image into a destination folder. Returns the new path (for undo).
#[tauri::command]
fn file_image(path: String, dest_dir: String) -> Result<String, String> {
    sort::file_image(&PathBuf::from(path), &PathBuf::from(dest_dir))
}

/// Import an image into Apple Photos, then trash the original. Returns the
/// in-Trash path of the original (for undo).
#[tauri::command]
fn file_to_photos(path: String) -> Result<String, String> {
    sort::file_to_photos(&PathBuf::from(path), &home_path()?)
}

/// Move an image into `~/.Trash` (recoverable). Returns the in-Trash path (for undo).
#[tauri::command]
fn sort_trash(path: String) -> Result<String, String> {
    sort::trash_into(&PathBuf::from(path), &home_path()?)
}

/// Undo a file/trash action by moving the file back to its original location.
#[tauri::command]
fn sort_restore(from: String, to: String) -> Result<(), String> {
    sort::move_to(&PathBuf::from(from), &PathBuf::from(to))
}

/// Native folder picker for adding a filing location or source folder. The
/// `prompt` is shown in the macOS picker so it reflects what's being chosen.
#[tauri::command]
fn choose_folder(prompt: Option<String>) -> Result<Option<String>, String> {
    sort::choose_folder(prompt.as_deref().unwrap_or("Choose a folder"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            scan_path,
            list_children,
            find_duplicates,
            move_to_trash,
            reveal_in_finder,
            open_terminal_here,
            quick_look,
            open_trash,
            time_machine_status,
            home_dir,
            load_settings,
            save_settings,
            list_loose_images,
            file_image,
            file_to_photos,
            sort_trash,
            sort_restore,
            choose_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running disk-solve");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_used_is_positive_for_root() {
        // The boot volume always has some data on it.
        assert!(volume_used_bytes(Path::new("/")) > 0);
    }
}
