/**
 * Self-host impl of `BillingService` — a grant-everything Null Object.
 *
 * Never imports `stripe`. `checkStorageCap` returns the exact "unlimited tier"
 * result the real `StorageCapService` returns for an uncapped tenant
 * (`storage-cap-service.ts`), so ingest is always allowed and never touches
 * Stripe. This is how "billing disabled" is represented under the
 * no-default-adapters rule: an injected no-op adapter, not `null` or a flag.
 *
 * Vendor-free, so it lives in core alongside the interfaces it implements; both
 * composition roots construct it — the Worker root when billing is disabled, the
 * Node root (`apps/gateway-node`, Step 5) always.
 */
import { UNLIMITED } from "@repo/tier-config";
import type { StorageCapCheckResult } from "../../types";
import type { BillingService, MeteringTask } from "../gateway-context";

export class SelfHostBillingService implements BillingService {
  // No Stripe subscriptions on self-host → the rate limiter must not collapse
  // tenants to the throttled 'free' tier; they all get the unlimited tier.
  readonly enforcesSubscriptionTiers = false;

  async checkStorageCap(): Promise<StorageCapCheckResult> {
    // Identical to the real service's uncapped-tenant result (storage-cap-service.ts).
    return { allowed: true, currentBytes: 0, limitBytes: UNLIMITED, capReached: false };
  }

  meteringTasks(): MeteringTask[] {
    return []; // no Stripe → no metering jobs
  }
}
