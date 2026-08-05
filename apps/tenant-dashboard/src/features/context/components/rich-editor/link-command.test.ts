import { describe, expect, it, vi } from "vitest";
import { Schema, type Mark } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { toggleLinkCommand, updateLinkCommand } from "@milkdown/preset-commonmark";
import {
  applyLink,
  handleLinkClick,
  isLinkTargetAbsent,
  linkAt,
  readLinkContext,
  removeLinkAt,
} from "./link-command";

// A minimal real ProseMirror schema — exercising the link logic against actual
// doc/selection/transaction objects (not a hand-fake) so Stryker's mutants to
// the scan/range arithmetic and boolean logic die in-process.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
  marks: {
    link: { attrs: { href: {} }, inclusive: false },
    strong: {},
  },
});
// A second schema with no link mark — exercises the "link mark absent" guards.
const linklessSchema = new Schema({
  nodes: { doc: { content: "block+" }, paragraph: { group: "block", content: "inline*" }, text: { group: "inline" } },
  marks: { strong: {} },
});

const link = (href: string): Mark => schema.marks.link.create({ href });
const strong = (): Mark => schema.marks.strong.create();

interface Seg {
  text: string;
  marks?: Mark[];
}

/** Single-paragraph state with a selection at [from, to]. */
function paragraphState(segments: Seg[], from: number, to = from, s: Schema = schema): EditorState {
  const inline = segments.map((seg) => s.text(seg.text, seg.marks ?? []));
  const doc = s.node("doc", null, s.node("paragraph", null, inline));
  const base = EditorState.create({ doc });
  return base.apply(base.tr.setSelection(TextSelection.create(doc, from, to)));
}

/** A view stub over a real state, capturing dispatched transactions. */
function stubView(state: EditorState) {
  const dispatch = vi.fn();
  return { view: { state, dispatch } as unknown as EditorView, dispatch };
}

/** The [from, to] ranges of every step in the (single) dispatched transaction. */
function dispatchedRanges(dispatch: ReturnType<typeof vi.fn>): Array<[number, number]> {
  const tr = dispatch.mock.calls[0]?.[0] as { steps: Array<{ from: number; to: number }> } | undefined;
  return (tr?.steps ?? []).map((step) => [step.from, step.to]);
}

describe("readLinkContext", () => {
  it("reads the href of the link under a bare cursor", () => {
    // "hello" [1,6) carries the link; cursor at 3 sits inside it.
    const state = paragraphState([{ text: "hello", marks: [link("https://a.dev")] }], 3);
    expect(readLinkContext(state)).toEqual({ hasSelection: false, existingHref: "https://a.dev" });
  });

  it("reports no link for a cursor on plain text", () => {
    const state = paragraphState([{ text: "hello" }], 3);
    expect(readLinkContext(state)).toEqual({ hasSelection: false, existingHref: null });
  });

  it("finds the link when the selection spans the link boundary into plain text", () => {
    // "aa"[link] then "bb" plain; select from inside the link (2) into plain (4).
    const state = paragraphState(
      [{ text: "aa", marks: [link("https://a.dev")] }, { text: "bb" }],
      2,
      4,
    );
    expect(readLinkContext(state)).toEqual({ hasSelection: true, existingHref: "https://a.dev" });
  });

  it("detects a link at the cursor's left edge (the to+1 probe on an empty selection)", () => {
    // Cursor at 1 is exactly the link's start; only scanning [1,2) reveals it.
    const state = paragraphState([{ text: "hello", marks: [link("https://a.dev")] }], 1);
    expect(readLinkContext(state).existingHref).toBe("https://a.dev");
  });

  it("uses the passed selection over the state's stale selection", () => {
    // State cursor sits on plain "xx" [1,3); the fresh selection spans link "yy" [3,5).
    const state = paragraphState(
      [{ text: "xx" }, { text: "yy", marks: [link("https://y.dev")] }],
      1,
    );
    const fresh = TextSelection.create(state.doc, 3, 5);
    expect(readLinkContext(state, fresh)).toEqual({ hasSelection: true, existingHref: "https://y.dev" });
    expect(readLinkContext(state)).toEqual({ hasSelection: false, existingHref: null });
  });

  it("reports no link when the schema has no link mark", () => {
    const state = paragraphState([{ text: "plain" }], 1, 4, linklessSchema);
    expect(readLinkContext(state)).toEqual({ hasSelection: true, existingHref: null });
  });
});

