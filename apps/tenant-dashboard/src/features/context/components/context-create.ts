/**
 * Shared authoring rules for the Context surface: where a "New file" / "New
 * folder" action lands given the directory it fires from, and one validator for
 * the names those actions accept. Kept pure and framework-free so both the
 * create popover and the tree's inline folder input enforce the SAME per-segment
 * slug rules, `..`/empty rejection, and case-insensitive duplicate detection.
 */

/** Lowercase alphanumeric, single hyphens — mirrors the classifier's segment rule. */
const SEGMENT_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Subagents are the strictest charset: lowercase letters and single hyphens, no digits. */
const SUBAGENT_SEGMENT_PATTERN = /^[a-z]+(-[a-z]+)*$/;

const V = "dashboard.context.create.validation";

// `pathExceedsLengthLimits` re-exported so this feature's own test keeps
// importing it from here — the shared `lib/path-limits` home is what lets
// the server save boundary reach the same check, a tier this file cannot be
// imported from.
export { pathExceedsLengthLimits } from "@/lib/path-limits";
import { SEGMENT_MAX_LEN, PATH_MAX_LEN } from "@/lib/path-limits";

/** The kinds a user can author from the UI. `document` is a plain markdown reference. */
export type CreatableKind = "command" | "skill" | "subagent" | "instructions" | "mcp" | "document";

/** `.outerlayer` dir governing a scope (`""` = repo root). */
export function scopeDirFor(scope: string): string {
  return scope === "" ? ".outerlayer" : `${scope}/.outerlayer`;
}

/**
 * Where a "New file" / "New folder" action lands, and what it creates, given the
 * directory row it fired from. `fileKind: null` means the full kind menu (only
 * at a scope's `.outerlayer` root); `actionsSuppressed` hides both actions (the
 * bare `skills/` dir, whose only affordance is the existing "new skill").
 */
interface CreateLocation {
  area: "root" | "commands" | "agents" | "skill" | "skills-root" | "generic";
  /** Preset kind a file action creates here, or null to open the full kind menu. */
  fileKind: CreatableKind | null;
  /** Directory new files land in — a skill dir routes files into its `references/`. */
  fileBaseDir: string;
  folderAllowed: boolean;
  /** Directory a new folder's `.gitkeep` lands under. */
  folderBaseDir: string;
  /** No row actions at all — the location's only create affordance is elsewhere. */
  actionsSuppressed: boolean;
}

/** Resolves the create rules for a directory path (`dir`) within a scope's `.outerlayer` (`scopeDir`). */
export function createLocationFor(dir: string, scopeDir: string): CreateLocation {
  const rel = dir === scopeDir ? [] : dir.slice(scopeDir.length + 1).split("/");

  if (rel.length === 0) {
    return { area: "root", fileKind: null, fileBaseDir: scopeDir, folderAllowed: true, folderBaseDir: scopeDir, actionsSuppressed: false };
  }
  if (rel[0] === "agents") {
    // Subagents are flat — a file lands directly in agents/, and folders are refused.
    const dirPath = `${scopeDir}/agents`;
    return { area: "agents", fileKind: "subagent", fileBaseDir: dirPath, folderAllowed: false, folderBaseDir: dirPath, actionsSuppressed: false };
  }
  if (rel[0] === "commands") {
    // A file/folder here nests under the command namespace this dir represents.
    return { area: "commands", fileKind: "command", fileBaseDir: dir, folderAllowed: true, folderBaseDir: dir, actionsSuppressed: false };
  }
  if (rel[0] === "skills") {
    if (rel.length === 1) {
      // A file action here creates a new skill (its fixed `skills/<name>/SKILL.md`
      // shape); a folder action stages `skills/<name>/.gitkeep` — a skill-shaped
      // dir without a SKILL.md yet, which the missing-SKILL.md warning then covers.
      return { area: "skills-root", fileKind: "skill", fileBaseDir: dir, folderAllowed: true, folderBaseDir: dir, actionsSuppressed: false };
    }
    // Inside a skill, authoring targets its references/ subtree.
    const inReferences = rel.length >= 3 && rel[2] === "references";
    const base = inReferences ? dir : `${scopeDir}/skills/${rel[1]}/references`;
    return { area: "skill", fileKind: "document", fileBaseDir: base, folderAllowed: true, folderBaseDir: base, actionsSuppressed: false };
  }
  return { area: "generic", fileKind: "document", fileBaseDir: dir, folderAllowed: true, folderBaseDir: dir, actionsSuppressed: false };
}

/** A directory's delete-row-action target, or `null` when the dir gets no delete affordance at all. */
export type DirDeleteAffordance = { kind: "skill"; skillDir: string } | { kind: "dir"; dirPath: string };

/**
 * Whether a directory row gets a "Delete folder" hover action, and which
 * confirmation copy it should use. The four bare scope dirs (`.outerlayer`
 * itself, `agents/`, `commands/`, `skills/`) get none — deleting a whole scope
 * isn't a folder-delete, it's disconnecting the repo. A skill's own root dir
 * (`skills/<name>`) reuses the skill-flavored copy (same as its SKILL.md's
 * overflow delete); everything else — nested command namespaces, a skill's
 * `references/` subtree, and ordinary folders — is a generic folder delete.
 */
