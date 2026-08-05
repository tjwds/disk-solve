//! Turning platform errors into a sentence the user can act on.
//!
//! Most of what can go wrong in this app goes through AppleScript, so what comes
//! back is a line like
//!
//! ```text
//! 29:90: execution error: Finder got an error: AppleEvent timed out. (-1712)
//! ```
//!
//! sometimes wrapped again in the `trash` crate's `Debug` formatting. Everything
//! here is a pure string transform: [`humanize`] recognizes the few cases we can
//! say something useful about, and otherwise unwraps the layers of noise and
//! returns the underlying description on a single line.

/// A plain-language message for a raw platform error string.
pub fn humanize(raw: &str) -> String {
    let cause = unwrap(raw);
    classify(&cause).unwrap_or(cause)
}

/// A plain-language message for a failure from the `trash` crate.
pub fn trash_error(e: &trash::Error) -> String {
    match e {
        // Both carry the underlying platform text (on macOS, osascript's stderr).
        trash::Error::Os { description, .. } | trash::Error::Unknown { description } => humanize(description),
        trash::Error::CouldNotAccess { .. } => {
            "Could not read the item — it may have moved, or disk-solve may not have permission to it.".into()
        }
        trash::Error::CanonicalizePath { .. } => "The item no longer exists.".into(),
        trash::Error::TargetedRoot => "Refusing to trash a volume root.".into(),
        other => humanize(&other.to_string()),
    }
}

/// The application AppleScript was talking to, when the error names one:
/// `"… execution error: Finder got an error: …"` → `"Finder"`, and
/// `"Not authorized to send Apple events to Finder."` → `"Finder"`.
fn app_name(cause: &str) -> Option<&str> {
    let name = match cause.find(" got an error") {
        Some(i) => cause[..i].rsplit(": ").next()?.trim(),
        None => cause.split("Apple events to ").nth(1)?.split(['.', ',', '(']).next()?.trim(),
    };
    // A sane app name only — anything longer is us having mis-parsed the line.
    (!name.is_empty() && name.len() <= 32).then_some(name)
}

/// The cases we can turn into advice. `None` means "just show the cause".
fn classify(cause: &str) -> Option<String> {
    let app = app_name(cause).unwrap_or("macOS");
    let lower = cause.to_ascii_lowercase();

    // -1712: the Apple event timed out. The app may well still be working on it,
    // so we can't claim either that it happened or that it didn't.
    if cause.contains("(-1712)") || lower.contains("timed out") {
        return Some(format!(
            "{app} didn't respond in time. It may still be finishing in the background — wait a moment, then try again."
        ));
    }
    // -1743: the user hasn't granted this app control of the other one.
    if cause.contains("(-1743)") || lower.contains("not authorized") || lower.contains("not allowed to send apple events") {
        return Some(format!(
            "disk-solve isn't allowed to control {app}. Grant it in System Settings › Privacy & Security › Automation, then try again."
        ));
    }
    // -128: the user dismissed a dialog.
    if cause.contains("(-128)") || lower.contains("user canceled") || lower.contains("user cancelled") {
        return Some("Cancelled.".into());
    }
    // -43 / -10006: the item isn't where we said it was.
    if cause.contains("(-43)") || lower.contains("can't be found") || lower.contains("couldn't be found") {
        return Some("The item no longer exists.".into());
    }
    None
}

/// Peel the wrappers off a raw error and return the underlying cause on one line.
fn unwrap(raw: &str) -> String {
    let mut s = raw.trim();
    // `trash::Error`'s Display is `Error during a `trash` operation: {self:?}`.
    if let Some(rest) = s.strip_prefix("Error during a `trash` operation:") {
        s = rest.trim_start();
    }
    let inner = debug_description(s).unwrap_or_else(|| s.to_string());
    let cause = inner.trim();
    let cause = cause
        .strip_prefix("The AppleScript exited with error. stderr:")
        .unwrap_or(cause)
        .trim();
    collapse_ws(strip_script_location(cause))
}

