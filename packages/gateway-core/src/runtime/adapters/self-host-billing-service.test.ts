/**
 * Behavior locked here:
 *   - SelfHostBillingService.checkStorageCap returns the exact uncapped result
 *     (allowed, never cap-reached) so self-host ingest is never blocked.
 *   - SelfHostBillingService contributes NO cron metering tasks.
 *
 * The vendor (Stripe) counterpart stays with the Cloudflare shell —
 * `apps/gateway/src/runtime/adapters/stripe-billing-service.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { UNLIMITED } from "@repo/tier-config";
import { SelfHostBillingService } from "./self-host-billing-service";

describe("SelfHostBillingService", () => {
  it("checkStorageCap always allows, with the uncapped result shape", async () => {
    const result = await new SelfHostBillingService().checkStorageCap();
    expect(result).toEqual({
      allowed: true,
      currentBytes: 0,
      limitBytes: UNLIMITED,
      capReached: false,
    });
  });

  it("contributes no metering tasks", () => {
    expect(new SelfHostBillingService().meteringTasks()).toEqual([]);
  });

  it("does not enforce subscription rate-limit tiers (self-host has no subscriptions)", () => {
    expect(new SelfHostBillingService().enforcesSubscriptionTiers).toBe(false);
  });
});
