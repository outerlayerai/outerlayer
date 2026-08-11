/**
 * Context-mirror contracts for `GET /v1/context/changes` and the
 * `list_context_changes` MCP tool — the synced-commit history of an app's
 * `.outerlayer/` tree (see `apps/tenant-dashboard/supabase/schemas/33-context.sql`).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// GET /v1/context/changes — REST + MCP wire contract
// ---------------------------------------------------------------------------

export const ContextChangesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

/**
 * One synced commit whose `.outerlayer/` tree actually changed. Snapshot
 * identity is decoupled from commit sha (a push whose compare touches no
 * context files reuses the previous snapshot), so `commitSha` is the commit
 * that PRODUCED this snapshot, not necessarily the only commit that pointed
 * at it.
 */
export const ContextSnapshotEntrySchema = z.object({
  id: z.string().uuid(),
  commitSha: z.string(),
  classifierVersion: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export const ContextChangesSchema = z.object({
  snapshots: z.array(ContextSnapshotEntrySchema),
  pagination: z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  }),
});

export const ContextChangesResponseSchema = z.object({ data: ContextChangesSchema });

export type ContextChangesQuery = z.infer<typeof ContextChangesQuerySchema>;
export type ContextSnapshotEntry = z.infer<typeof ContextSnapshotEntrySchema>;