describe("readLinkContext — doc-end boundary probe", () => {
  // The plugin listener fires the post-change selection against the pre-change
  // (smaller) state, so a caret typed at the document's end reports a position at
  // the old doc's `content.size`. The bare-cursor `to + 1` left-edge probe must
  // not scan past the last node — unclamped it dereferences `undefined.nodeSize`
  // inside `nodesBetween` and, in the live toolbar, aborts the keystroke.
  it("does not throw when the fresh cursor sits at this state's shorter doc end", () => {
    const priorState = paragraphState([{ text: "hello" }], 6); // size 7, caret at end
    const grown = paragraphState([{ text: "helloX" }], 7); // after a keystroke: caret 7
    expect(priorState.doc.content.size).toBe(7);
    expect(grown.selection.from).toBe(7); // == priorState's doc end
    // The concrete return proves both no-throw (an unclamped probe would throw
    // here) and the correct context.
    expect(readLinkContext(priorState, grown.selection)).toEqual({
      hasSelection: false,
      existingHref: null,
    });
  });

  it("does not throw for a cursor past the end of an empty document", () => {
    const priorEmpty = paragraphState([], 1); // empty paragraph, size 2
    const grown = paragraphState([{ text: "a" }], 2); // after the first keystroke: caret 2
    expect(priorEmpty.doc.content.size).toBe(2);
    expect(grown.selection.from).toBe(2); // == priorEmpty's doc end
    // The concrete return proves both no-throw and the correct context.
    expect(readLinkContext(priorEmpty, grown.selection)).toEqual({
      hasSelection: false,
      existingHref: null,
    });
  });

  it("reads a cursor at position 0 without scanning past the doc", () => {
    const state = paragraphState([{ text: "hello" }], 0);
    expect(readLinkContext(state)).toEqual({ hasSelection: false, existingHref: null });
  });
});

describe("isLinkTargetAbsent", () => {
  it("is true only with no selection and no link", () => {
    expect(isLinkTargetAbsent({ hasSelection: false, existingHref: null })).toBe(true);
    expect(isLinkTargetAbsent({ hasSelection: true, existingHref: null })).toBe(false);
    expect(isLinkTargetAbsent({ hasSelection: false, existingHref: "https://a.dev" })).toBe(false);
  });
});

