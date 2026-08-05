import type { TierId } from "@/config/entitlements";

/** The near-limit banner's data: current span count against the tenant's monthly limit. */
export interface SpanUsage {
  currentCount: number;
  limit: number;
  unlimited: boolean;
  percentUsed: number;
}

/** The billing settings page's read shape (`public.billing` + Stripe meter usage). */
export interface BillingPageState {
  units: number;
  storageGb: number;
  isCancelling: boolean;
  tierId: TierId | null;
}
