/**
 * The node self-host composition root — assembles the `GatewayContext` from the
 * runtime-neutral adapters. This is the Node counterpart of the Worker's
 * `buildGatewayContext` (`apps/gateway/src/runtime/cloudflare-context.ts`).
 *
 * Every field is provided; "disabled" capabilities use an explicit no-op/inline
 * adapter, never `null`. The self-host story per field:
 *   - cacheL2Store  → no-op L2; the in-process L1 MemoryStore serves
 *   - billing       → grant-all unlimited (no Stripe; enforcesSubscriptionTiers=false)
 *   - logger        → stdout (no BetterStack/Sentry)
 *   - auth          → resolve the tenant from the operator's Supabase (no Unkey)
 *   - rateLimiter   → no-op (self-host enforces no request rate limits)
 *   - smtpEmailSender → real Nodemailer sender (the Worker's is `supported: false`
 *     — this is the one field where Node has MORE capability than Cloudflare)
 *
 * `execCtx` is the fire-and-forget shim core builds when a request carries no
 * Cloudflare `ExecutionContext` (see the `/v1/*` gtx middleware). Background work
 * scheduled via `waitUntil` runs detached; there is no request-outlives-response
 * guarantee on Node, which is fine for the trace insert + log flush it carries.
 */
import type { Env } from "@repo/gateway-core/types";
import type { ExecutionCtx } from "@repo/gateway-core/runtime/execution";
import type { GatewayContext } from "@repo/gateway-core/runtime/gateway-context";
import { NoopCacheStore } from "@repo/gateway-core/runtime/adapters/noop-cache-store";
import { SelfHostBillingService } from "@repo/gateway-core/runtime/adapters/self-host-billing-service";
import { NodeLogger } from "@repo/gateway-core/runtime/adapters/node-logger";
import { SelfHostAuthResolver } from "@repo/gateway-core/runtime/adapters/self-host-auth-resolver";
import { NoopRateLimiter } from "@repo/gateway-core/runtime/adapters/noop-rate-limiter";
import { NodemailerSmtpEmailSender } from "./runtime/adapters/nodemailer-smtp-sender";

export function buildGatewayContext(_env: Env, execCtx: ExecutionCtx): GatewayContext {
  const waitUntil = (promise: Promise<unknown>) => execCtx.waitUntil(promise);

  return {
    waitUntil,
    execCtx,
    cacheL2Store: new NoopCacheStore(),
    billing: new SelfHostBillingService(),
    logger: new NodeLogger(),
    auth: new SelfHostAuthResolver(),
    rateLimiter: new NoopRateLimiter(),
    // The one runtime that can actually open a raw SMTP socket — enables
    // management-API EMAIL_PROVIDER=smtp (Inbucket in local dev, a real relay
    // in self-host production).
    smtpEmailSender: new NodemailerSmtpEmailSender(),
  };
}
