import "server-only";

/**
 * resolveBillingConfig — the Stripe billing toggle.
 *
 * Decides whether billing is enabled. The hosted product keeps Stripe; a
 * self-hoster turns it off with `BILLING_ENABLED=false`, after which org
 * creation skips Stripe customer provisioning and the dashboard wires the
 * no-op `MockBillingService`. Pure: the caller passes the already-read
 * `BILLING_ENABLED` env string in, so the decision is unit-testable without
 * reloading the env module.
 *
 * Built on {@link @repo/adapter-config}'s `resolveToggle` so the enabled shape
 * matches every other migration seam. Unlike the email seam (opt-in), billing
 * is opt-OUT: it stays enabled unless `BILLING_ENABLED` is explicitly falsy
 * (`defaultEnabled: true`) so the hosted default is unchanged.
 */

import { resolveToggle } from '@repo/adapter-config';

type BillingBackend = 'stripe';

/** The env value this resolver reads. Optional; raw env string. */
interface BillingEnv {
  BILLING_ENABLED?: string;
}

interface BillingConfig {
  /** When false, wire the no-op `MockBillingService` and skip Stripe customer creation. */
  enabled: boolean;
}

const BILLING_BACKENDS = ['stripe'] as const;

export function resolveBillingConfig(env: BillingEnv): BillingConfig {
  const { enabled } = resolveToggle<BillingBackend>({
    enabledOverride: env.BILLING_ENABLED,
    backends: BILLING_BACKENDS,
    // Billing stays on for the hosted product. A self-hoster must explicitly
    // set BILLING_ENABLED=false to disable Stripe.
    defaultEnabled: true,
  });
  return { enabled };
}
