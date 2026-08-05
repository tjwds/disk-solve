// What the UI does with a failed operation. The backend already returns plain
// sentences (see src-tauri/src/errmsg.rs), so the work here is turning *anything*
// a rejected promise can carry into one displayable line, and recognizing the two
// cases the app can handle by itself rather than just reporting.

/** One line of readable text for anything thrown or rejected. */
export function errText(e: unknown): string {
  const raw =
    typeof e === "string" ? e
    : e instanceof Error ? e.message
    : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message
    : String(e);
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || s === "[object Object]" || s === "undefined" || s === "null") return "Something went wrong.";
  // Outside the Tauri shell (the browser demo) there is no IPC bridge, so every
  // backend call dies on the missing global. Say what that means instead.
  if (s.includes("__TAURI_INTERNALS__")) return "That needs the disk·solve app — this is the browser demo.";
  return s.length > 240 ? s.slice(0, 239).trimEnd() + "…" : s;
}

/** True when an error means the file is already gone (moved or deleted elsewhere).
 *  The item can simply leave the view — there is nothing for the user to fix. */
export function isMissing(e: unknown): boolean {
  const s = errText(e).toLowerCase();
  return s.includes("not found") || s.includes("does not exist") || s.includes("no such file") || s.includes("no longer exists");
}

/** True when the failure was the OS not answering (a stalled Finder, an Apple
 *  event timeout). Everything queued behind it would hit the same stall, so a
 *  batch stops here instead of grinding through one timeout per item. */
export function isUnresponsive(e: unknown): boolean {
  const s = errText(e).toLowerCase();
  return s.includes("didn't respond") || s.includes("timed out") || s.includes("(-1712)");
}

/** How a batch of trash operations ended. */
export interface TrashOutcome {
  /** Paths the user asked to trash. */
  total: number;
  /** Paths that reached the Trash (or were already gone). */
  done: number;
  /** One reason per failed path, in the order they failed. */
  failed: string[];
  /** True when the run gave up before trying every path. */
  stopped: boolean;
}

/** What to tell the user about a partly-failed batch; `null` when all was well.
 *  Always leads with what *did* happen, so the tree they're looking at matches
 *  the sentence they're reading. */
export function trashFailureText({ total, done, failed, stopped }: TrashOutcome): string | null {
  if (failed.length === 0) return null;
  const reasons = [...new Set(failed)];
  const shown = reasons.slice(0, 2).join(" · ");
  const detail = reasons.length > 2 ? `${shown} · and ${reasons.length - 2} more` : shown;
  if (total === 1) return detail;
  const head = stopped
    ? `Stopped after moving ${done} of ${total} items to the Trash.`
    : `Moved ${done} of ${total} items to the Trash; ${failed.length} could not be moved.`;
  return `${head} ${detail}`;
}
