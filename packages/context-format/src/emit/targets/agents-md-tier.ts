/**
 * Shared builder for the "AGENTS.md tier" targets: Codex, Copilot, and
 * Factory emit root/nested `AGENTS.md` only — every other *emittable* kind
 * present in source gets one warning per kind. Factory droids and Codex's
 * TOML mcp are left unimplemented rather than half-implemented.
 *
 * "Emittable" deliberately excludes `reference` and `subagent`: neither is
 * emitted by ANY target, so warning about them here would misrepresent a
 * universal gap as a target-specific limitation.
 */
import type { FieldIssue } from '../../kinds';
import { joinPath } from '../../path-utils';
import { withHeader } from '../header';
import { contentForEntry } from '../shared';
import type { EmitFile, EmitInput, TargetBuildResult, TargetId } from '../types';

const WARNABLE_KINDS = ['skill', 'command', 'mcp'] as const;

export function buildAgentsMdTier(targetId: TargetId, input: EmitInput): TargetBuildResult {
  const files: EmitFile[] = [];
  const warnings: FieldIssue[] = [];

  for (const entry of input.entries) {
    if (entry.kind !== 'instructions') continue;
    const content = contentForEntry(input.contents, entry, warnings);
    if (content === undefined) continue;
    files.push({ path: joinPath(entry.scopePath, 'AGENTS.md'), content: withHeader(entry.path, content) });
  }

  const presentKinds = new Set(input.entries.map((e) => (e.kind === 'skill-reference' ? 'skill' : e.kind)));
  for (const kind of WARNABLE_KINDS) {
    if (!presentKinds.has(kind)) continue;
    warnings.push({
      path: `${targetId}:${kind}`,
      code: 'unsupported_on_target',
      message: `"${kind}" content is not emitted for ${targetId} (AGENTS.md-only tier in v1)`,
    });
  }

  return { files, copies: [], warnings };
}
