import type { ContextKind } from "@repo/context-core";
import type { SkillDeletionEnumeration } from "@/lib/adapters/context-save";

export type { SkillDeletionEnumeration };

/**
 * The minimal, self-contained contract the editor needs to load and save one
 * context file. The tree/viewer owns the mirror data layer; it constructs one
 * of these from a loaded file and mounts
 * {@link import('./context-editor').ContextEditor}. Nothing here depends on
 * the tree/viewer components — the editor is decoupled behind this handle.
 */
export interface ContextFileHandle {
  /** Repo-relative, `/`-normalized path of the file being edited. */
  path: string;
  /** Classified kind — selects the editor mode and the frontmatter schema. */
  kind: ContextKind;
  /** File content loaded from the mirror at the pinned commit. */
  content: string;
  /**
   * Blob sha the content was loaded at — the pinned save base. A
   * mismatch at remote head is a conflict, never a silent overwrite.
   */
  baseBlobSha: string;
  /** Commit sha the mirror head was at when this file was loaded. */
  baseCommitSha: string;
  /** skill/skill-reference: the skill's directory name — frontmatter `name` must equal it. */
  skillDirName?: string;
  /** subagent: the filename stem — frontmatter `name` must equal it. */
  fileStem?: string;
}

/**
 * Re-reads a file's content + blob sha at the live remote head — backs the
 * commit dialog's per-row conflict "Refresh" (adopt the new base). Injected
 * because reading the remote head belongs to the page's data layer.
 */
export type ReloadRemoteFn = (
  path: string,
) => Promise<{ content: string; baseBlobSha: string; baseCommitSha: string }>;
