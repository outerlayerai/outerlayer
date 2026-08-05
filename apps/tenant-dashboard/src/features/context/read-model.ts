/**
 * Pure derivation for the context read path — no Supabase, no fetch. The service
 * does the RLS-scoped queries and hands raw rows here; keeping the transform
 * pure makes the interesting logic (classification annotations, frontmatter
 * parsing, oversize handling) exact-assertable without faking a chainable query
 * builder.
 *
 * Classification is re-derived from the mirrored paths via `@repo/context-core`
 * rather than trusting the stored `kind` column: the classifier is the single
 * source of truth for kind + shadowing + missing-SKILL.md, and re-running it is
 * idempotent (the stored kinds are already its output). The classifier CANNOT
 * produce `excludedCounts` here — the asset/script paths that feed it are not
 * mirrored — so the caller passes the counts stored on the snapshot at sync
 * time (computed there from the full git tree); an absent list means none.
 */
import {
  classifyTree,
  parseContextFile,
  validateFrontmatter,
  validateMcpConfig,
  type ContextKind,
} from "@repo/context-core";
import type {
  ContextExcludedCount,
  ContextFileResponse,
  ContextGitConnection,
  ContextHead,
  ContextTreeEntry,
  ContextTreeResponse,
} from "./types";

/** A mirrored tree row as read from `context_tree_entry` (path + blob only — kind is re-derived). */
export interface RawTreeRow {
  path: string;
  blobSha: string;
}

interface DeriveTreeInput {
  gitConnection: ContextGitConnection | null;
  head: ContextHead | null;
  rows: RawTreeRow[];
  /** `mcp.json` path → raw JSON, for the tree's per-file server count. Absent paths get no count. */
  mcpContents?: Map<string, string>;
  /** Per-skill excluded-file counts, read from the snapshot (see file header). Defaults to empty. */
  excludedCounts?: ContextExcludedCount[];
  /** App publish policy — publishing opens a pull request; the dialog states it. Defaults to false. */
  requirePullRequest?: boolean;
}

/** Lists `mcpServers` names in an mcp.json document; malformed JSON lists none (still displayable). */
function listMcpServers(content: string): string[] {
  try {
    const obj = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
    return obj.mcpServers && typeof obj.mcpServers === "object" ? Object.keys(obj.mcpServers) : [];
  } catch {
    return [];
  }
}

/** Builds the tree response: partitions external/internal entries, layers derived issues + excluded counts. */
export function deriveTreeResponse(input: DeriveTreeInput): ContextTreeResponse {
  const { gitConnection, head, rows, mcpContents, excludedCounts, requirePullRequest } = input;
  const blobByPath = new Map(rows.map((r) => [r.path, r.blobSha]));
  const classified = classifyTree(rows.map((r) => r.path));

  const toEntry = (e: {
    path: string;
    kind: ContextKind;
    scopePath: string;
    skillName?: string;
  }): ContextTreeEntry => ({
    path: e.path,
    kind: e.kind,
    scopePath: e.scopePath,
    ...(e.skillName !== undefined ? { skillName: e.skillName } : {}),
    blobSha: blobByPath.get(e.path) ?? "",
  });

  // Root instruction files OUTSIDE `.outerlayer/` (`external-instructions`)
  // are dropped — the Context tab shows managed context only, not files
  // discovered elsewhere in the repo.
  const entries = classified.entries
    .filter((e) => e.kind !== "external-instructions")
    .map(toEntry);

  const mcpServerCounts = entries
    .filter((e) => e.kind === "mcp" && mcpContents?.has(e.path))
    .map((e) => {
      const servers = listMcpServers(mcpContents!.get(e.path)!);
      // Server names double as the installed list for the adoption overlay —
      // they are config keys, not secrets, so exposing them is safe.
      return { path: e.path, count: servers.length, servers };
    });

  return {
    gitConnection,
    head,
    entries,
    excludedCounts: excludedCounts ?? [],
    issues: classified.issues,
    mcpServerCounts,
    requirePullRequest: requirePullRequest ?? false,
  };
}

interface DeriveFileInput {
  path: string;
  /** Stored kind from `context_tree_entry` — trusted here (single-path re-classification can't see skill siblings). */
  kind: ContextKind;
  blobSha: string;
  commitSha: string;
  /** `null` when the blob is oversize and not mirrored. */
  content: string | null;
}

/** Last `/`-separated segment of a repo-relative path. */
function basename(path: string): string {
  const segs = path.split("/");
  return segs[segs.length - 1] ?? "";
}

/** The skill dir name for a `.../skills/<name>/...` path — used to check `name === dir`. */
function skillDirName(path: string): string | undefined {
  const segs = path.split("/");
  const idx = segs.lastIndexOf("skills");
  return idx >= 0 && idx + 1 < segs.length ? segs[idx + 1] : undefined;
}

/** Builds the file response: parses frontmatter and layers display-only validation notes. */
export function deriveFileResponse(input: DeriveFileInput): ContextFileResponse {
  const { path, kind, blobSha, commitSha, content } = input;
  const base = { path, kind, blobSha, commitSha, content, oversize: content === null };

  if (content === null) {
    return { ...base, frontmatter: { parsed: null, issues: [] } };
  }

  // mcp.json is JSON, not markdown+frontmatter: validate the whole document via
  // the MCP schema and surface its notes; the viewer renders the servers from
  // `content`, so there is no parsed frontmatter mapping to return.
  if (kind === "mcp") {
    const result = validateMcpConfig(content);
    return {
      ...base,
      frontmatter: { parsed: null, issues: [...result.errors, ...result.warnings] },
    };
  }

  const parsed = parseContextFile(content);
  const ctx =
    kind === "skill"
      ? { dirName: skillDirName(path) }
      : kind === "subagent"
        ? { fileStem: basename(path).replace(/\.md$/, "") }
        : {};
  const validation = validateFrontmatter(kind, parsed, ctx);

  return {
    ...base,
    frontmatter: {
      parsed: parsed.frontmatter,
      issues: [...validation.errors, ...validation.warnings],
    },
  };
}
