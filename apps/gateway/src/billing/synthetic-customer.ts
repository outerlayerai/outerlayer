/**
 * Synthetic (test/fixture) Stripe customer detection for the metering path.
 *
 * E2E and integration fixtures seed real `billing` rows with SYNTHETIC
 * `stripe_customer_id` values that have no Stripe customer behind them:
 *   - `cus_e2e_fixture_<tenantId>` — apps/e2e/scripts/seed-staging-fixture.ts
 *   - `cus_test_<...>`             — apps/e2e/tests/utils/test-helpers.ts +
 *                                    apps/integration-tests/**
 * The gateway stamps that id onto every `otel_traces.StripeCustomerId` it
 * ingests, so fixture usage flows into the per-minute usage/storage metering
 * jobs exactly like a paying customer's. Sending it to `meterEvents.create`
 * always fails ("No such customer"), and for the usage-meter queue that failure
 * exhausts its retries and dead-letters — firing the CRITICAL
 * `usage_meter_failure` operator page for a customer that was never real. Left
 * unfiltered it buries the real under-metering alerts it exists to surface.
 *
 * These prefixes are collision-proof against real Stripe ids: a live/test-mode
 * customer id is `cus_` followed by a random `[A-Za-z0-9]` token, so it never
 * contains the second underscore both markers carry. Skipping them at every
 * metering boundary is therefore safe — no real customer is ever suppressed.
 */

/**
 * Prefixes that mark a Stripe customer id as a test/fixture stand-in. The
 * trailing underscore is what a genuine Stripe id can never reproduce (see
 * the collision note above), so it must not be trimmed.
 */
export const SYNTHETIC_STRIPE_CUSTOMER_PREFIXES = [
  'cus_test_',
  'cus_e2e_fixture_',
] as const;

/**
 * True when `id` is a synthetic test/fixture customer that must NOT be metered
 * against Stripe. Used by every metering call site (usage producer, usage-meter
 * queue consumer + DLQ, storage metering) so the convention lives in one place.
 */
export function isSyntheticStripeCustomerId(id: string): boolean {
  return SYNTHETIC_STRIPE_CUSTOMER_PREFIXES.some((prefix) =>
    id.startsWith(prefix),
  );
}
