/**
 * Entitlement-driven physical retention sweep.
 *
 * Daily cron: resolve every tenant's `data_retention_days` (override → tier
 * matrix → hobby default, via @repo/entitlements' STRICT batch resolver) and
 * physically delete expired data — ClickHouse rows per table via the
 * retention store, and R2 payload blobs (oversized span fields + agent
 * images) by object age. The entitlement, not a fixed DDL TTL, drives deletion
 * in both directions: retention beyond 90 days keeps its data rather than
 * losing it at a TTL boundary, and retention under 90 days is a hard delete
 * rather than query-time hiding.
 *
 * Safety properties, in order of importance:
 *   1. A Supabase read failure THROWS before anything is deleted — the
 *      batch resolver never degrades a tenant to a default on an outage
 *      (that would mass-delete long-retention tenants at 7 days).
 *   2. Zero resolved billing rows aborts the run — on hosted, an empty
 *      billing table means a catastrophic misread, not a fresh install.
 *   3. `-1` (unlimited) tenants are excluded from every delete.
 *   4. A non-numeric / sub-1-day resolved value marks the tenant invalid
 *      and EXCLUDES it (an accidental `0` override must not compute a
 *      cutoff of "now" and delete everything).
 *   5. Tenants with data but no billing row get the hobby fallback — the
 *      entitlement a pre-checkout tenant actually has; for rows orphaned
 *      by tenant deletion it is the deletion tail.
 *   6. Per-table isolation: one table's failure (or a still-running
 *      mutation from a previous sweep — the backpressure signal) skips
 *      that table only. Deletes are cumulative, so skips self-heal.
 *   7. Blob objects whose keys don't match a known tenant-prefixed shape
 *      are never deleted.
 */

import {
  resolveNumericLimitForAllTenants,
  type TenantNumericLimits,
} from "@repo/entitlements";
import type { SupabaseEntitlementClient } from "@repo/entitlements";
import { UNLIMITED } from "@repo/tier-config";
import type { ILoggerService } from "./logger";
import {
  RETENTION_TABLES,
  type RetentionStore,
  type TenantCutoff,
} from "@repo/gateway-core/stores/clickhouse/retention-store";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Env slice the config resolver reads — structural, so tests stay simple. */
export interface RetentionSweepEnv {
  RETENTION_SWEEP_ENABLED?: string;
  RETENTION_SWEEP_MAX_BLOB_OBJECTS?: string;
}

export interface RetentionSweepConfig {
  enabled: boolean;
  /** Max R2 objects examined per run; the backlog drains across daily runs. */
  maxBlobObjectsPerRun: number;
}

