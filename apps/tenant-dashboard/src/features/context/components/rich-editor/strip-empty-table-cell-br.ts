import { computeFenceMask } from "./retighten-lists";

/**
 * `@milkdown/preset-commonmark`'s paragraph serializer inserts a literal
 * `<br />` HTML node for any empty paragraph that isn't the document's last
 * node, so a blank line round-trips instead of silently vanishing
 * (`remarkPreserveEmptyLinePlugin`, bundled unconditionally into the preset).
 * A GFM table cell's content model is a single paragraph, so an empty cell
 * gets the SAME treatment: `| <br /> |` instead of an empty `|  |`. There is
 * no public Milkdown config to disable this selectively for table cells
 * without disabling empty-line preservation for the WHOLE document (a much
 * bigger behavior change, and not what this fixes) — so this strips just the
 * table-cell case back out of Milkdown's serialized markdown, mirroring how
 * `retightenLists` already reverses another commonmark-preset artifact in
 * this same onChange path.
 *
 * Scoped to table rows (`inFence`-aware, like `retightenLists`) so a literal
 * `<br />` a user typed in ordinary prose is left untouched — only a cell
 * whose ENTIRE trimmed content is exactly a `<br>`/`<br/>`/`<br />` variant
 * counts, which is exactly Milkdown's empty-paragraph output, never
 * hand-authored table content.
 */
export function stripEmptyTableCellBr(markdown: string): string {
  const lines = markdown.split("\n");
  const inFence = computeFenceMask(lines);
  return lines.map((line, i) => (inFence[i] || !isTableRow(line) ? line : stripBrCells(line))).join("\n");
}

/** A GFM table row: a fenced-out line starting and ending with `|` (the delimiter row included). */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|");
}

const EMPTY_CELL_BR = /^<br\s*\/?>$/i;

function stripBrCells(line: string): string {
  // `| a | b |`.split("|") → ["", " a ", " b ", ""] — the boundary pipes
  // contribute empty strings, so only the inner cells need checking.
  const cells = line.split("|");
  return cells.map((cell) => (EMPTY_CELL_BR.test(cell.trim()) ? " " : cell)).join("|");
}
