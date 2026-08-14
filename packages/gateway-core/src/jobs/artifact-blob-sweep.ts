/**
 * Unmatched-artifact blob release — the storage half of artifact age-out.
 *
 * The dashboard reconciler marks artifacts whose grace window elapsed with no
 * PR match as `verification = 'unmatched'`; this sweep (riding the gateway's
 * daily retention cron) releases their blob bytes from BOTH stores — the
 * ClickHouse `agent_blobs` row and the object-storage copy — and stamps
 * `blob_deleted` so a row is swept exactly once. Cross-tenant by
 * construction: one pass drains every tenant's unmatched rows (system-client
 * caller shape 2), with each row's deletes scoped by the row's own
 * tenant_id + app_id.
 *
 * Blobs are content-addressed and therefore SHARED: several artifact rows can
 * claim one (tenant, app, sha256). A row whose bytes another live artifact
 * row still claims releases only its claim (`blob_deleted = true`, nothing
 * deleted); the bytes leave the stores when the LAST live claim is released.
 * Rows are processed sequentially against fresh liveness reads, so a batch
 * containing every claimant of one sha converges: earlier rows release,
 * the final one deletes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createBlobStorage, type BlobStorage } from '../lib/blob-storage';
import { agentBlobKey, createAgentIngestClient } from '../openapi/routes/agents';
import type { Database } from '../db';
import type { Env } from '../types';

/** Rows examined per run; a larger backlog drains across daily runs. */
export const ARTIFACT_BLOB_SWEEP_BATCH_SIZE = 500;

export interface ArtifactBlobSweepResult {
  /** Unmatched, not-yet-swept rows read this run. */
  examined: number;
  /** Blobs removed from both stores (last live claim released). */
  blobsDeleted: number;
  /** Rows stamped blob_deleted this run. */
  rowsMarked: number;
  /** Rows left unstamped for the next run because a delete or read failed. */
  failures: number;
}

export async function sweepUnmatchedArtifactBlobs(
  env: Env,
  supabase: SupabaseClient<Database>,
): Promise<ArtifactBlobSweepResult> {
  const { data: rows, error } = await supabase
    .from('artifact')
    .select('id,tenant_id,app_id,sha256')
    .eq('verification', 'unmatched')
    .eq('blob_deleted', false)
    .limit(ARTIFACT_BLOB_SWEEP_BATCH_SIZE);
  if (error) {
    throw new Error(`artifact-blob-sweep: unmatched read failed: ${error.message}`);
  }

  const result: ArtifactBlobSweepResult = {
    examined: rows?.length ?? 0,
    blobsDeleted: 0,
    rowsMarked: 0,
    failures: 0,
  };
  if (!rows || rows.length === 0) return result;

  let storage: BlobStorage | null = null;
  try {
    storage = createBlobStorage(env);
  } catch (e) {
    // No object storage configured (self-host without R2/S3): blobs live only
    // in ClickHouse there, so the row delete alone IS the complete deletion.
    console.warn('[artifact-blob-sweep] blob storage unavailable, ClickHouse only:', e);
  }

  const client = createAgentIngestClient(env);
  try {
    for (const row of rows) {
      try {
        // Liveness: another artifact row (any verification state) with an
        // unreleased claim on the same bytes keeps them alive. The count
        // deliberately consults ONLY artifact rows: a transcript turn image
        // can reference the same sha (agent_blobs is one content-addressed
        // pool per tenant + app), and deleting a sha such an image still
        // references breaks its render — an accepted trade: unmatched
        // evidence bytes must actually leave the store, and the transcript
        // degrades to a missing image, never an error.
        const { count, error: countError } = await supabase
          .from('artifact')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', row.tenant_id)
          .eq('app_id', row.app_id)
          .eq('sha256', row.sha256)
          .eq('blob_deleted', false)
          .neq('id', row.id);
        if (countError) {
          throw new Error(`shared-sha count failed: ${countError.message}`);
        }

        if ((count ?? 0) === 0) {
          // ClickHouse copy: a lightweight point delete. It hides the row
          // from every read immediately (the "blob is gone" contract the
          // dashboard and blob route observe); the physical rewrite follows
          // at merge. The retention sweep's heavy ALTER DELETE is for its
          // hard-deletion entitlement — daily per-sha point deletes as heavy
          // mutations would rewrite parts constantly for no reader-visible
          // difference.
          await client.command({
            query:
              'DELETE FROM agent_blobs ' +
              'WHERE TenantId = {t:String} AND AppId = {a:String} AND Sha256 = {s:String}',
            query_params: { t: row.tenant_id, a: row.app_id, s: row.sha256 },
          });
          if (storage) {
            await storage.delete(agentBlobKey(row.tenant_id, row.app_id, row.sha256));
          }
          result.blobsDeleted += 1;
        }

        // Stamped only after every delete above succeeded. A row that fails
        // mid-way stays blob_deleted=false and the next sweep retries it —
        // both deletes are idempotent (point delete + content-addressed key),
        // so the finished half re-runs as a no-op.
        const { error: updateError } = await supabase
          .from('artifact')
          .update({ blob_deleted: true })
          .eq('id', row.id)
          .eq('tenant_id', row.tenant_id);
        if (updateError) {
          throw new Error(`blob_deleted stamp failed: ${updateError.message}`);
        }
        result.rowsMarked += 1;
      } catch (e) {
        result.failures += 1;
        console.warn(`[artifact-blob-sweep] row ${row.id} failed, retrying next sweep:`, e);
      }
    }
  } finally {
    await client.close();
  }
  return result;
}
