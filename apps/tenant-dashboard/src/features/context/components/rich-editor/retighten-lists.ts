/**
 * Milkdown (through remark-stringify) rewrites every *tight* CommonMark list as
 * a *loose* one on the first round-trip: it inserts a blank line between sibling
 * list items and around nested sub-lists. The O-2 spike confirmed this is
 * cosmetic and byte-stable (it converges on the second pass), but it turns a
 * zero-character human edit into a large git-style diff — a real product problem
 * for a context tab that surfaces diffs.
 *
 * `retightenLists` reverses that loosening in the onChange path. It removes the
 * blank lines that sit *between* adjacent list-item lines, but only when the
 * pre-edit `source` document's lists were tight. If the source was genuinely
 * loose (the author deliberately spaced their items), the serialized output is
 * returned untouched — we never fabricate a tightness the author did not have.
 *
 * The tightness decision is made at document granularity: if `source` contains
 * any loose list at all, list layout is treated as ambiguous and Milkdown's
 * output is preferred verbatim (stability over aesthetics). This
 * deliberately does not attempt per-list source-to-output mapping — edits move
 * lines around, so a reliable mapping is not possible without a full AST diff.
 * The conservative document-level rule prefers Milkdown's output whenever the
 * source is ambiguous.
 *
 * Marker-style normalization (`-` → `*`) and other Milkdown reformatting are NOT
 * reverted; only the gratuitous blank lines between items are collapsed.
 */
export function retightenLists(markdown: string, source: string): string {
  // Ambiguous when the author's own lists were loose → keep Milkdown's output.
  if (hasLooseList(source)) return markdown;

  const lines = markdown.split("\n");
  const inFence = computeFenceMask(lines);

  // Fenced blanks need no explicit skip: their nearest non-blank neighbours are
  // fence-masked lines, which `isListItem` already rejects.
  const dropped = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i] ?? "")) continue;
    if (isBlankBetweenListItems(lines, inFence, i)) dropped[i] = true;
  }

  // A trailing newline round-trips on its own: `split`/`join` on "\n" carries it
  // as a final "" line, and the final line is never dropped (nothing below it).
  return lines.filter((_, i) => !dropped[i]).join("\n");
}

/** True when a blank line's nearest non-blank neighbours are both list items. */
function isBlankBetweenListItems(
  lines: readonly string[],
  inFence: readonly boolean[],
  index: number,
): boolean {
  const above = nearestNonBlank(lines, index, -1);
  const below = nearestNonBlank(lines, index, 1);
  if (above === -1 || below === -1) return false;
  return (
    isListItem(lines[above] ?? "", inFence[above] ?? false) &&
    isListItem(lines[below] ?? "", inFence[below] ?? false)
  );
}

function nearestNonBlank(lines: readonly string[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < lines.length; i += step) {
    if (!isBlank(lines[i] ?? "")) return i;
  }
  return -1;
}

/** A document has a loose list if any blank line sits between two list items. */
function hasLooseList(markdown: string): boolean {
  const lines = markdown.split("\n");
  const inFence = computeFenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i] || !isBlank(lines[i] ?? "")) continue;
    if (isBlankBetweenListItems(lines, inFence, i)) return true;
  }
  return false;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * A list-item line: optional indent, then a bullet (`-`, `*`, `+`) or an ordered
 * marker (`1.`, `1)`), then whitespace or end of line. Lines inside a fenced code
 * block never count, so markdown examples embedded in code are left alone.
 */
function isListItem(line: string, insideFence: boolean): boolean {
  if (insideFence) return false;
  return /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/.test(line);
}

/** Per-line mask marking which lines fall inside a ``` or ~~~ fenced code block. */
export function computeFenceMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let openFence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = (lines[i] ?? "").match(/^\s*(`{3,}|~{3,})/);
    const marker = fence?.[1]?.[0] ?? null; // "`" or "~"
    if (openFence === null) {
      if (marker) {
        openFence = marker;
        mask[i] = true; // the opening fence line is part of the block
      }
    } else {
      mask[i] = true; // inside the block (and the closing fence line itself)
      if (marker === openFence) openFence = null;
    }
  }
  return mask;
}
