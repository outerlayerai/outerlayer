import { describe, expect, it } from "vitest";
import { retightenLists } from "./retighten-lists";

describe("retightenLists", () => {
  it("collapses Milkdown's loosened bullet list back to tight when the source was tight", () => {
    // Source the author wrote (tight) and what Milkdown serializes it to (loose).
    const source = "- a\n- b\n- c\n";
    const loosened = "* a\n\n* b\n\n* c\n";
    // Marker normalization (`-`→`*`) is kept; only the blank lines are removed.
    expect(retightenLists(loosened, source)).toBe("* a\n* b\n* c\n");
  });

  it("preserves an author's genuinely loose list untouched", () => {
    const source = "- a\n\n- b\n\n- c\n";
    const loosened = "* a\n\n* b\n\n* c\n";
    expect(retightenLists(loosened, source)).toBe(loosened);
  });

  it("retightens nested lists at every level when the source nesting was tight", () => {
    const source = "- one\n  - one-a\n  - one-b\n- two\n";
    const loosened = "* one\n\n  * one-a\n\n  * one-b\n\n* two\n";
    expect(retightenLists(loosened, source)).toBe("* one\n  * one-a\n  * one-b\n* two\n");
  });

  it("keeps the blank line before a list and after a list (not between items)", () => {
    const source = "Intro paragraph.\n\n- a\n- b\n\nOutro paragraph.\n";
    const loosened = "Intro paragraph.\n\n* a\n\n* b\n\nOutro paragraph.\n";
    expect(retightenLists(loosened, source)).toBe("Intro paragraph.\n\n* a\n* b\n\nOutro paragraph.\n");
  });

  it("leaves an already-tight ordered list unchanged", () => {
    const source = "1. first\n2. second\n3. third\n";
    const output = "1. first\n2. second\n3. third\n";
    expect(retightenLists(output, source)).toBe(output);
  });

  it("does not touch blank lines inside a fenced code block that contains list-like lines", () => {
    const source = "```md\n- a\n\n- b\n```\n";
    // The blank sits inside a code fence: its neighbours are code, not list items.
    expect(retightenLists(source, source)).toBe(source);
  });

  it("retightens a real list while leaving a code fence's inner blank lines alone", () => {
    const source = "- x\n- y\n\n```\nline1\n\nline2\n```\n";
    const loosened = "* x\n\n* y\n\n```\nline1\n\nline2\n```\n";
    expect(retightenLists(loosened, source)).toBe("* x\n* y\n\n```\nline1\n\nline2\n```\n");
  });

  it("preserves the output verbatim when the source has no lists at all", () => {
    const source = "# Title\n\nJust prose here.\n";
    const output = "# Title\n\nJust prose here.\n";
    expect(retightenLists(output, source)).toBe(output);
  });

  it("preserves a task list's checkboxes while retightening it", () => {
    const source = "- [x] done\n- [ ] todo\n";
    const loosened = "* [x] done\n\n* [ ] todo\n";
    expect(retightenLists(loosened, source)).toBe("* [x] done\n* [ ] todo\n");
  });

  it("preserves a trailing newline (and its absence)", () => {
    expect(retightenLists("* a\n\n* b\n", "- a\n- b\n")).toBe("* a\n* b\n");
    expect(retightenLists("* a\n\n* b", "- a\n- b")).toBe("* a\n* b");
  });

  it("keeps a leading blank line (nothing above it — not between items) while retightening the rest", () => {
    expect(retightenLists("\n* a\n\n* b\n", "- a\n- b\n")).toBe("\n* a\n* b\n");
  });

  it("collapses a run of several blank lines between two items completely", () => {
    expect(retightenLists("* a\n\n\n* b\n", "- a\n- b\n")).toBe("* a\n* b\n");
  });

  it("keeps every blank in a multi-blank gap between a paragraph and a list (not between items)", () => {
    const loosened = "Intro\n\n\n* a\n* b\n";
    expect(retightenLists(loosened, "Intro\n\n\n- a\n- b\n")).toBe(loosened);
  });

  it("treats a whitespace-only line as blank in the drop path", () => {
    // The separator carries spaces; it is still a loosened gap to collapse.
    expect(retightenLists("* a\n  \n* b\n", "- a\n- b\n")).toBe("* a\n* b\n");
  });

  it("treats a whitespace-only line as blank when judging the SOURCE loose", () => {
    // The author's own list is loose (whitespace-only separator) → output kept.
    const loosened = "* a\n\n* b\n";
    expect(retightenLists(loosened, "- a\n \n- b\n")).toBe(loosened);
  });

  it("leaves an UNCLOSED fence's list-like content alone (everything after the fence is code)", () => {
    const doc = "- x\n\n```\n- a\n\n- b\n";
    expect(retightenLists(doc, doc)).toBe(doc);
  });

  it("retightens a real list while a fence holding a loose markdown EXAMPLE stays verbatim", () => {
    // The fence's `- a` / `- b` / `- c` lines must stay masked: they are code,
    // not list items — neither making the source "loose" nor being retightened.
    const source = "- x\n- y\n\n```md\n- a\n\n- b\n\n- c\n```\n";
    const loosened = "* x\n\n* y\n\n```md\n- a\n\n- b\n\n- c\n```\n";
    expect(retightenLists(loosened, source)).toBe("* x\n* y\n\n```md\n- a\n\n- b\n\n- c\n```\n");
  });

  it("retightens a list that FOLLOWS a closed fence (the mask must end at the closing fence)", () => {
    const source = "```\ncode\n```\n\n- a\n- b\n";
    const loosened = "```\ncode\n```\n\n* a\n\n* b\n";
    expect(retightenLists(loosened, source)).toBe("```\ncode\n```\n\n* a\n* b\n");
  });

  it("does not let a ~~~ line close a ``` fence", () => {
    // The ~~~ inside stays code; the fence closes only at the matching ```.
    const doc = "```\n~~~\n- a\n\n- b\n```\n";
    expect(retightenLists(doc, doc)).toBe(doc);
  });
});