export function dirDeleteAffordance(dir: string, scopeDir: string): DirDeleteAffordance | null {
  const rel = dir === scopeDir ? [] : dir.slice(scopeDir.length + 1).split("/");
  if (rel.length === 0) return null;
  if (rel[0] === "agents") return null;
  if (rel[0] === "commands" && rel.length === 1) return null;
  if (rel[0] === "skills") {
    if (rel.length === 1) return null;
    if (rel.length === 2) return { kind: "skill", skillDir: dir };
  }
  return { kind: "dir", dirPath: dir };
}

/** Full path a scope-and-kind create lands at (the global `+` menu — fixed shapes per kind). */
export function buildScopeKindPath(kind: CreatableKind, scope: string, name: string): string {
  const dir = scopeDirFor(scope);
  switch (kind) {
    case "skill":
      return `${dir}/skills/${name}/SKILL.md`;
    case "command":
      return `${dir}/commands/${name}.md`;
    case "subagent":
      return `${dir}/agents/${name}.md`;
    case "document":
      return `${dir}/${name}.md`;
    case "instructions":
      return `${dir}/AGENTS.md`;
    case "mcp":
      return `${dir}/mcp.json`;
  }
}

/** Full path a targeted (row-action) file create lands at — `<baseDir>/<name>.md`. */
export function buildTargetedFilePath(baseDir: string, name: string): string {
  return `${baseDir}/${name}.md`;
}

const GITKEEP_SUFFIX = "/.gitkeep";

/** The `.gitkeep` path that materializes a new folder `<baseDir>/<name>/`. */
export function buildFolderKeepPath(baseDir: string, name: string): string {
  return `${baseDir}/${name}${GITKEEP_SUFFIX}`;
}

/** A `.gitkeep` create staging an (otherwise empty) directory. */
function isFolderKeepPath(path: string): boolean {
  return path.endsWith(GITKEEP_SUFFIX);
}

/**
 * Folder `.gitkeep` draft paths whose directory already exists in the SERVER
 * tree — a content entry lives at or under it. This happens when a child file is
 * published first: the commit materializes the directory implicitly, leaving the
 * folder's staged `.gitkeep` redundant. Publishing it later would drop a stray
 * `.gitkeep` into a non-empty directory, so these drafts are reconciled away on
 * every tree revalidation. `treePaths` must be the server tree (not the
 * draft-merged model), or a folder draft's own synthetic entry would mask itself.
 */
export function staleFolderKeepDrafts(
  folderKeepPaths: Iterable<string>,
  treePaths: ReadonlySet<string>,
): string[] {
  const stale: string[] = [];
  for (const path of folderKeepPaths) {
    if (!isFolderKeepPath(path)) continue;
    const dir = path.slice(0, -GITKEEP_SUFFIX.length);
    const prefix = `${dir}/`;
    for (const entry of treePaths) {
      if (entry === dir || entry.startsWith(prefix)) {
        stale.push(path);
        break;
      }
    }
  }
  return stale;
}

/** Empty-content scaffold for a freshly created file of each named kind. */
export function buildScaffold(kind: CreatableKind, name: string): string {
  switch (kind) {
    case "skill":
    case "subagent":
      return `---\nname: ${name}\ndescription: \n---\n\n`;
    case "command":
      return `---\ndescription: \n---\n\n`;
    case "document":
    case "instructions":
      return "";
    case "mcp":
      return `{\n  "mcpServers": {}\n}\n`;
  }
}

interface NameRuleOptions {
  /** Subagent charset (no digits). */
  subagent?: boolean;
  /** Allow `/` to nest (commands + documents + folders); false for flat names (skills, subagents). */
  allowSlash?: boolean;
  /** Max total length (skills cap at 64). */
  maxLen?: number;
}

/**
 * Validates an authoring name against the per-segment slug rules, returning the
 * i18n key of the failure or null when valid. Rejects empty input, empty
 * segments, and `..`/illegal characters (they fail the slug pattern); a name
 * with `/` when nesting is not allowed fails too.
 */
export function nameError(name: string, opts: NameRuleOptions = {}): string | null {
  const { subagent = false, allowSlash = false, maxLen } = opts;
  if (name.length === 0) return `${V}.enterName`;
  if (maxLen !== undefined && name.length > maxLen) return `${V}.skillMax`;
  const slugKey = subagent ? `${V}.subagentSlug` : `${V}.slug`;
  if (!allowSlash && name.includes("/")) return slugKey;
  const pattern = subagent ? SUBAGENT_SEGMENT_PATTERN : SEGMENT_PATTERN;
  for (const seg of name.split("/")) {
    if (seg.length === 0) return `${V}.emptySegment`;
    if (seg.length > SEGMENT_MAX_LEN) return `${V}.segmentMax`;
    if (!pattern.test(seg)) return slugKey;
  }
  return null;
}

/** The i18n key for a full-path length violation, or null — for the create surfaces. */
export function pathLengthErrorKey(path: string): string | null {
  return path.length > PATH_MAX_LEN ? `${V}.pathMax` : null;
}

/** Case-insensitive exact-path membership — the create machinery treats paths case-insensitively. */
export function pathExists(path: string, existingPaths: ReadonlySet<string>): boolean {
  const lower = path.toLowerCase();
  for (const p of existingPaths) if (p.toLowerCase() === lower) return true;
  return false;
}

/** True when any known path sits AT or UNDER `dir` (case-insensitive) — the folder already exists. */
export function folderExists(dir: string, existingPaths: ReadonlySet<string>): boolean {
  const self = dir.toLowerCase();
  const prefix = `${self}/`;
  for (const p of existingPaths) {
    const lp = p.toLowerCase();
    if (lp === self || lp.startsWith(prefix)) return true;
  }
  return false;
}