/// The `description: "…"` field out of a `Debug`-formatted struct variant, with
/// its escapes undone. `None` when there is no such field to pull out.
fn debug_description(s: &str) -> Option<String> {
    let start = s.find("description: \"")? + "description: \"".len();
    let mut out = String::new();
    let mut chars = s[start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some(other) => out.push(other), // \" and \\ stand for themselves
                None => break,
            },
            _ => out.push(c),
        }
    }
    None // unterminated — treat the whole thing as opaque
}

/// Drop osascript's `line:column: execution error:` prefix.
fn strip_script_location(s: &str) -> &str {
    const MARKER: &str = "execution error:";
    let Some(i) = s.find(MARKER) else { return s };
    if s[..i].chars().all(|c| c.is_ascii_digit() || c == ':' || c.is_whitespace()) {
        s[i + MARKER.len()..].trim()
    } else {
        s
    }
}

/// One line, single-spaced — these end up in a one-line banner in the UI.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact string a Finder timeout produced in the wild.
    const FINDER_TIMEOUT: &str = "Error during a `trash` operation: Os { code: 1, description: \"The AppleScript exited with error. stderr: 29:90: execution error: Finder got an error: AppleEvent timed out. (-1712)\\n\" }";

    #[test]
    fn finder_timeout_reads_as_a_sentence() {
        let msg = humanize(FINDER_TIMEOUT);
        assert_eq!(
            msg,
            "Finder didn't respond in time. It may still be finishing in the background — wait a moment, then try again."
        );
        // None of the machinery leaks through.
        assert!(!msg.contains("Os {"));
        assert!(!msg.contains("-1712"));
        assert!(!msg.contains("stderr"));
    }

    #[test]
    fn names_whichever_app_stalled() {
        let raw = "29:90: execution error: Photos got an error: AppleEvent timed out. (-1712)";
        assert!(humanize(raw).starts_with("Photos didn't respond in time."));
        // Two-word app names survive the split.
        let raw = "0:0: execution error: System Events got an error: AppleEvent timed out. (-1712)";
        assert!(humanize(raw).starts_with("System Events didn't respond in time."));
    }

    #[test]
    fn unnamed_app_falls_back_to_the_os() {
        assert!(humanize("The operation timed out").starts_with("macOS didn't respond in time."));
    }

    #[test]
    fn automation_permission_is_actionable() {
        let raw = "0:0: execution error: Not authorized to send Apple events to Finder. (-1743)";
        let msg = humanize(raw);
        assert!(msg.contains("isn't allowed to control Finder"), "{msg}");
        assert!(msg.contains("Privacy & Security"), "{msg}");
    }

    #[test]
    fn cancel_and_missing_items_are_recognized() {
        assert_eq!(humanize("0:0: execution error: User canceled. (-128)"), "Cancelled.");
        let missing = "0:0: execution error: Finder got an error: The file can't be found. (-43)";
        assert_eq!(humanize(missing), "The item no longer exists.");
    }

    #[test]
    fn unrecognized_errors_keep_their_cause_on_one_line() {
        let raw = "Error during a `trash` operation: Os { code: 1, description: \"The AppleScript exited with error. stderr: 12:3: execution error: Finder got an error:\\nsomething\\tnew (-9999)\\n\" }";
        assert_eq!(humanize(raw), "Finder got an error: something new (-9999)");
    }

    #[test]
    fn plain_messages_pass_through_untouched() {
        assert_eq!(humanize("Path does not exist"), "Path does not exist");
        assert_eq!(humanize(""), "");
    }

    #[test]
    fn typed_trash_errors_are_described() {
        assert_eq!(
            trash_error(&trash::Error::CanonicalizePath { original: "/tmp/gone".into() }),
            "The item no longer exists."
        );
        assert_eq!(
            trash_error(&trash::Error::TargetedRoot),
            "Refusing to trash a volume root."
        );
        assert!(trash_error(&trash::Error::CouldNotAccess { target: "/tmp/x".into() })
            .starts_with("Could not read the item"));
        // The variant the Finder path actually produces.
        assert!(trash_error(&trash::Error::Os {
            code: 1,
            description: "The AppleScript exited with error. stderr: 29:90: execution error: Finder got an error: AppleEvent timed out. (-1712)\n".into(),
        })
        .starts_with("Finder didn't respond in time."));
    }
}
