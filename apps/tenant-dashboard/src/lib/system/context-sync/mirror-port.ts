import "server-only";

/**
 * Supabase-backed `ContextMirrorPort` — the only I/O this service does
 * against Postgres. Every write goes through the service-role client;
 * `context_blob` / `context_snapshot` / `context_tree_entry` / `context_head`
 * carry no authenticated-writable RLS policy (`33-context.sql`).
 */
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/db';
import type {
  AdvanceHeadInput,
  ContextHeadRecord,
  ContextMirrorPort,
  CreateSnapshotInput,
  SyncEventInput,
} from '@repo/context-sync';

export function createSupabaseContextMirrorPort(
  supabase: SupabaseClient<Database>
): ContextMirrorPort {
  return {
    async loadHead(appId: string): Promise<ContextHeadRecord | null> {
      const { data, error } = await supabase
        .from('context_head')
        .select('branch, commit_sha, snapshot_id')
        .eq('app_id', appId)
        .limit(1)
        .maybeSingle();

      if (error) throw new Error(`context-sync: loadHead failed: ${error.message}`);
      if (!data) return null;

      return { branch: data.branch, commitSha: data.commit_sha, snapshotId: data.snapshot_id };
    },

    async getSnapshotPaths(snapshotId: string): Promise<string[]> {
      const { data, error } = await supabase
        .from('context_tree_entry')
        .select('path')
        .eq('snapshot_id', snapshotId);

      if (error) throw new Error(`context-sync: getSnapshotPaths failed: ${error.message}`);
      return (data ?? []).map((row) => row.path);
    },

    async hasBlob(appId: string, blobSha: string): Promise<boolean> {
      const { count, error } = await supabase
        .from('context_blob')
        .select('blob_sha', { count: 'exact', head: true })
        .eq('app_id', appId)
        .eq('blob_sha', blobSha);

      if (error) throw new Error(`context-sync: hasBlob failed: ${error.message}`);
      return (count ?? 0) > 0;
    },

    async createSnapshot(input: CreateSnapshotInput): Promise<{ snapshotId: string }> {
      const { data, error } = await supabase.rpc('create_context_snapshot', {
        p_app_id: input.appId,
        p_tenant_id: input.tenantId,
        // The generated RPC arg type is `string` (Postgres function params
        // carry no NULL-ability in pg_proc for codegen to reflect), but the
        // SQL function's p_branch is a plain nullable `TEXT` — passing null
        // is valid at the wire/SQL level and is how a bare-sha
        // materialization (ensureSnapshotAt with a commitSha ref) skips the
        // context_head upsert. See 33-context.sql.
        p_branch: input.branch as string,
        p_commit_sha: input.commitSha,
        p_classifier_version: input.classifierVersion,
        p_blobs: input.blobs.map((b) => ({ blob_sha: b.blobSha, content: b.content, size: b.size })),
        p_entries: input.entries.map((e) => ({
          path: e.path,
          blob_sha: e.blobSha,
          kind: e.kind,
          scope_path: e.scopePath,
        })),
        // Stored as a raw jsonb blob (no recordset parse), so it keeps the
        // camelCase shape the read side reads back verbatim. Mapped to fresh
        // object literals so it satisfies the generated `Json` RPC arg type.
        p_excluded_counts: input.excludedCounts.map((c) => ({
          scopePath: c.scopePath,
          skillName: c.skillName,
          count: c.count,
        })),
      });

      if (error) throw new Error(`context-sync: createSnapshot failed: ${error.message}`);
      return { snapshotId: data as string };
    },

    async advanceHead(input: AdvanceHeadInput): Promise<void> {
      const { error } = await supabase
        .from('context_head')
        .update({
          commit_sha: input.commitSha,
          snapshot_id: input.snapshotId,
          synced_at: new Date().toISOString(),
        })
        .eq('app_id', input.appId)
        .eq('branch', input.branch);

      if (error) throw new Error(`context-sync: advanceHead failed: ${error.message}`);
    },

    async recordSyncEvent(event: SyncEventInput): Promise<void> {
      const { error } = await supabase.from('context_sync_event').insert({
        app_id: event.appId,
        tenant_id: event.tenantId,
        branch: event.branch,
        commit_sha: event.commitSha,
        commit_message: event.commitMessage,
        trigger: event.trigger,
        status: event.status,
        error: event.error,
        duration_ms: event.durationMs,
        snapshot_id: event.snapshotId,
      });

      if (error) throw new Error(`context-sync: recordSyncEvent failed: ${error.message}`);
    },
  };
}
