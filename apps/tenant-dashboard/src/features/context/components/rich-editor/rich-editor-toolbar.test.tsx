// @vitest-environment jsdom
/**
 * Tests for the rich-surface formatting toolbar. The Milkdown editor cannot be
 * created in-process under Vitest (see rich-markdown-editor.test.tsx); we mock
 * ONLY the @milkdown/react instance hook — the seam handing the toolbar its
 * editor — and assert the toolbar's own contract: every group's buttons render,
 * each command click dispatches the EXACT command key (+ payload) through
 * `commandsCtx` and refocuses the view, the disabled prop gates every button,
 * and the Link action drives its URL popover (set / update / remove) rather than
 * inserting an empty link.
 */
import { commandsCtx, editorViewCtx } from "@milkdown/core";
import { listenerCtx } from "@milkdown/plugin-listener";
import {
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  updateLinkCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand, toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import { redoCommand, undoCommand } from "@milkdown/plugin-history";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCall = vi.fn();
const mockFocus = vi.fn();
const mockDispatch = vi.fn();

// A stand-in for ProseMirror's link MarkType — identity-compared, never introspected.
const linkMarkType = { name: "link" } as unknown as never;
// Controls the fake editor state the toolbar reads for link context.
let selectionEmpty = true;
let existingHref: string | null = null;
// The selection listener the toolbar registers — tests fire it to push new state.
let selectionCb: ((ctx: typeof fakeCtx) => void) | null = null;

const removeMarkTr = { tr: "removeMark" };

// A single link-marked inline node standing in for the link under the cursor.
const linkNode = () => ({ marks: [{ type: linkMarkType, attrs: { href: existingHref } }], nodeSize: 5 });
// Parent block with just that node — feeds linkRangeAt's contiguous-run walk.
const linkParent = {
  forEach: (cb: (n: unknown, offset: number) => void) => {
    if (existingHref !== null) cb(linkNode(), 0);
  },
};

function fakeState() {
  return {
    selection: { empty: selectionEmpty, from: 0, to: selectionEmpty ? 0 : 5 },
    schema: { marks: { link: linkMarkType } },
    doc: {
      content: { size: 100 },
      nodesBetween: (_from: number, _to: number, cb: (n: unknown, p: number) => void) => {
        if (existingHref !== null) cb(linkNode(), 0);
      },
      resolve: (_pos: number) => ({ parent: linkParent, parentOffset: 0 }),
    },
    tr: { removeMark: () => removeMarkTr },
  };
}

// The DOM `click` handler the toolbar registers via view.setProps — tests fire
// it to drive the link-click interception path.
let registeredClick: ((view: unknown, event: MouseEvent) => boolean) | null = null;
let posAtCoordsResult: { pos: number; inside: number } | null = { pos: 2, inside: 1 };

const fakeView = {
  get state() {
    return fakeState();
  },
  focus: mockFocus,
  dispatch: mockDispatch,
  props: {} as { handleDOMEvents?: Record<string, unknown> },
  setProps(next: { handleDOMEvents?: Record<string, (view: unknown, event: MouseEvent) => boolean> }) {
    fakeView.props = { ...fakeView.props, ...next };
    const click = next.handleDOMEvents?.click;
    if (click) registeredClick = click;
  },
  posAtCoords: (_coords: { left: number; top: number }) => posAtCoordsResult,
};

const listenerManager = {
  selectionUpdated: (cb: (ctx: typeof fakeCtx) => void) => {
    selectionCb = cb;
    return listenerManager;
  },
};

const fakeCtx = {
  get: (slice: unknown) => {
    if (slice === commandsCtx) return { call: mockCall };
    if (slice === editorViewCtx) return fakeView;
    if (slice === listenerCtx) return listenerManager;
    throw new Error("unexpected ctx slice");
  },
};
const fakeEditor = { action: (fn: (ctx: typeof fakeCtx) => void) => fn(fakeCtx) };
let instanceLoading = false;
let instanceEditor: typeof fakeEditor | undefined = fakeEditor;

vi.mock("@milkdown/react", () => ({
  useInstance: () => [instanceLoading, () => instanceEditor],
}));

// Real i18n + en.json so the popover's labels resolve to shipped English.
vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

import { RichEditorToolbar } from "./rich-editor-toolbar";

/** Every toolbar action in render order — the toolbar groups flattened. */
const ALL_LABELS = [
  "Bold",
  "Italic",
  "Strikethrough",
  "Inline code",
  "Heading 1",
  "Heading 2",
  "Heading 3",
  "Body text",
  "Bullet list",
  "Numbered list",
  "Quote",
  "Code block",
  "Link",
  "Table",
  "Divider",
  "Undo",
  "Redo",
];

beforeEach(() => {
  mockCall.mockClear();
  mockFocus.mockClear();
  mockDispatch.mockClear();
  instanceLoading = false;
  instanceEditor = fakeEditor;
  selectionEmpty = true;
  existingHref = null;
  selectionCb = null;
  registeredClick = null;
  posAtCoordsResult = { pos: 2, inside: 1 };
  fakeView.props = {};
});

/** A left mouse click event carrying the given modifier + spy-able preventDefault. */
function clickEvent(mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  return {
    button: 0,
    clientX: 40,
    clientY: 80,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    preventDefault: vi.fn(),
  } as unknown as MouseEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

/** Push a fresh selection/link state through the registered listener. */
function pushSelection(next: { selectionEmpty?: boolean; existingHref?: string | null }) {
  if (next.selectionEmpty !== undefined) selectionEmpty = next.selectionEmpty;
  if (next.existingHref !== undefined) existingHref = next.existingHref;
  act(() => selectionCb?.(fakeCtx));
}

describe("<RichEditorToolbar>", () => {
  it("renders every group's actions in render order", () => {
    render(<RichEditorToolbar />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(ALL_LABELS);
  });

  it.each([
    ["Bold", toggleStrongCommand.key, undefined],
    ["Italic", toggleEmphasisCommand.key, undefined],
    ["Strikethrough", toggleStrikethroughCommand.key, undefined],
    ["Inline code", toggleInlineCodeCommand.key, undefined],
    ["Heading 1", wrapInHeadingCommand.key, 1],
    ["Heading 2", wrapInHeadingCommand.key, 2],
    ["Heading 3", wrapInHeadingCommand.key, 3],
    ["Body text", turnIntoTextCommand.key, undefined],
    ["Bullet list", wrapInBulletListCommand.key, undefined],
    ["Numbered list", wrapInOrderedListCommand.key, undefined],
    ["Quote", wrapInBlockquoteCommand.key, undefined],
    ["Code block", createCodeBlockCommand.key, undefined],
    ["Table", insertTableCommand.key, { row: 3, col: 3 }],
    ["Divider", insertHrCommand.key, undefined],
    ["Undo", undoCommand.key, undefined],
    ["Redo", redoCommand.key, undefined],
  ])("dispatches %s through the command API with its exact key and payload", (label, key, payload) => {
    render(<RichEditorToolbar />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(mockCall.mock.calls).toEqual([[key, payload]]);
    // The click must hand focus back to the prose surface.
    expect(mockFocus.mock.calls).toEqual([[]]);
  });

  it("disables every action when the surface is read-only", () => {
    render(<RichEditorToolbar disabled />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => (b as HTMLButtonElement).disabled)).toEqual(
      ALL_LABELS.map(() => true),
    );
  });

  it("dispatches nothing while the editor instance is still loading", () => {
    instanceLoading = true;
    instanceEditor = undefined;
    render(<RichEditorToolbar />);
    // Buttons are disabled during load; even a programmatic click is a no-op.
    const bold = screen.getByRole("button", { name: "Bold" });
    expect((bold as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(bold);
    expect(mockCall.mock.calls).toEqual([]);
  });
});

describe("<RichEditorToolbar> — Link URL popover", () => {
  it("disables the Link button with no selection and no link under the cursor", () => {
    render(<RichEditorToolbar />);
    expect((screen.getByRole("button", { name: "Link" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Link once a selection exists and wraps it via toggleLink on Apply", () => {
    render(<RichEditorToolbar />);
    pushSelection({ selectionEmpty: false, existingHref: null });

    const linkBtn = screen.getByRole("button", { name: "Link" }) as HTMLButtonElement;
    expect(linkBtn.disabled).toBe(false);
    fireEvent.click(linkBtn);

    const input = screen.getByLabelText("Link URL");
    // A fresh link starts with an empty URL field.
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.change(input, { target: { value: "https://entered.url" } });
    fireEvent.click(screen.getByTestId("link-apply"));

    expect(mockCall.mock.calls).toEqual([[toggleLinkCommand.key, { href: "https://entered.url" }]]);
    expect(mockFocus).toHaveBeenCalledTimes(1);
  });

  it("prefills the current href and updates it via updateLink for a cursor inside a link", () => {
    render(<RichEditorToolbar />);
    pushSelection({ selectionEmpty: true, existingHref: "https://old.url" });

    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    const input = screen.getByLabelText("Link URL");
    expect((input as HTMLInputElement).value).toBe("https://old.url");

    fireEvent.change(input, { target: { value: "https://new.url" } });
    fireEvent.click(screen.getByTestId("link-apply"));

    expect(mockCall.mock.calls).toEqual([[updateLinkCommand.key, { href: "https://new.url" }]]);
  });

  it("removes the link (strips the mark, dispatches no link command) when Apply has an empty URL", () => {
    render(<RichEditorToolbar />);
    pushSelection({ selectionEmpty: true, existingHref: "https://old.url" });

    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.change(screen.getByLabelText("Link URL"), { target: { value: "  " } });
    fireEvent.click(screen.getByTestId("link-apply"));

    // No set/update command — the mark is stripped through a removeMark transaction.
    expect(mockCall).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(removeMarkTr);
  });

  it("offers no Remove affordance for a brand-new link over a selection", () => {
    render(<RichEditorToolbar />);
    pushSelection({ selectionEmpty: false, existingHref: null });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(screen.getByTestId("link-apply")).toBeInTheDocument();
    expect(screen.queryByTestId("link-remove")).toBeNull();
  });

  it("offers Remove when the cursor is inside a link, and it strips the mark", () => {
    render(<RichEditorToolbar />);
    pushSelection({ selectionEmpty: true, existingHref: "https://old.url" });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.click(screen.getByTestId("link-remove"));
    expect(mockDispatch).toHaveBeenCalledWith(removeMarkTr);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe("<RichEditorToolbar> — link-click interception", () => {
  it("opens the popover prefilled and suppresses navigation on a plain link click", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(<RichEditorToolbar />);
    existingHref = "https://clicked.url";
    const event = clickEvent();

    let handled = false;
    act(() => {
      handled = registeredClick!(fakeView, event);
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Link URL") as HTMLInputElement).value).toBe("https://clicked.url");
    openSpy.mockRestore();
  });

  it("opens a non-empty href in a new tab on mod-click (no popover)", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(<RichEditorToolbar />);
    existingHref = "https://clicked.url";
    const event = clickEvent({ metaKey: true });

    let handled = false;
    act(() => {
      handled = registeredClick!(fakeView, event);
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith("https://clicked.url", "_blank", "noopener,noreferrer");
    expect(screen.queryByLabelText("Link URL")).toBeNull();
    openSpy.mockRestore();
  });

  it("opens the editor for an empty-href link on plain click (the reload trap)", () => {
    render(<RichEditorToolbar />);
    existingHref = "";
    const event = clickEvent();

    let handled = false;
    act(() => {
      handled = registeredClick!(fakeView, event);
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Link URL") as HTMLInputElement).value).toBe("");
  });

  it("never opens a blank-href tab on mod-click of an empty-href link", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(<RichEditorToolbar />);
    existingHref = "";
    const event = clickEvent({ ctrlKey: true });

    act(() => {
      registeredClick!(fakeView, event);
    });

    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Link URL")).toBeInTheDocument();
    openSpy.mockRestore();
  });

  it("does not intercept a click off any link", () => {
    render(<RichEditorToolbar />);
    existingHref = null; // no link under the click
    const event = clickEvent();

    let handled = true;
    act(() => {
      handled = registeredClick!(fakeView, event);
    });

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Link URL")).toBeNull();
  });
});
