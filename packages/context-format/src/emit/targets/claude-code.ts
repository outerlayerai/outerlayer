/**
 * Claude Code target — full tier: instructions → root/nested
 * `CLAUDE.md`; skills → `.claude/skills/<name>/`; commands →
 * `.claude/commands/<ns...>/<name>.md` (native Claude Code namespacing,
 * `/ns:name`); mcp → `.mcp.json` (`${VAR}` is native —
 * passthrough, no rewrite). `reference` and `subagent` are not emitted by
 * any target — silently skipped here, not warned.
 */
import { joinPath } from '../../path-utils';
import { withHeader } from '../header';
import { commandRelPath, contentForEntry, parseSkillAssetPath, skillReferenceRelPath } from '../shared';
import type { EmitCopy, EmitFile, EmitInput, TargetBuildResult } from '../types';
import type { FieldIssue } from '../../kinds';

export function buildClaudeCode(input: EmitInput): TargetBuildResult {
  const files: EmitFile[] = [];
  const copies: EmitCopy[] = [];
  const warnings: FieldIssue[] = [];

  for (const entry of input.entries) {
    switch (entry.kind) {
      case 'instructions': {
        const content = contentForEntry(input.contents, entry, warnings);
        if (content !== undefined) {
          files.push({ path: joinPath(entry.scopePath, 'CLAUDE.md'), content: withHeader(entry.path, content) });
        }
        break;
      }
      case 'skill': {
        const content = contentForEntry(input.contents, entry, warnings);
        if (content !== undefined) {
          files.push({
            path: joinPath(entry.scopePath, '.claude/skills', entry.skillName!, 'SKILL.md'),
            content: withHeader(entry.path, content),
          });
        }
        break;
      }
      case 'skill-reference': {
        const content = contentForEntry(input.contents, entry, warnings);
        if (content !== undefined) {
          files.push({
            path: joinPath(entry.scopePath, '.claude/skills', entry.skillName!, 'references', skillReferenceRelPath(entry)),
            content: withHeader(entry.path, content),
          });
        }
        break;
      }
      case 'command': {
        const content = contentForEntry(input.contents, entry, warnings);
        if (content !== undefined) {
          files.push({
            path: joinPath(entry.scopePath, '.claude/commands', commandRelPath(entry)),
            content: withHeader(entry.path, content),
          });
        }
        break;
      }
      case 'mcp': {
        const content = contentForEntry(input.contents, entry, warnings);
        if (content !== undefined) {
          // Native `${VAR}` syntax + tool-specific keys — verbatim passthrough, no header (JSON takes no comments).
          files.push({ path: joinPath(entry.scopePath, '.mcp.json'), content });
        }
        break;
      }
      default:
        break;
    }
  }

  for (const assetPath of input.assetPaths) {
    const parsed = parseSkillAssetPath(assetPath);
    if (!parsed) continue;
    copies.push({
      toPath: joinPath(parsed.scopePath, '.claude/skills', parsed.skillName, parsed.relPath),
      fromSourcePath: assetPath,
    });
  }

  return { files, copies, warnings };
}
