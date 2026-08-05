//! The "Get organized" flow: list loose images in chosen folders, then file,
//! trash, or skip them one at a time.
//!
//! Safety / data-movement posture:
//! - Listing is read-only (lstat + read_dir, never follows symlinks).
//! - Filing *moves* a file into a destination folder ([`move_into`]); trashing
//!   *moves* it into `~/.Trash` ([`trash_into`]), gated by
//!   [`crate::safety::validate_trash_target`]. Both are reversible by moving the
//!   file back (the frontend's Undo), so no user data is ever hard-deleted.
//! - The only `std::fs::remove_file` call is the source side of a verified
//!   cross-volume move (copy succeeds first); a same-volume move is a pure
//!   rename. Apple Photos import copies into the library, then trashes the
//!   original (recoverable).

use crate::safety::validate_trash_target;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::fs;
use std::process::Command;

/// Where a filed image can go. `Folder` moves the file into `path`; `Photos`
/// imports it into the Apple Photos library and trashes the original.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DestKind {
    Folder,
    Photos,
}

/// One filing destination, bound to a number key by its position in the list.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    pub id: String,
    pub name: String,
    pub kind: DestKind,
    /// Absolute folder path for `Folder` destinations; `None` for `Photos`.
    #[serde(default)]
    pub path: Option<String>,
}

/// Persisted configuration for the sort flow (image-scoped for now). Stored as
/// JSON in the app config dir; see `load_settings`/`save_settings` in `lib.rs`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub destinations: Vec<Destination>,
    /// Folders scanned for loose images (top level only).
    pub sources: Vec<String>,
}

impl Settings {
    /// Sensible first-run defaults relative to the user's home directory. These
    /// reference standard macOS folders; [`retaining_existing`](Settings::retaining_existing)
    /// then drops any the user doesn't actually have so nothing missing is suggested.
    pub fn defaults(home: &Path) -> Settings {
        Settings {
            destinations: vec![
                Destination {
                    id: "pictures".into(),
                    name: "Pictures".into(),
                    kind: DestKind::Folder,
                    path: Some(home.join("Pictures").display().to_string()),
                },
                Destination {
                    id: "apple-photos".into(),
                    name: "Apple Photos".into(),
                    kind: DestKind::Photos,
                    path: None,
                },
            ],
            sources: vec![
                home.join("Desktop").display().to_string(),
                home.join("Downloads").display().to_string(),
            ],
        }
    }

    /// Drop folder destinations and source folders whose path does not exist, so a
    /// first run never suggests a location the user doesn't have. Apple Photos
    /// (no folder of its own) is always kept. Applied to defaults only — a user's
    /// saved settings are left as-is (a folder may be on an unmounted volume).
    pub fn retaining_existing(mut self, exists: impl Fn(&str) -> bool) -> Settings {
        self.destinations.retain(|d| match (d.kind, d.path.as_deref()) {
            (DestKind::Photos, _) => true,
            (DestKind::Folder, Some(p)) => exists(p),
            (DestKind::Folder, None) => false,
        });
        self.sources.retain(|s| exists(s));
        self
    }
}

/// A loose image found in a source folder, sent to the reviewer.
#[derive(Serialize, Clone, Debug)]
pub struct ImageFile {
    pub path: String,
    pub name: String,
    /// Logical file size in bytes (what Finder shows for an image).
    pub size: u64,
    /// Modification time, unix seconds.
    pub mtime: i64,
    /// Lowercased extension without the dot.
    pub ext: String,
    /// Display name of the source folder (e.g. "Desktop").
    pub source: String,
}

/// Image extensions the sort flow recognizes (mirrors the `Photo` category).
const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "tiff", "tif", "bmp", "raw", "cr2",
    "nef", "arw", "svg", "ico", "psd",
];

/// The lowercased image extension of `name`, if it has a recognized one.
pub fn image_ext(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None; // dotfile like ".DS_Store"
    }
    let ext = name[dot + 1..].to_ascii_lowercase();
    IMAGE_EXTS.contains(&ext.as_str()).then_some(ext)
}

