/**
 * Pure builder that turns a `ContextTreeResponse` into the literal file tree
 * the UI renders. The web tree, the IDE, and the PR diff must show the SAME
 * structure, so this reconstructs actual directories and filenames from the
 * mirrored paths and layers annotations ONLY (kind icons, missing-SKILL.md /
 * shadowed badges, the muted "N other files in git" line). No re-grouping,
 * no renaming.
 *
 * Kept pure and separate from the component so the exact node order + badge
 * placement is asserted directly, without a DOM.
 */
import { classifyTree, type ContextKind } from "@repo/context-core";
import type { ContextExcludedCount, ContextTreeResponse, ContextTreeEntry } from "../types";
import type { ContextDraftChangeType } from "./use-context-drafts";

const OUTERLAYER_DIR = ".outerlayer";

interface TreeBadge {
  type: "missing-skill-md" | "shadowed" | "misplaced" | "dirty" | "new" | "deleted" | "pending-pr";
  detail: string;
}

interface TreeFileNode {
  type: "file";
  /** Full repo-relative path — stable React key + the `?file=` selection value. */
  path: string;
  name: string;
  kind: ContextKind;
  badges: TreeBadge[];
  /** Server count for an `mcp.json` node — drives the muted "· N servers" suffix. */
  mcpServerCount?: number;
  /** Installed server names for an `mcp.json` node. */
  mcpServers?: string[];
}

interface TreeDirNode {
  type: "dir";
  path: string;
  name: string;
  badges: TreeBadge[];
  /** Count of git files under a skill dir excluded from the mirror (assets/scripts);
   *  the view renders the muted "N other files in git" line. `null` when none. */
  excludedCount: number | null;
  children: TreeNode[];
}

export type TreeNode = TreeFileNode | TreeDirNode;

interface TreeScopeSection {
  /** Scope repo path shown as the section header — `root` for the repo root. */
  scopeLabel: string;
  /** The `.outerlayer` dir's real repo path — the wrapper dir row rendered under the header. */
  scopeDir: string;
  children: TreeNode[];
}

export interface ContextTreeModel {
  scopes: TreeScopeSection[];
}

/** The `.outerlayer` dir path governing a scope (`''` = repo root). */
function scopeDirFor(scopePath: string): string {
  return scopePath === "" ? OUTERLAYER_DIR : `${scopePath}/${OUTERLAYER_DIR}`;
}

/** Folders before files, each alphabetical — the conventional IDE tree order. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * One scope's subtree builder — indexes dir nodes by full path so badges and
 * excluded-file notes can attach to a skill directory even when the directory
 * itself owns no content entry (assets-only skill dir, or a skill missing its
 * SKILL.md).
 */
class ScopeBuilder {
  readonly roots: TreeNode[] = [];
  private readonly dirs = new Map<string, TreeDirNode>();

  constructor(private readonly scopeDir: string) {}

  private ensureDir(path: string): TreeDirNode {
    const existing = this.dirs.get(path);
    if (existing) return existing;

    const name = path.slice(path.lastIndexOf("/") + 1);
    const node: TreeDirNode = { type: "dir", path, name, badges: [], excludedCount: null, children: [] };
    this.dirs.set(path, node);

    const parentPath = path.slice(0, path.lastIndexOf("/"));
    if (parentPath === this.scopeDir) {
      this.roots.push(node);
    } else {
      this.ensureDir(parentPath).children.push(node);
    }
    return node;
  }

  addFile(
    entry: ContextTreeEntry,
    badges: TreeBadge[],
    mcp?: { count: number; servers: string[] },
  ): void {
    const rel = entry.path.slice(this.scopeDir.length + 1);
    const segs = rel.split("/");
    const name = segs[segs.length - 1]!;
    const file: TreeFileNode = {
      type: "file",
      path: entry.path,
      name,
      kind: entry.kind,
      badges,
      ...(mcp !== undefined
        ? { mcpServerCount: mcp.count, mcpServers: mcp.servers }
        : {}),
    };

    if (segs.length === 1) {
      this.roots.push(file);
      return;
    }
    const dirPath = `${this.scopeDir}/${segs.slice(0, -1).join("/")}`;
    this.ensureDir(dirPath).children.push(file);
  }

  /** Attach a badge and/or excluded-file count to a directory node, creating the dir if no entry produced it. */
  annotateDir(dirPath: string, badge: TreeBadge | null, excludedCount: number | null): void {
    const dir = this.ensureDir(dirPath);
    if (badge) dir.badges.push(badge);
    if (excludedCount !== null) dir.excludedCount = excludedCount;
  }

  sorted(): TreeNode[] {
    const sortRec = (nodes: TreeNode[]): TreeNode[] => {
      for (const n of nodes) if (n.type === "dir") n.children = sortRec(n.children);
      return [...nodes].sort(compareNodes);
    };
    return sortRec(this.roots);
  }
}

