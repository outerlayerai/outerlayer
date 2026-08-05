/**
 * SpanLimitService for Gateway
 *
 * Enforces monthly span ingestion limits per tenant tier.
 * Limits are defined in @repo/tier-config (shared with tenant-dashboard).
 *
 * Caching lives in `GatewayCache`, not in service fields — see
 * `tier-resolution.ts` for why. Tier + override: 5 min. Span count: 60s.
 */

import type { IClickHouseService } from './clickhouse-service';
import type { GatewayCache, SpanLimitCheckResult } from '../types';
import type { Database } from '../db';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getNumericLimit, UNLIMITED } from '@repo/tier-config';
import { resolveTierWithOverride } from './tier-resolution';

/** The entitlement key this service resolves an override for. */
const ENTITLEMENT_KEY = 'max_spans_per_month';

// ---------------------------------------------------------------------------
// Service interface + implementation
// ---------------------------------------------------------------------------

export interface ISpanLimitService {
  checkSpanLimit(tenantId: string): Promise<SpanLimitCheckResult>;
}

export interface SpanLimitServiceOptions {
  /**
   * Self-host deployment: ingest is uncapped — `checkSpanLimit`
   * short-circuits to unlimited without reading billing (Supabase) or
   * counting spans (ClickHouse). Callers derive this from
   * `isSelfHostGateway(env)` (lib/entitlements.ts); the Cloud worker never
   * sets it.
   */
  selfHost?: boolean;
}

export class SpanLimitService implements ISpanLimitService {
  constructor(
    private readonly clickhouse: IClickHouseService,
    private readonly supabase: SupabaseClient<Database>,
    private readonly cache: GatewayCache,
    private readonly options: SpanLimitServiceOptions = {},
  ) {}

  async checkSpanLimit(tenantId: string): Promise<SpanLimitCheckResult> {
    // Self-host: same result shape as the UNLIMITED shortcut below, reached
    // without any billing or ClickHouse I/O.
    if (this.options.selfHost) {
      return { allowed: true, currentCount: 0, limit: UNLIMITED, remaining: UNLIMITED };
    }

    const { tierId, overrideLimit } = await resolveTierWithOverride(
      this.cache,
      this.supabase,
      tenantId,
      ENTITLEMENT_KEY,
    );

    // Determine effective limit: override takes precedence over tier default
    const effectiveLimit = overrideLimit !== null ? overrideLimit : getNumericLimit(ENTITLEMENT_KEY, tierId);

    // Unlimited shortcut — skip ClickHouse count query entirely
    if (effectiveLimit === UNLIMITED) {
      return { allowed: true, currentCount: 0, limit: UNLIMITED, remaining: UNLIMITED };
    }

    const currentCount = await this.getMonthlyCount(tenantId);
    const allowed = currentCount < effectiveLimit;
    const remaining = Math.max(0, effectiveLimit - currentCount);

    return { allowed, currentCount, limit: effectiveLimit, remaining };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async getMonthlyCount(tenantId: string): Promise<number> {
    const cacheKey = `spans:${tenantId}`;
    const cached = await this.cache.spanUsage.get(cacheKey);
    if (cached.val !== undefined && cached.val !== null) return cached.val;

    const rows = await this.clickhouse.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM otel_traces FINAL WHERE TenantId = {tenantId:String} AND IsDeleted = 0 AND toYYYYMM(CreatedAt) = toYYYYMM(now())`,
      { tenantId },
    );

    const firstRow = rows[0];
    const count = firstRow ? Number(firstRow.count) : 0;
    await this.cache.spanUsage.set(cacheKey, count);
    return count;
  }
}

/**
 * Create a SpanLimitService with the given dependencies.
 */
export function createSpanLimitService(
  clickhouse: IClickHouseService,
  supabase: SupabaseClient<Database>,
  cache: GatewayCache,
  options?: SpanLimitServiceOptions,
): ISpanLimitService {
  return new SpanLimitService(clickhouse, supabase, cache, options);
}
