import { Editor, defaultValueCtx, editorViewOptionsCtx, rootCtx } from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { applyMarkdownPresets } from "./presets";
import { retightenLists } from "./retighten-lists";
import { stripEmptyTableCellBr } from "./strip-empty-table-cell-br";

interface RichEditorHandlers {
  /** Initial markdown body; read once into `defaultValueCtx` at editor creation. */
  getValue: () => string;
  /**
   * The pre-edit markdown used to decide list tightness for `retightenLists`.
   * Kept as a getter so the caller can point it at the live source ref.
   */
  getSource: () => string;
  /** Read on every ProseMirror state application to gate user editing. */
  isReadOnly: () => boolean;
  /**
   * Fired with the retightened markdown whenever the document changes. Coalesced
   * by plugin-listener's internal debounce, so it does not fire per keystroke and
   * does NOT fire for the initial load (only genuine edits).
   */
  onChange: (markdown: string) => void;
  /** Fired once when the editor view has mounted. */
  onReady?: () => void;
}

/**
 * The `.config()` body applied at `editor.create()`: root/value/editable wiring
 * plus the listener manager's change forwarding — retightened (see
 * retighten-lists.ts) and stripped of the commonmark preset's empty-table-cell
 * `<br />` artifact (see strip-empty-table-cell-br.ts) — and mount signal.
 * Exported so the wiring is unit-testable against a fake `Ctx` — a real
 * Milkdown editor cannot be created in-process under Vitest (the roundtrip
 * spec drives one in a subprocess instead).
 */
export function configureRichEditorCtx(
  root: HTMLElement,
  handlers: RichEditorHandlers,
): (ctx: Ctx) => void {
  return (ctx) => {
    ctx.set(rootCtx, root);
    ctx.set(defaultValueCtx, handlers.getValue());
    ctx.update(editorViewOptionsCtx, (prev) => ({
      ...prev,
      editable: () => !handlers.isReadOnly(),
    }));

    const manager = ctx.get(listenerCtx);
    manager.markdownUpdated((_ctx, markdown, prevMarkdown) => {
      if (markdown === prevMarkdown) return;
      handlers.onChange(stripEmptyTableCellBr(retightenLists(markdown, handlers.getSource())));
    });
    if (handlers.onReady) {
      manager.mounted(() => handlers.onReady?.());
    }
  };
}

/**
 * Builds the configured (but not yet created) Milkdown editor for a given root
 * element. Shared by the React component and the headless test harness so both
 * exercise the identical plugin stack and change-forwarding logic.
 */
export function configureRichEditor(root: HTMLElement, handlers: RichEditorHandlers): Editor {
  const editor = Editor.make().config(configureRichEditorCtx(root, handlers));

  // `history` backs the toolbar's undo/redo (and Mod-z/Mod-y via its keymap).
  return applyMarkdownPresets(editor).use(listener).use(history);
}
