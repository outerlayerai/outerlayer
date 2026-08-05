import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandsCtx,
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/core";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { Selection, TextSelection } from "@milkdown/prose/state";
import { applyMarkdownPresets } from "../presets";
import { configureRichEditor } from "../create-rich-editor";
import { applyLink, readLinkContext, removeLinkAt } from "../link-command";
import { installJsdom } from "./jsdom-shim";

// When the harness runs from an esbuild bundle in a temp dir (see harness-entry),
// `import.meta.url` doesn't point beside the fixtures — the spec passes the
// real location through this env var.
const supportDir =
  process.env.RICH_HARNESS_SUPPORT_DIR ?? path.dirname(fileURLToPath(import.meta.url));

/** The five spike fixtures paired with the recorded Milkdown pass-1 outputs. */
export const ROUND_TRIP_FIXTURES = [
  { name: "a-agents", fixture: "a-agents.md", baseline: "a-agents.pass1.md" },
  { name: "b-skill", fixture: "b-skill.md", baseline: "b-skill.pass1.md" },
  { name: "c-edge-constructs", fixture: "c-edge-constructs.md", baseline: "c-edge-constructs.pass1.md" },
  {
    name: "c2-edge-constructs-crlf",
    fixture: "c2-edge-constructs-crlf.md",
    baseline: "c2-edge-constructs-crlf.pass1.md",
  },
  { name: "d-weird-valid", fixture: "d-weird-valid.md", baseline: "d-weird-valid.pass1.md" },
] as const;

export function readFixture(file: string): string {
  return fs.readFileSync(path.join(supportDir, "fixtures", file), "utf8");
}

export function readBaseline(file: string): string {
  return fs.readFileSync(path.join(supportDir, "baselines", file), "utf8");
}

function newRoot(): HTMLElement {
  const { document } = installJsdom();
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function serializeDoc(editor: Editor): string {
  return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
}

/**
 * Load markdown into a bare commonmark+gfm editor (the component's serialization
 * surface) and read it back out. Pins Milkdown's own round-trip, independent of
 * the retighten post-processor.
 */
export async function roundTripMarkdown(markdown: string): Promise<string> {
  const root = newRoot();
  const editor = await applyMarkdownPresets(
    Editor.make().config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    }),
  ).create();
  const out = serializeDoc(editor);
  await editor.destroy();
  root.remove();
  return out;
}

/**
 * Type `text` one character at a time at the very end of the document while the
 * live toolbar's selection listener is active — `readLinkContext` on every
 * `selectionUpdated`, with no error swallowing (exactly rich-editor-toolbar.tsx).
 * A per-keystroke throw is handled the way the live editor behaves: the aborted
 * transaction drops that character but the editor survives for the next one. So
 * the returned markdown is missing the typed text whenever the listener throws —
 * the regression signal for the doc-end boundary probe.
 */
export async function typeAtDocEndWithLinkProbe(value: string, text: string): Promise<string> {
  const root = newRoot();
  const editor = await applyMarkdownPresets(
    Editor.make().config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, value);
    }),
  )
    .use(listener)
    .create();

  editor.action((ctx) => {
    ctx.get(listenerCtx).selectionUpdated((selCtx, selection) => {
      readLinkContext(selCtx.get(editorViewCtx).state, selection);
    });
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
    for (const ch of text) {
      try {
        const live = ctx.get(editorViewCtx);
        live.dispatch(live.state.tr.insertText(ch, live.state.selection.from));
      } catch {
        // A throw inside the selection listener aborts the keystroke's dispatch;
        // the character is dropped and the editor survives, as in the live app.
      }
    }
  });

  const out = serializeDoc(editor);
  await editor.destroy();
  root.remove();
  return out;
}

interface MountedEditor {
  editor: Editor;
  /** Insert text at a document position and dispatch it as a real edit. */
  insertText: (text: string, pos: number) => void;
  /** Insert text at the end of the document body (inside the last block). */
  insertTextAtEnd: (text: string) => void;
  /** Select a document range so a mark command has a target. */
  setSelection: (from: number, to: number) => void;
  /** Run the production link apply (set / update / remove) over the current selection. */
  applyLink: (href: string) => void;
  /** Run the production link removal over the current selection. */
  removeLink: () => void;
  /** The current serialized markdown, straight from Milkdown (no retighten). */
  getMarkdown: () => string;
  /** ProseMirror's resolved editability (false when readOnly). */
  isEditable: () => boolean;
  destroy: () => Promise<void>;
}

/**
 * Mount an editor wired through the *production* `configureRichEditor` so tests
 * exercise the real listener + retighten + editable path, not a re-implementation.
 */
export async function mountConfiguredEditor(opts: {
  value: string;
  source?: string;
  readOnly?: boolean;
  onChange: (markdown: string) => void;
  onReady?: () => void;
}): Promise<MountedEditor> {
  const root = newRoot();
  const editor = await configureRichEditor(root, {
    getValue: () => opts.value,
    getSource: () => opts.source ?? opts.value,
    isReadOnly: () => opts.readOnly ?? false,
    onChange: opts.onChange,
    onReady: opts.onReady,
  }).create();

  return {
    editor,
    insertText: (text, pos) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.insertText(text, pos));
      }),
    insertTextAtEnd: (text) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pos = view.state.doc.content.size - 1;
        view.dispatch(view.state.tr.insertText(text, pos));
      }),
    setSelection: (from, to) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      }),
    applyLink: (href) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const commands = ctx.get(commandsCtx);
        applyLink(view, { call: (key, payload) => commands.call(key, payload) }, href);
      }),
    removeLink: () =>
      editor.action((ctx) => removeLinkAt(ctx.get(editorViewCtx))),
    getMarkdown: () => serializeDoc(editor),
    isEditable: () => editor.action((ctx) => ctx.get(editorViewCtx).editable ?? false),
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}
