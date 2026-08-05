/**
 * Tier + entitlement-override lookup, shared by the two quota services.
 *
 * Both run on every ingest, and both need the same two facts: the tenant's
 * `billing.tier_id` and its override for one entitlement key.
 *
 * The cache lives in `GatewayCache`, not in the service. Route handlers build
 * these services per request, so a cache held on the instance is empty every
 * time. The cache stores outlive the request; the service doesn't.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../db';
import type { CachedTierResolution, GatewayCache } from '../types';
import type { TierId } from '@repo/tier-config';

/** Tier assumed when a tenant has no billing row — matches `@repo/entitlements`. */
const DEFAULT_TIER: TierId = 'hobby';

export interface TierResolution {
  tierId: TierId;
  overrideLimit: number | null;
}

/**
 * Key must carry the tenant AND the entitlement key.
 *
 * Callers pass RLS-scoped clients, so dropping the tenant leaks one tenant's
 * tier to another. Dropping the entitlement key makes the storage cap read the
 * span cap's override.
 */
export function tierResolutionCacheKey(tenantId: string, entitlementKey: string): string {
  return `tier:${tenantId}:${entitlementKey}`;
}

/**
 * Unwrap the `{ v: <value> }` JSONB envelope into a finite number.
 *
 * Anything malformed returns null and falls through to the tier default. Note
 * booleans are rejected rather than coerced: `Number(true)` is 1, which would
 * shrink a quota to almost nothing.
 */
function parseNumericOverride(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = (value as { v?: unknown }).v;
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The uncached read. `degraded` is true when a read failed, as opposed to
 * correctly finding no row.
 *
 * That difference decides whether we cache. "No billing row" is a real answer
 * and stays true for the TTL. A failed read tells us nothing, and caching its
 * hobby fallback would cap a paying tenant for the next 5 minutes.
 */
async function readTierWithOverride(
  supabase: SupabaseClient<Database>,
  tenantId: string,
  entitlementKey: string,
): Promise<{ resolution: TierResolution; degraded: boolean }> {
  // Independent reads, so don't pay two round-trips on the ingest path.
  const [billingResult, overrideResult] = await Promise.all([
    supabase.from('billing').select('tier_id').eq('tenant_id', tenantId).maybeSingle(),
    supabase
      .from('tenant_entitlement_override')
      .select('value')
      .eq('tenant_id', tenantId)
      .eq('entitlement_key', entitlementKey)
      .maybeSingle(),
  ]);

  let degraded = false;

  if (billingResult.error) {
    console.warn(
      `[tier-resolution] billing read failed for tenant ${tenantId}:`,
      billingResult.error.message,
    );
    degraded = true;
  }
  if (overrideResult.error) {
    console.warn(
      `[tier-resolution] override read failed for tenant ${tenantId} (${entitlementKey}):`,
      overrideResult.error.message,
    );
    degraded = true;
  }

  const tierId = (billingResult.data?.tier_id as TierId) || DEFAULT_TIER;
  const overrideLimit = parseNumericOverride(overrideResult.data?.value);

  return { resolution: { tierId, overrideLimit }, degraded };
}

export async function resolveTierWithOverride(
  cache: GatewayCache,
  supabase: SupabaseClient<Database>,
  tenantId: string,
  entitlementKey: string,
): Promise<TierResolution> {
  const key = tierResolutionCacheKey(tenantId, entitlementKey);

  const cached = await cache.tenantEntitlements.get(key);
  if (cached.val) {
    return {
      tierId: cached.val.tierId as TierId,
      overrideLimit: cached.val.overrideLimit,
    };
  }

  const { resolution, degraded } = await readTierWithOverride(
    supabase,
    tenantId,
    entitlementKey,
  );

  if (!degraded) {
    await cache.tenantEntitlements.set(key, resolution as CachedTierResolution);
  }

  return resolution;
}
