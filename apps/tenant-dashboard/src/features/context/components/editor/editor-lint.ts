import type { Diagnostic } from "@codemirror/lint";
import { linter } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { classifyPublishValidation, type ContextKind, type FieldIssue } from "@repo/context-core";

export interface ContextLintContext {
  /** skill: containing directory name; subagent: filename stem. */
  dirName?: string;
  fileStem?: string;
}

/** Kinds edited as JSON (mcp.json) rather than markdown + frontmatter. */
function isJsonKind(kind: ContextKind): boolean {
  return kind === "mcp";
}

/**
 * Locates a span for a field issue so the squiggle lands on the offending
 * line rather than the whole document. Best-effort: find the field key at a
 * line start (frontmatter `key:`) or as a JSON member (`"key"`); fall back to
 * the first line. Never throws and always returns an in-bounds span.
 */
function spanForIssue(content: string, issue: FieldIssue, json: boolean): {
  from: number;
  to: number;
} {
  // `split` always yields at least one segment, and validator paths are
  // dot-joined non-empty segments — the `!`s assert that, they don't branch.
  const segments = issue.path.split(".");
  const key = json ? segments.pop()! : segments[0]!.replace(/[()]/g, "");

  if (key) {
    const pattern = json
      ? new RegExp(`"${escapeRegExp(key)}"`)
      : new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, "m");
    const match = pattern.exec(content);
    if (match) {
      const from = match.index;
      const lineEnd = content.indexOf("\n", from);
      return { from, to: lineEnd === -1 ? content.length : lineEnd };
    }
  }

  // Fallback: first line of the document.
  const firstLineEnd = content.indexOf("\n");
  return { from: 0, to: firstLineEnd === -1 ? content.length : firstLineEnd };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Runs the same two-tier classifier the save path enforces (server stays
 * authoritative) and maps each `FieldIssue` to a CodeMirror
 * diagnostic at the SAME severity the publish gate assigns: hard errors
 * (unparseable YAML, invalid mcp.json, structural rules) render as `error`;
 * fixable field lints (empty description, unknown keys) render as `warning`, so
 * the raw editor never shows red for something that publishes as an amber
 * warning. Pure: no CodeMirror runtime needed, so this is unit-tested directly.
 */
export function computeContextDiagnostics(
  kind: ContextKind,
  content: string,
  ctx: ContextLintContext = {},
): Diagnostic[] {
  const json = isJsonKind(kind);
  const result = classifyPublishValidation(kind, content, {
    dirName: ctx.dirName,
    fileStem: ctx.fileStem,
  });

  const namesField = (path: string) =>
    path !== "(root)" && path !== "(frontmatter)";

  const toDiagnostic = (
    issue: FieldIssue,
    severity: Diagnostic["severity"],
  ): Diagnostic => {
    // spanForIssue guarantees `0 <= from <= to <= content.length` (a key match
    // is inside the content and its line end never precedes it; the fallback
    // is the first line) — no clamping needed here.
    const { from, to } = spanForIssue(content, issue, json);
    return {
      from,
      to,
      severity,
      // Prefix the field name so the inline tooltip names what's wrong — the
      // raw schema message ("expected string, received undefined") doesn't.
      message: namesField(issue.path)
        ? `${issue.path}: ${issue.message}`
        : issue.message,
      source: issue.code,
    };
  };

  return [
    ...result.errors.map((issue) => toDiagnostic(issue, "error")),
    ...result.warnings.map((issue) => toDiagnostic(issue, "warning")),
  ];
}

/**
 * The lint callback `contextLinter` hands CodeMirror: reads the live document
 * out of the view and diagnoses it. Exported so the wiring is unit-testable
 * without constructing a real EditorView.
 */
export function lintSource(kind: ContextKind, ctx: ContextLintContext = {}) {
  return (view: EditorView) =>
    computeContextDiagnostics(kind, view.state.doc.toString(), ctx);
}

/**
 * CodeMirror `linter` extension bound to {@link computeContextDiagnostics}, so
 * schema/mcp violations render as inline squiggles as the user types.
 */
export function contextLinter(kind: ContextKind, ctx: ContextLintContext = {}) {
  return linter(lintSource(kind, ctx));
}
