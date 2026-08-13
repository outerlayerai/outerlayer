/**
 * StorageCapService for Gateway
 *
 * Enforces storage caps for Hobby-tier tenants at the ingestion gateway.
 * Queries Stripe meter for cumulative GB usage and compares against the
 * effective limit (admin override → tier default from tier-config).
 *
 * Follows SpanLimitService pattern for entitlement resolution:
 * 1. Query billing table for tier_id
 * 2. Query tenant_entitlement_override for admin overrides
 * 3. effectiveLimit = override ?? getNumericLimit(key, tierId)
 *
 * Only Hobby tier is cap-enforced. Growth/Team overage is billed via Stripe.
 * Enterprise is unlimited.
 *
 * Caching lives in `GatewayCache` with a 5-minute TTL, not in service fields —
 * see `tier-resolution.ts` for why. Caching the verdict is what keeps the
 * Stripe meter call off the ingest path.
 *
 * Fails open on any error.
 */

import type { GatewayCache, StorageCapCheckResult } from '@repo/gateway-core/types';
import type { Database } from '@repo/gateway-core/db';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTierWithOverride } from '@repo/gateway-core/services/tier-resolution';
import { isSyntheticStripeCustomerId } from '../billing/synthetic-customer';
import { getNumericLimit, UNLIMITED } from '@repo/tier-config';
import Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BYTES_PER_GB = 1_000_000_000;
const ENTITLEMENT_KEY = 'max_storage_gb_per_month';

// ---------------------------------------------------------------------------
// Service interface + implementation
// ---------------------------------------------------------------------------

export interface IStorageCapService {
  checkStorageCap(tenantId: string, stripeCustomerId: string): Promise<StorageCapCheckResult>;
}

export class StorageCapService implements IStorageCapService {
  constructor(
    private readonly supabase: SupabaseClient<Database>,
    private readonly stripe: Stripe,
    private readonly storageMeterID: string,
    private readonly cache: GatewayCache,
  ) {}

  async checkStorageCap(tenantId: string, stripeCustomerId: string): Promise<StorageCapCheckResult> {
    // Fixture tenants carry synthetic customer ids with no Stripe customer
    // behind them — the meter call can only fail, so they are skipped at
    // every metering boundary (see billing/synthetic-customer.ts), this
    // enforcement boundary included.
    if (!stripeCustomerId || isSyntheticStripeCustomerId(stripeCustomerId)) {
      return { allowed: true, currentBytes: 0, limitBytes: 0, capReached: false };
    }

    const capCacheKey = `cap:${tenantId}`;
    const cached = await this.cache.storageCap.get(capCacheKey);
    if (cached.val) return cached.val;

    try {
      const { tierId, overrideLimit: overrideLimitGb } = await resolveTierWithOverride(
        this.cache,
        this.supabase,
        tenantId,
        ENTITLEMENT_KEY,
      );

      // Only Hobby is cap-enforced — Growth/Team overage billed via Stripe, Enterprise unlimited
      if (tierId !== 'hobby') {
        const result: StorageCapCheckResult = { allowed: true, currentBytes: 0, limitBytes: 0, capReached: false };
        await this.cache.storageCap.set(capCacheKey, result);
        return result;
      }

      // Resolve effective limit: override takes precedence over tier default
      const effectiveLimitGb = overrideLimitGb !== null ? overrideLimitGb : getNumericLimit(ENTITLEMENT_KEY, tierId);

      // Override set to unlimited (-1) → allow
      if (effectiveLimitGb === UNLIMITED) {
        const result: StorageCapCheckResult = { allowed: true, currentBytes: 0, limitBytes: UNLIMITED, capReached: false };
        await this.cache.storageCap.set(capCacheKey, result);
        return result;
      }

      const limitBytes = effectiveLimitGb * BYTES_PER_GB;

      // Query Stripe meter for cumulative GB this billing period
      const now = new Date();
      const periodStart = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime() / 1000);
      const periodEnd = Math.floor(now.getTime() / 1000);

      const summaries = await this.stripe.billing.meters.listEventSummaries(
        this.storageMeterID,
        {
          customer: stripeCustomerId,
          start_time: periodStart,
          end_time: periodEnd,
        }
      );

      const currentGb = summaries.data.reduce((acc, s) => acc + s.aggregated_value, 0);
      const currentBytes = Math.round(currentGb * BYTES_PER_GB);
      const capReached = currentBytes >= limitBytes;

      const result: StorageCapCheckResult = { allowed: !capReached, currentBytes, limitBytes, capReached };
      await this.cache.storageCap.set(capCacheKey, result);
      return result;
    } catch (err) {
      console.error(`[storage-cap] Failed to check cap for tenant ${tenantId}:`, err);
      // Fail open, but don't cache it. A cached `allowed` from a brief Stripe
      // outage would leave caps unenforced for 5 minutes after Stripe recovers.
      return { allowed: true, currentBytes: 0, limitBytes: UNLIMITED, capReached: false };
    }
  }
}

export function createStorageCapService(
  supabase: SupabaseClient<Database>,
  stripe: Stripe,
  storageMeterID: string,
  cache: GatewayCache,
): IStorageCapService {
  return new StorageCapService(supabase, stripe, storageMeterID, cache);
}