export function buildContextTreeModel(
  response: ContextTreeResponse,
  draftChangeTypes?: ReadonlyMap<string, ContextDraftChangeType>,
  pendingPrPaths?: ReadonlySet<string>,
): ContextTreeModel {
  const { issues, excludedCounts, mcpServerCounts } = response;

  // Merge paths that aren't on the server yet — `create` drafts and files
  // submitted as a still-open PR — into the tree so both stay selectable
  // before/until they land. Classified the same way the server would, and
  // carried with a `new` (create) or muted `pending-pr` badge below.
  const entries = mergeSyntheticEntries(response.entries, draftChangeTypes, pendingPrPaths);

  const mcpByPath = new Map(
    mcpServerCounts.map((m) => [m.path, { count: m.count, servers: m.servers }]),
  );
  const shadowedByPath = new Map<string, string>();
  const misplacedByPath = new Map<string, string>();
  const missingSkillByDir = new Map<string, string>();
  for (const issue of issues) {
    if (issue.type === "shadowed") {
      shadowedByPath.set(issue.path, issue.detail);
    } else if (issue.type === "misplaced") {
      // issue.path is the offending file itself (a nested subagent, or a
      // command with an unnameable namespace); the badge sits on that row.
      misplacedByPath.set(issue.path, issue.detail);
    } else {
      // issue.path is the expected `<scopeDir>/skills/<name>/SKILL.md`; the
      // badge belongs on that skill's directory.
      missingSkillByDir.set(issue.path.slice(0, issue.path.lastIndexOf("/")), issue.detail);
    }
  }

  // Deterministic scope order: root first, then lexicographic by scope path.
  const scopePaths = [...new Set(entries.map((e) => e.scopePath))].sort((a, b) => {
    if (a === b) return 0;
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  const scopes: TreeScopeSection[] = scopePaths.map((scopePath) => {
    const scopeDir = scopeDirFor(scopePath);
    const builder = new ScopeBuilder(scopeDir);

    for (const entry of entries) {
      if (entry.scopePath !== scopePath) continue;
      if (entry.kind === "folder") {
        // A `.gitkeep` folder-keeper anchors an otherwise-empty directory in
        // the tree but is never a selectable file row itself — materialize its
        // parent directory only, so the empty folder stays visible. An unpublished
        // (create-draft) keeper marks its directory `new` so the folder reads as
        // unsaved even with no file inside it yet.
        const rel = entry.path.slice(scopeDir.length + 1);
        const segs = rel.split("/");
        if (segs.length >= 2) {
          const dirPath = `${scopeDir}/${segs.slice(0, -1).join("/")}`;
          const draftType = draftChangeTypes?.get(entry.path);
          // A staged delete of a folder's own `.gitkeep` (a published empty
          // folder marked for removal) reads the dir as deleted, the same as a
          // create keeper reads it as new.
          const badge: TreeBadge | null =
            draftType === "create"
              ? { type: "new", detail: "New folder" }
              : draftType === "delete"
                ? { type: "deleted", detail: "Marked for deletion" }
                : null;
          builder.annotateDir(dirPath, badge, null);
        }
        continue;
      }
      const badges: TreeBadge[] = [];
      const shadow = shadowedByPath.get(entry.path);
      if (shadow) badges.push({ type: "shadowed", detail: shadow });
      const misplaced = misplacedByPath.get(entry.path);
      if (misplaced) badges.push({ type: "misplaced", detail: misplaced });
      const draftType = draftChangeTypes?.get(entry.path);
      if (draftType === "edit") {
        badges.push({ type: "dirty", detail: "Unsaved changes" });
      } else if (draftType === "create") {
        badges.push({ type: "new", detail: "New file" });
      } else if (draftType === "delete") {
        badges.push({ type: "deleted", detail: "Marked for deletion" });
      } else if (pendingPrPaths?.has(entry.path)) {
        badges.push({ type: "pending-pr", detail: "Submitted as a pull request" });
      }
      builder.addFile(entry, badges, mcpByPath.get(entry.path));
    }

    // Skill-dir annotations for this scope (badge + excluded-file note).
    for (const [dirPath, detail] of missingSkillByDir) {
      if (dirPath.startsWith(`${scopeDir}/skills/`)) {
        builder.annotateDir(dirPath, { type: "missing-skill-md", detail }, null);
      }
    }
    for (const ec of scopedExcludedCounts(excludedCounts, scopePath)) {
      builder.annotateDir(`${scopeDir}/skills/${ec.skillName}`, null, ec.count);
    }

    return { scopeLabel: scopePath === "" ? "root" : scopePath, scopeDir, children: builder.sorted() };
  });

  return { scopes };
}

function scopedExcludedCounts(
  counts: ContextExcludedCount[],
  scopePath: string,
): ContextExcludedCount[] {
  return counts.filter((c) => c.scopePath === scopePath);
}

/**
 * Appends synthetic entries for paths not yet on the server — `create` drafts
 * and files submitted as a still-open PR — classifying each the way the server
 * tree would (kind + scope + skill). Existing paths are left untouched (a draft
 * on a mirrored path is an edit, badged separately). Synthetic entries carry an
 * empty `blobSha` (nothing committed to the mirror yet).
 */
function mergeSyntheticEntries(
  entries: ContextTreeEntry[],
  draftChangeTypes?: ReadonlyMap<string, ContextDraftChangeType>,
  pendingPrPaths?: ReadonlySet<string>,
): ContextTreeEntry[] {
  const known = new Set(entries.map((e) => e.path));
  const extraPaths = new Set<string>();
  if (draftChangeTypes) {
    for (const [path, type] of draftChangeTypes) {
      if (type === "create" && !known.has(path)) extraPaths.add(path);
    }
  }
  if (pendingPrPaths) {
    for (const path of pendingPrPaths) {
      if (!known.has(path)) extraPaths.add(path);
    }
  }
  if (extraPaths.size === 0) return entries;

  const synthetic: ContextTreeEntry[] = classifyTree([...extraPaths]).entries.map((e) => ({
    path: e.path,
    kind: e.kind,
    scopePath: e.scopePath,
    ...(e.skillName !== undefined ? { skillName: e.skillName } : {}),
    blobSha: "",
  }));
  return [...entries, ...synthetic];
}
