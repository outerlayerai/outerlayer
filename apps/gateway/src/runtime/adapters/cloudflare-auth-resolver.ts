/**
 * CloudflareAuthResolver — the hosted `AuthResolver` adapter.
 *
 * Verifies programmatic API keys against the Postgres key-store via the shared
 * `verifyKey` (which also handles the identity cache). This is a thin adapter:
 * the params shape IS `verifyKey`'s, so it just forwards. The node self-host
 * runtime injects `SelfHostAuthResolver` instead, which resolves identity from
 * the app row with no key-store lookup.
 */
import type {
  AuthResolver,
  ResolveApiKeyParams,
} from "@repo/gateway-core/runtime/gateway-context";
import { verifyKey, type VerifyKeyResult } from "@repo/gateway-core/lib/verify-key";

export class CloudflareAuthResolver implements AuthResolver {
  resolveApiKey(params: ResolveApiKeyParams): Promise<VerifyKeyResult> {
    return verifyKey(params);
  }
}
