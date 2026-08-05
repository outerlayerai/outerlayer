/**
 * Cloudflare/hosted impl of `BillingService`.
 *
 * `checkStorageCap` delegates to the existing `StorageCapService` (Stripe usage
 * meter + tier lookup) — identical to the inline `createStorageCapService(...)`
 * call in the ingest handler, which Step 3e replaces with
 * `gtx.billing.checkStorageCap(...)` and drops the `resolveBillingConfig().enabled`
 * branch.
 */
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "@repo/gateway-core/types";
import type { StorageCapCheckResult, GatewayScheduleContext, GatewayCache } from "@repo/gateway-core/types";
import type { Database } from "@repo/gateway-core/db";
import type { BillingService, MeteringTask } from "@repo/gateway-core/runtime/gateway-context";
import { createStorageCapService } from "../../services/storage-cap-service";
import { createMeteringClickHouseClient } from "../../billing/metering-clickhouse";
import { stripeMeterEventHandler } from "../../jobs/stripe-meter-event-handler";
import { storageMeteringHandler } from "../../jobs/storage-metering-handler";

type BillingBindings = Pick<
  Env,
  "STRIPE_SECRET_KEY" | "STRIPE_STORAGE_METER_ID" | "CLICKHOUSE_HOST" | "CLICKHOUSE_PASSWORD"
>;

export class StripeBillingService implements BillingService {
  // Hosted splits rate-limit tiers by Stripe subscription — a subscription-less
  // tenant gets the throttled tier.
  readonly enforcesSubscriptionTiers = true;

  constructor(private readonly env: BillingBindings) {}

  async checkStorageCap(
    supabase: SupabaseClient<Database>,
    tenantId: string,
    stripeCustomerId: string,
    cache: GatewayCache,
  ): Promise<StorageCapCheckResult> {
    const capService = createStorageCapService(
      supabase,
      new Stripe(this.env.STRIPE_SECRET_KEY!),
      this.env.STRIPE_STORAGE_METER_ID!,
      cache,
    );
    return capService.checkStorageCap(tenantId, stripeCustomerId);
  }

  meteringTasks(cron: GatewayScheduleContext): MeteringTask[] {
    return [
      {
        source: "stripe-meter-handler",
        run: () => stripeMeterEventHandler(cron),
      },
      {
        source: "storage-metering-handler",
        run: () =>
          storageMeteringHandler(cron, {
            clickhouse: this.buildClickHouseClient(),
            stripe: new Stripe(this.env.STRIPE_SECRET_KEY!, { maxNetworkRetries: 3 }),
          }),
      },
    ];
  }

  /** ClickHouse client wrapper for the storage-metering job — the guarded
   * metering client (memory caps + spill + per-partition FINAL) behind the
   * handler's narrow query/close interface. */
  private buildClickHouseClient() {
    const client = createMeteringClickHouseClient(this.env);
    return {
      query: ({ query, format }: { query: string; format: string }) =>
        client.query({ query, format: format as never }),
      close: () => client.close(),
    };
  }
}
