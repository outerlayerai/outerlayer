import "server-only";

import { getBillingPageState } from "./actions";
import type { BillingPageState } from "./types";

type LoadBillingPageStateResult =
  | { ok: true; data: BillingPageState }
  | { ok: false; error: string };

/**
 * The React Server Component (RSC) read behind the billing settings page. Goes through the
 * `getBillingPageState` action rather than the service directly — unlike
 * a typical RSC read, this one carries real financial data (Stripe usage,
 * tier) that `billing.read` must gate explicitly, not just rely on `billing`
 * table RLS: the span-usage and Stripe-meter halves of the page state don't
 * come from a row RLS can filter.
 */
export async function loadBillingPageState(): Promise<LoadBillingPageStateResult> {
  const result = await getBillingPageState({});
  if (!result.ok) return { ok: false, error: result.error.message };
  return { ok: true, data: result.data };
}
