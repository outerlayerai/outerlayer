/**
 * The two-tier publish gate: one source of truth, consumed by both the dashboard
 * publish dialog and the server save path, so they agree byte-for-byte on which
 * files block a commit and which publish with a warning.
 *
 * - HARD ERRORS block the commit: unparseable frontmatter YAML, invalid
 *   `mcp.json` (including literal secrets), and the structural frontmatter rules
 *   a file can't violate and still be meaningful (a forbidden frontmatter block,
 *   a name that doesn't match its directory/filename).
 * - WARNINGS publish as-is: fixable schema field issues (missing / empty /
 *   mis-formatted fields) on content that parsed, plus unknown-key notes. The
 *   author's intent was to publish; they fix the field later.
 */
import { parseContextFile, splitRawFile } from '@outerlayer/context-format';
import type { ContextKind, FieldIssue, ValidationResult } from '@outerlayer/context-format';
import { validateFrontmatter, type ValidateFrontmatterContext } from './frontmatter/schemas';
import { validateMcpConfig } from './mcp';

/**
 * Frontmatter issue codes that stay hard errors even when the content parses:
 * they break the file's identity or a forbidden-shape rule rather than being a
 * fixable field lint. Every other schema issue (a field's presence/format) is a
 * warning.
 */
const STRUCTURAL_FRONTMATTER_ERRORS: ReadonlySet<string> = new Set([
  'frontmatter_forbidden',
  'name_mismatch',
]);

/** Kinds whose frontmatter is schema-validated — a present-but-broken block is a syntax error. */
function hasFrontmatterSchema(kind: ContextKind): boolean {
  return (
    kind === 'skill' ||
    kind === 'command' ||
    kind === 'subagent' ||
    kind === 'reference' ||
    kind === 'skill-reference'
  );
}

/**
 * Split a file's validation into commit-blocking errors and publish-as-is
 * warnings. `ctx` carries the skill directory / subagent filename the frontmatter
 * `name` must match (an error tier when present and wrong).
 */
export function classifyPublishValidation(
  kind: ContextKind,
  content: string,
  ctx: ValidateFrontmatterContext = {},
): ValidationResult {
  // mcp.json already tiers correctly: invalid JSON and literal secrets are
  // errors, advisory notes are warnings.
  if (kind === 'mcp') {
    return validateMcpConfig(content);
  }

  const parsed = parseContextFile(content);

  // A frontmatter block that was present but did not parse to a mapping is a
  // YAML syntax error, not a fixable field lint. `parseContextFile` collapses
  // "absent" and "unparseable" both to `frontmatter: null`, so re-split to tell
  // them apart.
  if (hasFrontmatterSchema(kind)) {
    const { frontmatterInner } = splitRawFile(content);
    if (frontmatterInner !== null && parsed.frontmatter === null) {
      return {
        ok: false,
        errors: [
          {
            path: '(frontmatter)',
            code: 'frontmatter_unparseable',
            message: 'frontmatter is not valid YAML',
          },
        ],
        warnings: [],
      };
    }
  }

  const result = validateFrontmatter(kind, parsed, ctx);
  const errors: FieldIssue[] = [];
  const demoted: FieldIssue[] = [];
  for (const issue of result.errors) {
    (STRUCTURAL_FRONTMATTER_ERRORS.has(issue.code) ? errors : demoted).push(issue);
  }
  return { ok: errors.length === 0, errors, warnings: [...result.warnings, ...demoted] };
}
