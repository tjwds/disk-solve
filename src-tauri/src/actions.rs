//! User actions on a path. The only destructive one is [`move_to_trash`], and it
//! is gated by [`crate::safety::validate_trash_target`] and performed via the
//! `trash` crate (recoverable macOS Trash) — never `std::fs::remove_*`.

use crate::errmsg;
use crate::safety::validate_trash_target;
use std::path::Path;
use std::process::Command;

/// Abstraction over "send this path to the Trash". Real code uses
/// [`SystemTrasher`]; tests inject a mock so no real file is ever trashed.
pub trait Trasher {
    fn trash(&self, path: &Path) -> Result<(), String>;
}

/// Production trasher: moves the path to the macOS Trash (recoverable).
pub struct SystemTrasher;

impl Trasher for SystemTrasher {
    fn trash(&self, path: &Path) -> Result<(), String> {
        // The `trash` crate asks Finder to do the move, so a failure arrives as
        // AppleScript's stderr inside a Debug-formatted enum. The frontend shows
        // whatever we return verbatim, so translate it here (see [`errmsg`]).
        trash::delete(path).map_err(|e| errmsg::trash_error(&e))
    }
}

/// Validate `target` against `allowed_root`, then move it to the Trash.
/// Returns the path that was trashed on success.
pub fn move_to_trash<T: Trasher>(
    target: &Path,
    allowed_root: &Path,
    trasher: &T,
) -> Result<String, String> {
    let canon = validate_trash_target(target, allowed_root).map_err(|e| e.message())?;
    trasher.trash(&canon)?;
    Ok(canon.display().to_string())
}

/// Build the argv for revealing a path in Finder (`open -R <path>`).
pub fn reveal_args(path: &Path) -> Vec<String> {
    vec!["-R".into(), path.display().to_string()]
}

/// Build the argv for opening Terminal at a directory (`open -a Terminal <dir>`).
pub fn terminal_args(path: &Path) -> Vec<String> {
    vec!["-a".into(), "Terminal".into(), path.display().to_string()]
}

/// Reveal a path in Finder. Non-destructive.
pub fn reveal_in_finder(path: &Path) -> Result<(), String> {
    run("open", &reveal_args(path))
}

/// Open Terminal at a directory. Non-destructive.
pub fn open_terminal_here(path: &Path) -> Result<(), String> {
    run("open", &terminal_args(path))
}

/// Open a path in Finder (`open <path>`). For a directory this opens a Finder
/// window. Non-destructive — used to show the Trash so the user can empty it
/// themselves; the app never empties or hard-deletes anything.
pub fn open_path(path: &Path) -> Result<(), String> {
    run("open", &[path.display().to_string()])
}

/// Quick Look preview a file (`qlmanage -p <path>`). Non-destructive.
pub fn quick_look(path: &Path) -> Result<(), String> {
    // -p = preview; qlmanage prints noise to stderr, which we discard.
    Command::new("qlmanage")
        .arg("-p")
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn run(program: &str, args: &[String]) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;

    /// Records what it was asked to trash; never touches the filesystem.
    struct MockTrasher {
        calls: RefCell<Vec<PathBuf>>,
        result: Result<(), String>,
    }
    impl MockTrasher {
        fn ok() -> Self {
            Self { calls: RefCell::new(vec![]), result: Ok(()) }
        }
    }
    impl Trasher for MockTrasher {
        fn trash(&self, path: &Path) -> Result<(), String> {
            self.calls.borrow_mut().push(path.to_path_buf());
            self.result.clone()
        }
    }

    #[test]
    fn protected_target_never_reaches_trasher() {
        // A path that fails validation must NOT call the trasher at all.
        let root = tempfile::tempdir().unwrap();
        let mock = MockTrasher::ok();
        let err = move_to_trash(root.path(), root.path(), &mock); // root itself => protected
        assert!(err.is_err());
        assert!(mock.calls.borrow().is_empty(), "trasher must not be called for an invalid target");
    }

    #[test]
    fn valid_target_is_trashed_once() {
        let root = tempfile::tempdir().unwrap();
        let f = root.path().join("junk.bin");
        fs::write(&f, b"data").unwrap();
        let mock = MockTrasher::ok();

        let trashed = move_to_trash(&f, root.path(), &mock).unwrap();

        assert_eq!(mock.calls.borrow().len(), 1);
        assert!(trashed.ends_with("junk.bin"));
        // The real file is still here — the mock didn't actually delete it.
        assert!(f.exists());
    }

    #[test]
    fn trasher_failure_is_propagated() {
        let root = tempfile::tempdir().unwrap();
        let f = root.path().join("junk.bin");
        fs::write(&f, b"data").unwrap();
        let mock = MockTrasher { calls: RefCell::new(vec![]), result: Err("boom".into()) };
        assert_eq!(move_to_trash(&f, root.path(), &mock), Err("boom".into()));
    }

    #[test]
    fn arg_builders() {
        assert_eq!(reveal_args(Path::new("/a/b")), vec!["-R", "/a/b"]);
        assert_eq!(terminal_args(Path::new("/a/b")), vec!["-a", "Terminal", "/a/b"]);
    }
}