describe("removeLinkAt — strips the whole contiguous link", () => {
  it("removes a single-node link over its exact range", () => {
    // "hello" link occupies [1,6).
    const { view, dispatch } = stubView(
      paragraphState([{ text: "hello", marks: [link("https://a.dev")] }], 3),
    );
    removeLinkAt(view);
    expect(dispatchedRanges(dispatch)).toEqual([[1, 6]]);
  });

  it("removes a link spanning two inline nodes (strong + plain) across the full run", () => {
    // "bold"[strong+link] [1,5) then " plain"[link] [5,11); one link, two nodes.
    const { view, dispatch } = stubView(
      paragraphState(
        [
          { text: "bold", marks: [strong(), link("https://a.dev")] },
          { text: " plain", marks: [link("https://a.dev")] },
        ],
        3,
      ),
    );
    removeLinkAt(view);
    expect(dispatchedRanges(dispatch)).toEqual([[1, 11]]);
  });

  it("stops the run at an adjacent link node with a different href", () => {
    // "aa"[link h1] [1,3), "bb"[link h2] [3,5); removing from inside h1 leaves h2.
    const { view, dispatch } = stubView(
      paragraphState(
        [
          { text: "aa", marks: [link("https://h1.dev")] },
          { text: "bb", marks: [link("https://h2.dev")] },
        ],
        2,
      ),
    );
    removeLinkAt(view);
    expect(dispatchedRanges(dispatch)).toEqual([[1, 3]]);
  });

  it("stops the run at an adjacent unmarked node", () => {
    const { view, dispatch } = stubView(
      paragraphState([{ text: "aa", marks: [link("https://a.dev")] }, { text: "bb" }], 2),
    );
    removeLinkAt(view);
    expect(dispatchedRanges(dispatch)).toEqual([[1, 3]]);
  });

  it("keeps the anchor's run and does not jump to a later same-href run", () => {
    // "a"[link h] [1,2), "b" plain [2,3), "c"[link h] [3,4). The anchor is in the
    // first run; the freeze must stop it extending to the second same-href run.
    const { view, dispatch } = stubView(
      paragraphState(
        [
          { text: "a", marks: [link("https://a.dev")] },
          { text: "b" },
          { text: "c", marks: [link("https://a.dev")] },
        ],
        1,
      ),
    );
    removeLinkAt(view);
    expect(dispatchedRanges(dispatch)).toEqual([[1, 2]]);
  });

  it("removes a link sitting at the end of the block over its exact range", () => {
    // "plain " plain [1,7), "end"[link] [7,10).
    const { view, dispatch } = stubView(
      paragraphState([{ text: "plain " }, { text: "end", marks: [link("https://a.dev")] }], 8),
    );
    removeLinkAt(view);
    expect(dispatchedRanges(dispatch)).toEqual([[7, 10]]);
  });

  it("dispatches nothing when the cursor is on plain text", () => {
    const { view, dispatch } = stubView(paragraphState([{ text: "hello" }], 3));
    removeLinkAt(view);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches nothing when the schema has no link mark", () => {
    const { view, dispatch } = stubView(paragraphState([{ text: "hello" }], 3, 3, linklessSchema));
    removeLinkAt(view);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("applyLink", () => {
  it("wraps a fresh selection in a link via toggleLink with the trimmed href", () => {
    const { view, dispatch } = stubView(paragraphState([{ text: "hello" }], 1, 6));
    const call = vi.fn();
    applyLink(view, { call }, "  https://new.dev  ");
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(toggleLinkCommand.key, { href: "https://new.dev" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("updates an existing link's href via updateLink", () => {
    const { view, dispatch } = stubView(
      paragraphState([{ text: "hi", marks: [link("https://old.dev")] }], 2),
    );
    const call = vi.fn();
    applyLink(view, { call }, "https://new.dev");
    expect(call).toHaveBeenCalledWith(updateLinkCommand.key, { href: "https://new.dev" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("removes the link (no command) when the URL is blank", () => {
    const { view, dispatch } = stubView(
      paragraphState([{ text: "hi", marks: [link("https://old.dev")] }], 2),
    );
    const call = vi.fn();
    applyLink(view, { call }, "   ");
    expect(call).not.toHaveBeenCalled();
    expect(dispatchedRanges(dispatch)).toEqual([[1, 3]]);
  });

  it("does nothing on a blank URL when there is no link to remove", () => {
    const { view, dispatch } = stubView(paragraphState([{ text: "hi" }], 1, 3));
    const call = vi.fn();
    applyLink(view, { call }, "");
    expect(call).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("linkAt", () => {
  it("returns the full link range and href at a clicked position", () => {
    // "hello"[link] occupies [1,6); a click lands at pos 3.
    const state = paragraphState([{ text: "hello", marks: [link("https://a.dev")] }], 3);
    expect(linkAt(state, 3)).toEqual({ href: "https://a.dev", from: 1, to: 6 });
  });

  it("returns an empty href for an unfinished [text]() link", () => {
    const state = paragraphState([{ text: "text", marks: [link("")] }], 3);
    expect(linkAt(state, 3)).toEqual({ href: "", from: 1, to: 5 });
  });

  it("returns null on plain text", () => {
    const state = paragraphState([{ text: "hello" }], 3);
    expect(linkAt(state, 3)).toBeNull();
  });

  it("returns null when the schema has no link mark", () => {
    const state = paragraphState([{ text: "hello" }], 3, 3, linklessSchema);
    expect(linkAt(state, 3)).toBeNull();
  });
});

describe("handleLinkClick", () => {
  const handlers = () => ({ openInNewTab: vi.fn(), openLinkEditor: vi.fn() });

  it("opens the editor popover on a plain click, suppressing navigation", () => {
    const state = paragraphState([{ text: "hello", marks: [link("https://a.dev")] }], 3);
    const h = handlers();
    expect(handleLinkClick(state, 3, false, h)).toBe(true);
    expect(h.openLinkEditor).toHaveBeenCalledWith({ href: "https://a.dev", from: 1, to: 6 });
    expect(h.openInNewTab).not.toHaveBeenCalled();
  });

  it("opens a non-empty href in a new tab on mod-click", () => {
    const state = paragraphState([{ text: "hello", marks: [link("https://a.dev")] }], 3);
    const h = handlers();
    expect(handleLinkClick(state, 3, true, h)).toBe(true);
    expect(h.openInNewTab).toHaveBeenCalledWith("https://a.dev");
    expect(h.openLinkEditor).not.toHaveBeenCalled();
  });

  it("opens the editor (not a blank tab) on a plain click of an empty-href link", () => {
    const state = paragraphState([{ text: "text", marks: [link("")] }], 3);
    const h = handlers();
    expect(handleLinkClick(state, 3, false, h)).toBe(true);
    expect(h.openLinkEditor).toHaveBeenCalledWith({ href: "", from: 1, to: 5 });
    expect(h.openInNewTab).not.toHaveBeenCalled();
  });

  it("opens the editor (never a blank-href tab that reloads) on mod-click of an empty-href link", () => {
    const state = paragraphState([{ text: "text", marks: [link("")] }], 3);
    const h = handlers();
    expect(handleLinkClick(state, 3, true, h)).toBe(true);
    expect(h.openInNewTab).not.toHaveBeenCalled();
    expect(h.openLinkEditor).toHaveBeenCalledWith({ href: "", from: 1, to: 5 });
  });

  it("does not handle a click off any link", () => {
    const state = paragraphState([{ text: "hello" }], 3);
    const h = handlers();
    expect(handleLinkClick(state, 3, false, h)).toBe(false);
    expect(h.openInNewTab).not.toHaveBeenCalled();
    expect(h.openLinkEditor).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "file:///etc/passwd"])(
    "never hands an unsafe scheme (%s) to the opener on mod-click — opens the editor instead",
    (href) => {
      const state = paragraphState([{ text: "x", marks: [link(href)] }], 1);
      const h = handlers();
      expect(handleLinkClick(state, 1, true, h)).toBe(true);
      expect(h.openInNewTab).not.toHaveBeenCalled();
      expect(h.openLinkEditor).toHaveBeenCalledWith({ href, from: 1, to: 2 });
    },
  );

  it.each(["https://ok.dev", "http://ok.dev", "mailto:a@b.com", "relative/path"])(
    "opens a safe href (%s) in a new tab on mod-click",
    (href) => {
      const state = paragraphState([{ text: "x", marks: [link(href)] }], 1);
      const h = handlers();
      expect(handleLinkClick(state, 1, true, h)).toBe(true);
      expect(h.openInNewTab).toHaveBeenCalledWith(href);
      expect(h.openLinkEditor).not.toHaveBeenCalled();
    },
  );
});
