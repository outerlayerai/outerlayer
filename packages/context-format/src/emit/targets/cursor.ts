/**
 * Cursor target — full tier: instructions → root/nested
 * `AGENTS.md`; skills → `.agents/skills/<name>/` (the tool-neutral dir
 * Cursor scans — future-proofs other adopters); commands →
 * `.cursor/commands/<name>.md`, body only (Cursor commands are documented
 * frontmatter-free — `description` moves into a leading comment,
 * `argument-hint` has no Cursor equivalent and is dropped — a frontmatter
 * field is carried only into targets that understand it); the command's
 * namespace subpath is preserved under `.cursor/commands/` — never flattened,
 * so distinct namespaces can't collide even where the consumer ignores the
 * subdir; mcp →
 * `.cursor/mcp.json` with `${VAR}` → `${env:VAR}` rewrite.
 */
import { parseContextFile } from '../../frontmatter/parse';
import type { FieldIssue } from '../../kinds';
import { joinPath } from '../../path-utils';
import { cursorEnvRefRewrite, rewriteEnvRefs } from '../env-refs';
import { withHeader } from '../header';
import { commandRelPath, contentForEntry, parseSkillAssetPath, skillReferenceRelPath } from '../shared';
import type { EmitCopy, EmitFile, EmitInput, TargetBuildResult } from '../types';

export function buildCursor(input: EmitInput): TargetBuildResult {
  const files: EmitFile[] = [];
  const copies: EmitCopy[] = [];
  const warnings: FieldIssue[] = [];

  for (const entry of input.entries) {
    switch (entry.kind) {
      case 'instructions': {
        const content = contentForEntry(input.contents, entry, warnings);
        if (content !== undefined) {
          files.push({ path: joinPath(entry.scopePath, 'AGENTS.md'), content: withHeader(entry.path, content) });
        }
        break;
      }
      case 'skill': {
        const content = contentForEntry(input.contents, entry, warnings);
        if (content !== undefined) {
          files.push({
            path: joinPath(entry.scopePath, '.agents/skills', entry.skillName!, 'SKILL.md'),
            content: withHeader(entry.path, content),
          });
        }
        break;
      }
      case 'skill-reference': {
        const content = contentForEntry(input.contents, entry, warnings);
        if (content !== undefined) {
          files.push({
            path: joinPath(entry.scopePath, '.agents/skills', entry.skillName!, 'references', skillReferenceRelPath(entry)),
            content: withHeader(entry.path, content),
          });
        }
        break;
      }
      case 'command': {
        const raw = contentForEntry(input.contents, entry, warnings);
        if (raw !== undefined) {
          const parsed = parseContextFile(raw);
          const description = typeof parsed.frontmatter?.description === 'string' ? parsed.frontmatter.description : '';
          files.push({
            path: joinPath(entry.scopePath, '.cursor/commands', commandRelPath(entry)),
            content: withHeader(entry.path, `<!-- ${description} -->\n${parsed.body}`),
          });
        }
        break;
      }
      case 'mcp': {
        const raw = contentForEntry(input.contents, entry, warnings);
        if (raw !== undefined) {
          const rewritten = rewriteMcpForCursor(raw, entry.path, warnings);
          if (rewritten !== undefined) {
            // No header on mcp outputs — JSON has no comment syntax.
            files.push({ path: joinPath(entry.scopePath, '.cursor/mcp.json'), content: rewritten });
          }
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
      toPath: joinPath(parsed.scopePath, '.agents/skills', parsed.skillName, parsed.relPath),
      fromSourcePath: assetPath,
    });
  }

  return { files, copies, warnings };
}

/** Rewrites `${VAR}`/`${VAR:-default}` occurrences in mcp `env`/`headers`/`url` values to Cursor's `${env:VAR}` syntax. */
function rewriteMcpForCursor(raw: string, entryPath: string, warnings: FieldIssue[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push({
      path: entryPath,
      code: 'invalid_mcp_json',
      message: `could not parse mcp.json for Cursor translation: ${err instanceof Error ? err.message : 'invalid JSON'}`,
    });
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnings.push({ path: entryPath, code: 'invalid_mcp_json', message: 'mcp.json must be a JSON object' });
    return undefined;
  }

  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (typeof mcpServers !== 'object' || mcpServers === null || Array.isArray(mcpServers)) {
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }

  for (const [name, serverRaw] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (typeof serverRaw !== 'object' || serverRaw === null || Array.isArray(serverRaw)) continue;
    const server = serverRaw as Record<string, unknown>;

    for (const field of ['env', 'headers'] as const) {
      const map = server[field];
      if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
      const mapObj = map as Record<string, unknown>;
      for (const [key, value] of Object.entries(mapObj)) {
        if (typeof value !== 'string') continue;
        const { value: rewritten, warnings: refWarnings } = rewriteEnvRefs(value, cursorEnvRefRewrite);
        mapObj[key] = rewritten;
        for (const w of refWarnings) {
          warnings.push({ path: `mcpServers.${name}.${field}.${key}`, code: 'env_ref_no_default', message: w });
        }
      }
    }

    if (typeof server.url === 'string') {
      const { value: rewritten, warnings: refWarnings } = rewriteEnvRefs(server.url, cursorEnvRefRewrite);
      server.url = rewritten;
      for (const w of refWarnings) {
        warnings.push({ path: `mcpServers.${name}.url`, code: 'env_ref_no_default', message: w });
      }
    }
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}
