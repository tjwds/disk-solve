import { describe, it, expect } from "vitest";
import { errText, isMissing, isUnresponsive, trashFailureText } from "./errmsg";

describe("errText", () => {
  it("reads the message out of whatever was thrown", () => {
    expect(errText("Path does not exist")).toBe("Path does not exist");
    expect(errText(new Error("boom"))).toBe("boom");
    expect(errText({ message: "from an object" })).toBe("from an object");
  });

  it("flattens a multi-line error into one line", () => {
    expect(errText("Finder got an error:\n  AppleEvent timed out.\n")).toBe("Finder got an error: AppleEvent timed out.");
  });

  it("always has something to show", () => {
    expect(errText(undefined)).toBe("Something went wrong.");
    expect(errText(null)).toBe("Something went wrong.");
    expect(errText("   ")).toBe("Something went wrong.");
    expect(errText({})).toBe("Something went wrong.");
  });

  it("explains a backend call made outside the app shell", () => {
    expect(errText(new TypeError("undefined is not an object (evaluating 'window.__TAURI_INTERNALS__.invoke')")))
      .toBe("That needs the disk·solve app — this is the browser demo.");
  });

  it("caps a runaway message", () => {
    const out = errText("x".repeat(1000));
    expect(out.length).toBe(240);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("isMissing", () => {
  it("recognizes a file that is already gone", () => {
    expect(isMissing("Path does not exist")).toBe(true);
    expect(isMissing("The item no longer exists.")).toBe(true);
    expect(isMissing("Source file not found")).toBe(true);
    expect(isMissing(new Error("No such file or directory (os error 2)"))).toBe(true);
  });

  it("leaves real failures alone", () => {
    expect(isMissing("Refusing to trash a symlink")).toBe(false);
    expect(isMissing("Finder didn't respond in time.")).toBe(false);
  });
});

describe("isUnresponsive", () => {
  it("recognizes a stalled Finder, humanized or raw", () => {
    expect(isUnresponsive("Finder didn't respond in time. It may still be finishing in the background — wait a moment, then try again.")).toBe(true);
    expect(isUnresponsive("execution error: Finder got an error: AppleEvent timed out. (-1712)")).toBe(true);
  });

  it("leaves per-item failures alone, so a batch keeps going", () => {
    expect(isUnresponsive("Refusing to trash a symlink")).toBe(false);
    expect(isUnresponsive("Path does not exist")).toBe(false);
  });
});

describe("trashFailureText", () => {
  it("says nothing when nothing failed", () => {
    expect(trashFailureText({ total: 4, done: 4, failed: [], stopped: false })).toBe(null);
  });

  it("gives just the reason for a single item", () => {
    expect(trashFailureText({ total: 1, done: 0, failed: ["Refusing to trash a symlink"], stopped: false }))
      .toBe("Refusing to trash a symlink");
  });

  it("leads with what did happen for a partial batch", () => {
    expect(trashFailureText({ total: 12, done: 10, failed: ["Refusing to trash a symlink", "Refusing to trash a symlink"], stopped: false }))
      .toBe("Moved 10 of 12 items to the Trash; 2 could not be moved. Refusing to trash a symlink");
  });

  it("reports an abandoned batch as stopped", () => {
    expect(trashFailureText({ total: 12, done: 3, failed: ["Finder didn't respond in time."], stopped: true }))
      .toBe("Stopped after moving 3 of 12 items to the Trash. Finder didn't respond in time.");
  });

  it("summarizes past two distinct reasons", () => {
    expect(trashFailureText({ total: 5, done: 1, failed: ["a", "b", "c", "d"], stopped: false }))
      .toBe("Moved 1 of 5 items to the Trash; 4 could not be moved. a · b · and 2 more");
  });
});
