import type { Editor } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";

/**
 * Apply the markdown parse/serialize presets that define the editor's round-trip
 * behavior: CommonMark for the base grammar, GFM for tables/task-lists/
 * strikethrough. Shared by the live component and the round-trip test harness so
 * the regression pins in the tests cover exactly the syntax surface the component
 * ships.
 *
 * The presets are applied as separate chained `.use()` calls (not a single
 * `.use([commonmark, gfm])`): Milkdown's plugin-store flattening reorders a
 * nested-array `.use` in a way that loads node composables before their schema
 * context is injected, which throws at `create()`.
 */
export function applyMarkdownPresets(editor: Editor): Editor {
  return editor.use(commonmark).use(gfm);
}
