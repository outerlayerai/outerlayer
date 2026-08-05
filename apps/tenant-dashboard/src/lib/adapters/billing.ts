import "server-only";

/**
 * The Stripe billing seam, re-exported for `features/billing/service.ts` and
 * `lib/system/organization-service.ts`.
 *
 * `createBillingService`/`resolveBillingConfig` (`@/lib/external-services`,
 * `@/lib/external-services/billing-config`) stay in place — they're also consumed by the
 * webhook route, org creation, and membership services, none of which move
 * as part of this slice. This is the one sanctioned crossing so the feature
 * layer's own `no-restricted-imports` rail (new-world code never reaches
 * `src/services/**` directly) doesn't have to be lifted for those other
 * call sites too. The `StripeService` type is re-exported alongside it for
 * callers that only need the interface shape (e.g. to type a constructor
 * parameter) without constructing a client themselves.
 */
export { createBillingService, type StripeService } from "@/lib/external-services";
export { resolveBillingConfig } from "@/lib/external-services/billing-config";
