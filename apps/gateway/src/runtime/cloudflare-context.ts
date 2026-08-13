/**
 * The Cloudflare/hosted composition root — assembles the `GatewayContext` from
 * the CF adapters. This is the Worker's `buildGatewayContext`; the Node one
 * (Step 5) lives in `apps/gateway-node`. Stays Worker-side after the Step 4
 * package split (it names concrete CF impls).
 *
 * Every field is provided. Billing is intrinsic to the hosted Worker — it always
 * injects `StripeBillingService`; the "no billing" path is the node self-host
 * entrypoint, which injects `SelfHostBillingService` via its own root. There is
 * no `BILLING_ENABLED` env gate: the runtime you deploy IS the billing choice.
 */
import type { Env } from "@repo/gateway-core/types";
import type { ExecutionCtx } from "@repo/gateway-core/runtime/execution";
import type { GatewayContext } from "@repo/gateway-core/runtime/gateway-context";
import { NotSupportedSmtpEmailSender } from "@repo/gateway-core/runtime/adapters/not-supported-smtp-sender";
import { createCloudflareCacheStore } from "./adapters/cloudflare-cache-store";
import { StripeBillingService } from "./adapters/stripe-billing-service";
import { WorkerLogger } from "./adapters/worker-logger";
import { CloudflareAuthResolver } from "./adapters/cloudflare-auth-resolver";
import { CloudflareRateLimiter } from "./adapters/cloudflare-rate-limiter";

export function buildGatewayContext(env: Env, execCtx: ExecutionCtx): GatewayContext {
  const waitUntil = (promise: Promise<unknown>) => execCtx.waitUntil(promise);

  return {
    waitUntil,
    execCtx,
    cacheL2Store: createCloudflareCacheStore(env),
    billing: new StripeBillingService(env),
    logger: new WorkerLogger(env, execCtx),
    auth: new CloudflareAuthResolver(),
    rateLimiter: new CloudflareRateLimiter(env),
    // Workers cannot open raw SMTP sockets — management-API EMAIL_PROVIDER=smtp
    // fails closed at config-validation time (see NotSupportedSmtpEmailSender).
    smtpEmailSender: new NotSupportedSmtpEmailSender(),
  };
}