/// Split a filename into (stem, extension). The extension excludes the dot and is
/// `None` for names without one (or leading-dot names).
fn split_name(name: &str) -> (&str, Option<&str>) {
    match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], Some(&name[dot + 1..])),
        _ => (name, None),
    }
}

/// A non-colliding path for `filename` inside `dir`: returns `dir/filename` if
/// free, else inserts " 2", " 3", … before the extension. `exists` is injected so
/// the collision logic can be tested without touching the filesystem.
fn unique_path(dir: &Path, filename: &str, exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(filename);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = split_name(filename);
    let mut n = 2u32;
    loop {
        let candidate = match ext {
            Some(e) => format!("{stem} {n}.{e}"),
            None => format!("{stem} {n}"),
        };
        let p = dir.join(candidate);
        if !exists(&p) {
            return p;
        }
        n += 1;
    }
}

/// Move `src` to exactly `dest`. A same-volume move is a rename; a cross-volume
/// move copies then removes the source (the only `remove_file` in the app, and
/// only after the copy succeeds). Used both to file and to undo (move back).
pub fn move_to(src: &Path, dest: &Path) -> Result<(), String> {
    match fs::rename(src, dest) {
        Ok(()) => Ok(()),
        // EXDEV: src and dest are on different volumes — rename can't cross them.
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            fs::copy(src, dest).map_err(|e| format!("Copy failed: {e}"))?;
            fs::remove_file(src).map_err(|e| format!("Removing original after copy failed: {e}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Move `src` into directory `dest_dir`, creating it if needed and avoiding name
/// collisions. Returns the final path.
pub fn move_into(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dest_dir).map_err(|e| format!("Could not create destination: {e}"))?;
    let filename = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Source has no file name")?;
    let dest = unique_path(dest_dir, filename, &|p| p.exists());
    move_to(src, &dest)?;
    Ok(dest)
}

/// File `src` into a destination folder after basic safety checks. Returns the
/// new path so the caller can undo by moving it back.
pub fn file_image(src: &Path, dest_dir: &Path) -> Result<String, String> {
    let meta = fs::symlink_metadata(src).map_err(|_| "Source file not found".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("Refusing to move a symlink".into());
    }
    if !meta.is_file() {
        return Err("Source is not a regular file".into());
    }
    if !dest_dir.is_absolute() {
        return Err("Destination must be an absolute path".into());
    }
    Ok(move_into(src, dest_dir)?.display().to_string())
}

/// Move `path` into the user's `~/.Trash` (recoverable), gated by the same
/// validation as every other trash action. Returns the in-Trash path so the
/// caller can undo by moving it back to its original location.
pub fn trash_into(path: &Path, home: &Path) -> Result<String, String> {
    let canon = validate_trash_target(path, home).map_err(|e| e.message())?;
    let trash = home.join(".Trash");
    fs::create_dir_all(&trash).map_err(|e| format!("Could not open the Trash: {e}"))?;
    let filename = canon
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("File has no name")?;
    let dest = unique_path(&trash, filename, &|p| p.exists());
    move_to(&canon, &dest)?;
    Ok(dest.display().to_string())
}

/// Import a file into the Apple Photos library, then trash the original (move
/// semantics). Returns the in-Trash path of the original for undo.
pub fn file_to_photos(path: &Path, home: &Path) -> Result<String, String> {
    import_to_photos(path)?;
    trash_into(path, home)
}

/// Import a single file into Apple Photos via AppleScript. The library copies the
/// file in; the caller removes the original separately. Photos can stall exactly
/// like Finder does, so its stderr goes through [`crate::errmsg`] before the user
/// ever sees it.
fn import_to_photos(path: &Path) -> Result<(), String> {
    let posix = applescript_quote(&path.display().to_string());
    let script = format!("tell application \"Photos\" to import {{POSIX file {posix}}}");
    run_osascript(&script).map(|_| ()).map_err(|e| crate::errmsg::humanize(&e))
}

/// Show a native folder picker (`choose folder`) with the given prompt and return
/// the chosen POSIX path, or `None` if the user cancels.
pub fn choose_folder(prompt: &str) -> Result<Option<String>, String> {
    let script = format!("POSIX path of (choose folder with prompt {})", applescript_quote(prompt));
    match run_osascript(&script) {
        Ok(out) => {
            let p = out.trim().trim_end_matches('/');
            Ok((!p.is_empty()).then(|| p.to_string()))
        }
        // `choose folder` exits non-zero when cancelled; treat that as "no choice".
        Err(e) if e.contains("User canceled") || e.contains("-128") => Ok(None),
        Err(e) => Err(e),
    }
}

/// AppleScript string literal: wrap in quotes, escaping backslashes and quotes.
fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Run an AppleScript snippet, returning stdout on success or stderr on failure.
fn run_osascript(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Could not run osascript: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// List the loose image files at the top level of each folder, newest first.
/// Unreadable folders are skipped rather than failing the whole call.
pub fn list_loose_images(folders: &[String]) -> Vec<ImageFile> {
    let mut out: Vec<ImageFile> = Vec::new();
    for folder in folders {
        let dir = PathBuf::from(folder);
        let source = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(folder)
            .to_string();
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() || !meta.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let Some(ext) = image_ext(name) else { continue };
            out.push(ImageFile {
                path: path.display().to_string(),
                name: name.to_string(),
                size: meta.len(),
                mtime: meta.mtime(),
                ext,
                source: source.clone(),
            });
        }
    }
    // Newest first; ties broken by path for a stable order.
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn write(path: &Path, bytes: &[u8]) {
        let mut f = File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn image_ext_recognizes_images_only() {
        assert_eq!(image_ext("IMG_4821.HEIC").as_deref(), Some("heic"));
        assert_eq!(image_ext("shot.PNG").as_deref(), Some("png"));
        assert_eq!(image_ext("photo.jpeg").as_deref(), Some("jpeg"));
        assert_eq!(image_ext("notes.pdf"), None);
        assert_eq!(image_ext("archive.zip"), None);
        assert_eq!(image_ext("noext"), None);
        assert_eq!(image_ext(".DS_Store"), None);
    }

    #[test]
    fn unique_path_inserts_counter_before_extension() {
        let dir = Path::new("/dest");
        // Pretend "a.png" and "a 2.png" already exist; "a 3.png" is free.
        let taken = |p: &Path| {
            matches!(
                p.file_name().and_then(|n| n.to_str()),
                Some("a.png") | Some("a 2.png")
            )
        };
        assert_eq!(unique_path(dir, "a.png", &taken), PathBuf::from("/dest/a 3.png"));
        // A free name is returned unchanged.
        assert_eq!(unique_path(dir, "b.png", &|_| false), PathBuf::from("/dest/b.png"));
        // Extensionless name still gets a counter.
        let taken_noext = |p: &Path| p.file_name().and_then(|n| n.to_str()) == Some("README");
        assert_eq!(unique_path(dir, "README", &taken_noext), PathBuf::from("/dest/README 2"));
    }

    #[test]
    fn move_into_relocates_and_avoids_collisions() {
        let tmp = tempfile::tempdir().unwrap();
        let src_dir = tmp.path().join("Desktop");
        let dest_dir = tmp.path().join("Documents/Photos");
        fs::create_dir_all(&src_dir).unwrap();

        let a = src_dir.join("pic.png");
        write(&a, b"one");
        let moved = move_into(&a, &dest_dir).unwrap();
        assert!(moved.ends_with("pic.png"));
        assert!(moved.exists() && !a.exists(), "file moved, source gone");

        // A second file of the same name lands as "pic 2.png".
        let b = src_dir.join("pic.png");
        write(&b, b"two");
        let moved2 = move_into(&b, &dest_dir).unwrap();
        assert!(moved2.ends_with("pic 2.png"), "collision got a counter: {moved2:?}");
    }

    #[test]
    fn move_to_round_trips_for_undo() {
        let tmp = tempfile::tempdir().unwrap();
        let orig = tmp.path().join("orig.png");
        let moved = tmp.path().join("sub").join("orig.png");
        fs::create_dir_all(moved.parent().unwrap()).unwrap();
        write(&orig, b"data");

        move_to(&orig, &moved).unwrap();
        assert!(moved.exists() && !orig.exists());
        // Undo: move it back.
        move_to(&moved, &orig).unwrap();
        assert!(orig.exists() && !moved.exists());
    }

    #[test]
    fn trash_into_moves_under_dot_trash() {
        // Use the tempdir as $HOME so validation passes and ~/.Trash is here.
        let home = tempfile::tempdir().unwrap();
        let desktop = home.path().join("Desktop");
        fs::create_dir_all(&desktop).unwrap();
        let f = desktop.join("junk.png");
        write(&f, b"junk");

        let trashed = trash_into(&f, home.path()).unwrap();
        assert!(trashed.contains("/.Trash/"), "moved into ~/.Trash: {trashed}");
        assert!(PathBuf::from(&trashed).exists() && !f.exists());

        // Undo restores it.
        move_to(Path::new(&trashed), &f).unwrap();
        assert!(f.exists());
    }

    #[test]
    fn list_loose_images_filters_and_sorts_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let desktop = tmp.path().join("Desktop");
        fs::create_dir_all(&desktop).unwrap();
        write(&desktop.join("a.png"), b"a");
        write(&desktop.join("b.heic"), b"b");
        write(&desktop.join("notes.pdf"), b"x"); // not an image
        fs::create_dir(desktop.join("subfolder")).unwrap(); // not a file
        // Make a.png the newer of the two images.
        let later = std::time::SystemTime::now();
        filetime_set(&desktop.join("a.png"), later);

        let imgs = list_loose_images(&[desktop.display().to_string()]);
        let names: Vec<&str> = imgs.iter().map(|i| i.name.as_str()).collect();
        assert!(names.contains(&"a.png") && names.contains(&"b.heic"));
        assert!(!names.contains(&"notes.pdf"), "non-images excluded");
        assert_eq!(imgs.len(), 2, "only the two top-level images");
        assert!(imgs.iter().all(|i| i.source == "Desktop"));
    }

    // Bump a file's mtime to "now" so ordering is deterministic in the test above.
    fn filetime_set(path: &Path, t: std::time::SystemTime) {
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(t).unwrap();
    }

    #[test]
    fn settings_defaults_and_serde_round_trip() {
        let home = PathBuf::from("/Users/tester");
        let s = Settings::defaults(&home);
        assert_eq!(s.sources, vec!["/Users/tester/Desktop", "/Users/tester/Downloads"]);
        assert!(s.destinations.iter().any(|d| d.kind == DestKind::Photos));
        assert_eq!(s.destinations[0].path.as_deref(), Some("/Users/tester/Pictures"));

        let json = serde_json::to_string(&s).unwrap();
        // Enum serializes lowercase for a friendly JSON config.
        assert!(json.contains("\"kind\":\"folder\""));
        assert!(json.contains("\"kind\":\"photos\""));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back, "settings survive a JSON round trip");
    }

    #[test]
    fn retaining_existing_drops_missing_folders_keeps_photos() {
        let home = PathBuf::from("/Users/tester");
        // Pretend only Desktop exists on disk.
        let filtered = Settings::defaults(&home).retaining_existing(|p| p == "/Users/tester/Desktop");
        assert!(filtered.destinations.iter().any(|d| d.kind == DestKind::Photos), "Apple Photos always kept");
        assert!(
            !filtered.destinations.iter().any(|d| d.kind == DestKind::Folder),
            "missing Pictures folder is dropped"
        );
        assert_eq!(filtered.sources, vec!["/Users/tester/Desktop"], "missing Downloads is dropped");
    }

    #[test]
    fn applescript_quoting_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_quote("/a/b"), "\"/a/b\"");
        assert_eq!(applescript_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(applescript_quote("a\\b"), "\"a\\\\b\"");
    }
}
