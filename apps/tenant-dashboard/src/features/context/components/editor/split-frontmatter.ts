/**
 * Splits a context file's raw bytes into its leading YAML frontmatter block
 * (delimiters included) and the markdown body. The rich editor edits the BODY
 * ONLY (its frozen contract) — frontmatter never enters Milkdown — so at the
 * raw⇄rich boundary we peel the frontmatter off, hand the body to the rich
 * surface, and re-attach the untouched frontmatter to whatever comes back.
 *
 * Byte-exact and lossless: `join(...split(raw)) === raw` for every input, and a
 * file with no frontmatter yields `frontmatter: ""` so an AGENTS.md can never
 * acquire one through the rich path. The frontmatter chunk keeps its
 * trailing newline so re-joining preserves the exact byte boundary.
 */
interface SplitMarkdown {
  /** The `---\n…\n---\n` block including delimiters and trailing newline, or `""` when absent. */
  frontmatter: string;
  /** Everything after the frontmatter block (the whole file when there is none). */
  body: string;
}

const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/;

export function splitFrontmatter(raw: string): SplitMarkdown {
  const block = FRONTMATTER_RE.exec(raw)?.[1];
  if (block === undefined) return { frontmatter: "", body: raw };
  return { frontmatter: block, body: raw.slice(block.length) };
}

export function joinFrontmatter(frontmatter: string, body: string): string {
  return frontmatter + body;
}

/**
 * Milkdown always serializes a single trailing newline, but the loaded file may
 * not have ended with one. Match the rich-serialized body's final newline to the
 * loaded body so a no-op rich round-trip of a newline-less file doesn't read as a
 * phantom edit (a permanent +1/−1). Only the final newline is added/stripped;
 * genuine interior changes still surface as edits.
 */
export function conformTrailingNewline(body: string, loadedBody: string): string {
  const loadedEndsWithNewline = loadedBody.endsWith("\n");
  const bodyEndsWithNewline = body.endsWith("\n");
  if (loadedEndsWithNewline === bodyEndsWithNewline) return body;
  return loadedEndsWithNewline ? `${body}\n` : body.replace(/\n$/, "");
}