export function resolveRetentionSweepConfig(env: RetentionSweepEnv): RetentionSweepConfig {
  return {
    enabled: env.RETENTION_SWEEP_ENABLED === "true",
    maxBlobObjectsPerRun: parsePositiveInt(env.RETENTION_SWEEP_MAX_BLOB_OBJECTS, 50_000),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Blob bucket sweep seam
// ---------------------------------------------------------------------------

/**
 * The slice of the R2 binding the blob sweep consumes. The shared
 * `BlobBucket` type (gateway-core bindings) declares only `put`/`get` — the
 * ingest/rehydration surface — so the handler narrows the runtime binding
 * with {@link supportsBlobSweep} instead of widening the shared type for
 * every consumer.
 */
export interface SweepableBlobBucket {
  list(options?: { cursor?: string; limit?: number }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<void>;
}

/** True when the bound blob store exposes the list/delete surface (real R2 does). */
export function supportsBlobSweep(bucket: unknown): bucket is SweepableBlobBucket {
  const candidate = bucket as Record<string, unknown> | null | undefined;
  return (
    typeof candidate?.list === "function" && typeof candidate?.delete === "function"
  );
}

// ---------------------------------------------------------------------------
// Sweep service
// ---------------------------------------------------------------------------

export interface RetentionSweepDeps {
  store: RetentionStore;
  /** Admin (service-role) client — the sweep is cross-tenant by construction. */
  supabase: SupabaseEntitlementClient;
  /** Null when the runtime's blob store can't list/delete — rows still sweep. */
  blobs: SweepableBlobBucket | null;
  logger: ILoggerService;
  config: RetentionSweepConfig;
  /** The cron fire time (epoch ms) — cutoffs derive from it, not from Date.now(). */
  nowMs: number;
}

export interface RetentionSweepResult {
  /** Tables where a delete mutation was scheduled, with expired-tenant counts. */
  swept: { table: string; tenants: number }[];
  /** Tables skipped and why (pending mutation backpressure, per-table errors). */
  skipped: { table: string; reason: string }[];
  /** Tenants excluded because their resolved value was invalid (not -1, not ≥1). */
  invalidTenants: number;
  blobsDeleted: number;
  blobsExamined: number;
  /** True when the object cap stopped the blob scan before the bucket ended. */
  blobScanTruncated: boolean;
}

const SECONDS_PER_DAY = 86_400;
/** R2 list page size — also the per-call delete batch cap. */
const BLOB_PAGE_SIZE = 1_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant owner of an R2 object, from the two key shapes the gateway writes:
 *   `<tenantId>/<appId>/<traceId>/<spanId>/<Field>`  (blob-offload.ts)
 *   `agents/<tenantId>/<appId>/<sha256>`             (routes/agents.ts)
 * Anything else — including a tenant segment that isn't a UUID — returns
 * null and is never deleted.
 */
export function tenantOfBlobKey(key: string): string | null {
  const segments = key.split("/");
  if (segments.length === 5 && UUID_RE.test(segments[0]!)) return segments[0]!;
  if (segments.length === 4 && segments[0] === "agents" && UUID_RE.test(segments[1]!)) {
    return segments[1]!;
  }
  return null;
}

export async function runRetentionSweep(
  deps: RetentionSweepDeps,
): Promise<RetentionSweepResult> {
  const { store, supabase, blobs, logger, config, nowMs } = deps;

  // Throws on any Supabase read error — nothing has been deleted yet.
  const limits = await resolveNumericLimitForAllTenants(supabase, "data_retention_days", {
    warn: (message, fields) => logger.warn(`[retention-sweep] ${message}`, fields),
  });

  if (limits.byTenant.size === 0) {
    throw new Error(
      "retention sweep aborted: zero billing rows resolved — refusing to sweep every tenant at the hobby fallback",
    );
  }

  const cutoffs = new CutoffResolver(limits, nowMs);

  const swept: RetentionSweepResult["swept"] = [];
  const skipped: RetentionSweepResult["skipped"] = [];

  const pending = await store.pendingDeleteMutations();

  for (const table of RETENTION_TABLES) {
    const pendingCount = pending.get(table.table) ?? 0;
    if (pendingCount > 0) {
      // A previous sweep's mutation is still rewriting parts. Stacking
      // another would double the rewrite work for the same rows; skipping
      // costs nothing because tomorrow's cutoff covers today's rows too.
      skipped.push({ table: table.table, reason: `pending_mutations:${pendingCount}` });
      continue;
    }

    try {
      const oldest = await store.oldestRowPerTenant(table);
      const expired: TenantCutoff[] = [];
      for (const [tenantId, oldestUnixSec] of oldest) {
        const cutoffUnixSec = cutoffs.forTenant(tenantId);
        if (cutoffUnixSec !== null && oldestUnixSec < cutoffUnixSec) {
          expired.push({ tenantId, cutoffUnixSec });
        }
      }
      if (expired.length > 0) {
        await store.deleteExpiredRows(table, expired);
        swept.push({ table: table.table, tenants: expired.length });
      }
    } catch (error) {
      // Per-table isolation: a missing table (migrations lagging a deploy)
      // or a transient ClickHouse error must not stop the other tables.
      skipped.push({ table: table.table, reason: "error" });
      logger.error(
        error instanceof Error ? error : new Error(String(error)),
        { source: "retention-sweep", table: table.table },
      );
    }
  }

  const blobResult = blobs
    ? await sweepBlobs(blobs, cutoffs, config.maxBlobObjectsPerRun)
    : { blobsDeleted: 0, blobsExamined: 0, blobScanTruncated: false };

  return {
    swept,
    skipped,
    invalidTenants: cutoffs.invalidTenants.size,
    ...blobResult,
  };
}

/**
 * Per-tenant cutoff (unix seconds), memoized. `null` means "never delete":
 * unlimited (-1) or an invalid resolved value (guard #4).
 */
class CutoffResolver {
  readonly invalidTenants = new Set<string>();

  private readonly memo = new Map<string, number | null>();

  constructor(
    private readonly limits: TenantNumericLimits,
    private readonly nowMs: number,
  ) {}

  forTenant(tenantId: string): number | null {
    const cached = this.memo.get(tenantId);
    if (cached !== undefined) return cached;

    const retentionDays = this.limits.byTenant.get(tenantId) ?? this.limits.fallback;
    let cutoff: number | null;
    if (retentionDays === UNLIMITED) {
      cutoff = null;
    } else if (!Number.isFinite(retentionDays) || retentionDays < 1) {
      this.invalidTenants.add(tenantId);
      cutoff = null;
    } else {
      cutoff = Math.floor(this.nowMs / 1000) - retentionDays * SECONDS_PER_DAY;
    }
    this.memo.set(tenantId, cutoff);
    return cutoff;
  }
}

/**
 * One paginated pass over the whole bucket (not per-tenant prefixes): the
 * bucket only holds oversized-payload and agent-image objects, so a bounded
 * bucket scan is cheaper than listing every tenant's prefix — and it reaps
 * orphaned prefixes for free. Objects are deleted when their `uploaded`
 * time (refreshed by the deterministic-key re-PUT on re-ingest) is past
 * their owner's cutoff.
 */
async function sweepBlobs(
  blobs: SweepableBlobBucket,
  cutoffs: CutoffResolver,
  maxObjects: number,
): Promise<Pick<RetentionSweepResult, "blobsDeleted" | "blobsExamined" | "blobScanTruncated">> {
  let blobsDeleted = 0;
  let blobsExamined = 0;
  let cursor: string | undefined;

  while (blobsExamined < maxObjects) {
    const page = await blobs.list({
      cursor,
      limit: Math.min(BLOB_PAGE_SIZE, maxObjects - blobsExamined),
    });

    const expiredKeys: string[] = [];
    for (const object of page.objects) {
      blobsExamined += 1;
      const tenantId = tenantOfBlobKey(object.key);
      if (tenantId === null) continue;
      const cutoffUnixSec = cutoffs.forTenant(tenantId);
      if (cutoffUnixSec === null) continue;
      if (object.uploaded.getTime() < cutoffUnixSec * 1000) {
        expiredKeys.push(object.key);
      }
    }

    if (expiredKeys.length > 0) {
      await blobs.delete(expiredKeys);
      blobsDeleted += expiredKeys.length;
    }

    if (!page.truncated || page.cursor === undefined) {
      return { blobsDeleted, blobsExamined, blobScanTruncated: false };
    }
    cursor = page.cursor;
  }

  return { blobsDeleted, blobsExamined, blobScanTruncated: true };
}
