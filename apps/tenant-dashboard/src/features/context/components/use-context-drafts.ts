import { useCallback, useMemo, useState } from "react";

/**
 * `edit` — an in-place change to an existing mirrored file; `create` — a new
 * file that doesn't exist at head yet; `delete` — a staged removal of an
 * existing mirrored file (no new content, `content` is `""`), landing in the
 * same batch commit as edits/creates rather than committing on its own.
 */
export type ContextDraftChangeType = "edit" | "create" | "delete";

export interface ContextDraft {
  /** Repo-relative path the draft targets. */
  path: string;
  /** Current buffered content (`""` for a `delete` — nothing new is written). */
  content: string;
  /** Pinned blob sha for an `edit`/`delete` (the conflict base); `null` for a `create`. */
  baseBlobSha: string | null;
  /**
   * The loaded bytes the change started from (`""` for a create) — the diff
   * base. For a `delete` this is the file's full content, so the publish dialog
   * renders the removal diff and its full-file `−N` line count; `""` when the
   * content wasn't loaded (a bulk skill/folder-dir delete stages by path alone).
   */
  baseContent: string;
  changeType: ContextDraftChangeType;
}

/** A path staged for deletion — the pinned base sha, plus its content for the diff when known. */
interface DeleteDraftTarget {
  path: string;
  baseBlobSha: string;
  /** The file's full content for the removal diff / line count; `""` when not loaded. */
  baseContent: string;
}

interface ContextDraftsStore {
  /** Live drafts keyed by path — order is insertion order (stable for the changes list). */
  drafts: ReadonlyMap<string, ContextDraft>;
  /** Insert or replace the draft for its path. */
  setDraft: (draft: ContextDraft) => void;
  /** Remove one path's draft (a reverted edit, a per-row discard, or a restored delete). */
  dropDraft: (path: string) => void;
  /**
   * Remove every named path's draft in ONE update — a published batch clears
   * its staged paths without cloning the whole map once per path.
   */
  dropDrafts: (paths: string[]) => void;
  /**
   * Stage a delete for each target in ONE update. A target whose path already
   * holds a `create` draft drops that draft instead (nothing exists remotely to
   * delete); otherwise a `delete` draft replaces whatever was there (an `edit`
   * on the same path is superseded — you can't edit and delete the same file).
   */
  stageDeletes: (targets: DeleteDraftTarget[]) => void;
  /** Remove every draft (discard-all / a committed batch). */
  clearDrafts: () => void;
}

/**
 * Multi-file draft buffer for the Context page. One entry per edited or newly
 * created file, held for the page's lifetime so switching files never loses a
 * buffer — the editor rehydrates from the draft on remount. Committing a batch
 * or discarding clears entries; nothing here persists across a full reload
 * (route-away is guarded by the caller).
 */
export function useContextDrafts(): ContextDraftsStore {
  const [drafts, setDrafts] = useState<Map<string, ContextDraft>>(() => new Map());

  const setDraft = useCallback((draft: ContextDraft) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(draft.path, draft);
      return next;
    });
  }, []);

  const dropDraft = useCallback((path: string) => {
    setDrafts((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const dropDrafts = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setDrafts((prev) => {
      const next = new Map(prev);
      for (const path of paths) next.delete(path);
      return next;
    });
  }, []);

  const stageDeletes = useCallback((targets: DeleteDraftTarget[]) => {
    if (targets.length === 0) return;
    setDrafts((prev) => {
      const next = new Map(prev);
      for (const target of targets) {
        if (next.get(target.path)?.changeType === "create") {
          // A staged create has no remote counterpart — deleting it just drops
          // the draft, never leaving a delete row for a file that never existed.
          next.delete(target.path);
        } else {
          next.set(target.path, {
            path: target.path,
            content: "",
            baseBlobSha: target.baseBlobSha,
            baseContent: target.baseContent,
            changeType: "delete",
          });
        }
      }
      return next;
    });
  }, []);

  const clearDrafts = useCallback(() => {
    setDrafts((prev) => (prev.size === 0 ? prev : new Map()));
  }, []);

  return useMemo(
    () => ({ drafts, setDraft, dropDraft, dropDrafts, stageDeletes, clearDrafts }),
    [drafts, setDraft, dropDraft, dropDrafts, stageDeletes, clearDrafts],
  );
}
