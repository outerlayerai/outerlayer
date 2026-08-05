// @vitest-environment jsdom
/**
 * Unit tests for the editor config wiring (`configureRichEditorCtx`). A real
 * Milkdown editor cannot be created in-process under Vitest (the roundtrip
 * spec drives one in a subprocess); here the config body runs against a fake
 * `Ctx`, pinning exactly what it wires: root + initial value, the live
 * read-only gate, the retightened change forwarding with its no-op-echo guard,
 * and the optional mount signal.
 */
import { defaultValueCtx, editorViewOptionsCtx, rootCtx } from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import { listenerCtx } from "@milkdown/plugin-listener";
import { describe, expect, it, vi } from "vitest";
import { configureRichEditorCtx } from "./create-rich-editor";

type MarkdownUpdatedCb = (ctx: unknown, markdown: string, prevMarkdown: string) => void;

function makeFakeCtx() {
  const manager = {
    markdownUpdated: vi.fn<(cb: MarkdownUpdatedCb) => void>(),
    mounted: vi.fn<(cb: () => void) => void>(),
  };
  const set = vi.fn();
  const update = vi.fn();
  const ctx = {
    set,
    update,
    get: (slice: unknown) => {
      if (slice === listenerCtx) return manager;
      throw new Error("unexpected ctx slice");
    },
  } as unknown as Ctx;
  return { ctx, manager, set, update };
}

const baseHandlers = () => ({
  getValue: () => "# initial\n",
  getSource: () => "- a\n- b\n",
  isReadOnly: () => false,
  onChange: vi.fn(),
});

describe("configureRichEditorCtx", () => {
  it("wires the root element and the initial markdown into the editor contexts", () => {
    const { ctx, set } = makeFakeCtx();
    const root = document.createElement("div");

    configureRichEditorCtx(root, baseHandlers())(ctx);

    expect(set.mock.calls).toEqual([
      [rootCtx, root],
      [defaultValueCtx, "# initial\n"],
    ]);
  });

  it("installs an editable gate that re-reads the LIVE readOnly value on every call", () => {
    const { ctx, update } = makeFakeCtx();
    let readOnly = false;
    const handlers = { ...baseHandlers(), isReadOnly: () => readOnly };

    configureRichEditorCtx(document.createElement("div"), handlers)(ctx);

    expect(update).toHaveBeenCalledWith(editorViewOptionsCtx, expect.any(Function));
    const updater = update.mock.calls[0]![1] as (prev: object) => {
      editable: () => boolean;
      keep?: number;
    };
    // Existing view options are spread through, editable is layered on top.
    const next = updater({ keep: 7 });
    expect(next.keep).toBe(7);
    expect(next.editable()).toBe(true);
    readOnly = true;
    expect(next.editable()).toBe(false);
  });

  it("forwards a genuine change retightened against the live source", () => {
    const { ctx, manager } = makeFakeCtx();
    const handlers = baseHandlers();

    configureRichEditorCtx(document.createElement("div"), handlers)(ctx);
    const onMarkdown = manager.markdownUpdated.mock.calls[0]![0];

    // Milkdown loosened the tight source list; the forwarded value is re-tightened.
    onMarkdown(null, "* a\n\n* b\n", "# old\n");
    expect(handlers.onChange.mock.calls).toEqual([["* a\n* b\n"]]);
  });

  it("strips Milkdown's empty-table-cell <br /> from a forwarded change", () => {
    const { ctx, manager } = makeFakeCtx();
    const handlers = { ...baseHandlers(), getSource: () => "" };

    configureRichEditorCtx(document.createElement("div"), handlers)(ctx);
    const onMarkdown = manager.markdownUpdated.mock.calls[0]![0];

    onMarkdown(null, "| a |\n| --- |\n| <br /> |\n", "# old\n");
    expect(handlers.onChange.mock.calls).toEqual([["| a |\n| --- |\n| |\n"]]);
  });

  it("suppresses the no-op echo where markdown equals prevMarkdown", () => {
    const { ctx, manager } = makeFakeCtx();
    const handlers = baseHandlers();

    configureRichEditorCtx(document.createElement("div"), handlers)(ctx);
    const onMarkdown = manager.markdownUpdated.mock.calls[0]![0];

    onMarkdown(null, "same\n", "same\n");
    expect(handlers.onChange).not.toHaveBeenCalled();
  });

  it("signals mount through onReady exactly once per mounted callback", () => {
    const { ctx, manager } = makeFakeCtx();
    const onReady = vi.fn();

    configureRichEditorCtx(document.createElement("div"), { ...baseHandlers(), onReady })(ctx);

    expect(manager.mounted).toHaveBeenCalledTimes(1);
    const onMounted = manager.mounted.mock.calls[0]![0];
    onMounted();
    expect(onReady.mock.calls).toEqual([[]]);
  });

  it("registers no mount listener when the caller passed no onReady", () => {
    const { ctx, manager } = makeFakeCtx();

    configureRichEditorCtx(document.createElement("div"), baseHandlers())(ctx);

    expect(manager.mounted).not.toHaveBeenCalled();
  });
});
