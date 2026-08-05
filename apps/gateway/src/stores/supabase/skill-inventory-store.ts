/**
 * Installed-skill inventory from the Context mirror — the repo side of the
 * unused-skills finding. Reads the app's most-recently-synced snapshot and
 * extracts its `skills/<name>/` directory names. Supabase-only (the mirror the
 * dashboard's Context tree already serves); no git-provider call.
 *
 * Branch note: an app can have a head per branch; we take the latest-synced
 * one. The skills set rarely diverges across branches, and the finding
 * recomputes nightly, so the newest sync is the honest "what the repo ships".
 */

import { skillNamesFromPaths } from "@outerlayer/insights-core";

type QueryResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * The slice of the Supabase client this store needs — a PostgREST builder that
 * is chainable AND awaitable at any point (the real client is). Narrow by
 * design so the handler can cast the system-admin client to it and tests can
 * hand-roll a builder without the full SDK.
 */
interface SkillInventoryBuilder<T = unknown> extends PromiseLike<QueryResult<T>> {
  select(columns: string): SkillInventoryBuilder<T>;
  eq(column: string, value: string): SkillInventoryBuilder<T>;
  order(column: string, opts: { ascending: boolean }): SkillInventoryBuilder<T>;
  limit(n: number): SkillInventoryBuilder<T>;
}
export interface SkillInventoryClient {
  from(table: "context_head" | "context_tree_entry"): SkillInventoryBuilder;
}

export interface SkillInventoryStore {
  /**
   * Skill names the app's latest snapshot installs. `null` when the app has no
   * synced mirror at all (never synced) — the skill findings need SOME repo to
   * compare against, so a null means "skip", distinct from `[]` (a real repo
   * that simply ships no skills, which still lets unversioned-skill fire).
   */
  listInstalledSkills(appId: string): Promise<string[] | null>;
}

export function createSkillInventoryStore(
  client: SkillInventoryClient,
): SkillInventoryStore {
  return {
    async listInstalledSkills(appId) {
      const head = (await client
        .from("context_head")
        .select("snapshot_id, synced_at")
        .eq("app_id", appId)
        .order("synced_at", { ascending: false })
        .limit(1)) as QueryResult<{ snapshot_id: string }>;
      if (head.error) throw new Error(`context_head read: ${head.error.message}`);
      const snapshotId = head.data?.[0]?.snapshot_id;
      if (!snapshotId) return null;

      const entries = (await client
        .from("context_tree_entry")
        .select("path")
        .eq("app_id", appId)
        .eq("snapshot_id", snapshotId)) as QueryResult<{ path: string }>;
      if (entries.error) throw new Error(`context_tree_entry read: ${entries.error.message}`);

      return skillNamesFromPaths((entries.data ?? []).map((e) => e.path));
    },
  };
}
