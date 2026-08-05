/**
 * Behavior locked here:
 *   - StripeBillingService contributes exactly the two metering jobs, in order,
 *     tagged with the sources the scheduled handler logs against.
 *
 * The vendor-free `SelfHostBillingService` moved to gateway-core alongside the
 * `BillingService` interface — its behavior is locked in
 * `packages/gateway-core/src/runtime/adapters/self-host-billing-service.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "@repo/gateway-core/types";
import type { GatewayScheduleContext } from "@repo/gateway-core/types";
import { StripeBillingService } from "./stripe-billing-service";

describe("StripeBillingService", () => {
  it("contributes the two metering jobs in order, source-tagged", () => {
    // meteringTasks() returns descriptors without invoking the handlers
    // (Stripe/ClickHouse are constructed lazily inside each task's run()).
    const tasks = new StripeBillingService({} as Env).meteringTasks({} as GatewayScheduleContext);

    expect(tasks.map((t) => t.source)).toEqual([
      "stripe-meter-handler",
      "storage-metering-handler",
    ]);
    expect(tasks.every((t) => typeof t.run === "function")).toBe(true);
  });

  it("enforces subscription rate-limit tiers (hosted splits by Stripe subscription)", () => {
    expect(new StripeBillingService({} as Env).enforcesSubscriptionTiers).toBe(true);
  });
});
