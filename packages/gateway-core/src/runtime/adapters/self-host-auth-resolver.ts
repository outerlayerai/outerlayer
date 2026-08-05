/**
 * SelfHostAuthResolver — the node self-host `AuthResolver` adapter.
 *
 * The self-host runtime has no key service: the app row in the operator's own
 * Supabase IS the identity. This resolves the tenant from the app id via
 * `resolveAppIdentity`, as the runtime's first-class production auth path
 * (selected by composition, not an env flag).
 *
 * Because there is no key store to verify a per-key digest against, the operator
 * chooses ONE of two postures at boot (`apps/gateway-node/src/env.ts` requires
 * exactly one and refuses to start otherwise):
 *
 *   - `SELF_HOST_GATEWAY_SECRET` — every API-key request must present this
 *     value as its bearer token, compared in constant time. The secret IS the
 *     API key, so existing SDKs and the CLI work unchanged.
 *   - `SELF_HOST_TRUST_PERIMETER=true` — the operator authenticates callers at
 *     the network layer, so the gateway does not. This posture requires that
 *     the gateway port is not reachable by anyone the operator has not already
 *     authenticated; set `SELF_HOST_GATEWAY_SECRET` instead wherever that
 *     cannot be guaranteed.
 *
 * See `apps/gateway-node/README.md` for the deployment guidance behind that
 * choice. The `cache`/`cacheKey` params are ignored either way: the Supabase
 * lookup is local, so the key-store cache the Cloudflare adapter needs buys
 * nothing here. The JWT/bearer path is unaffected and stays fully
 * tenant-validated upstream.
 */
import type { AuthResolver, ResolveApiKeyParams } from "../gateway-context";
import { resolveAppIdentity, type VerifyKeyResult } from "../../lib/verify-key";
import { timingSafeEqualStrings } from "../../lib/timing-safe-compare";

/** Denial for a missing or wrong shared secret — same shape as a bad app id. */
const UNAUTHORIZED: VerifyKeyResult = {
  ok: false,
  status: 401,
  message: "Not authorized",
  code: "unauthorized",
};

export class SelfHostAuthResolver implements AuthResolver {
  resolveApiKey({ appId, env, authHeader }: ResolveApiKeyParams): Promise<VerifyKeyResult> {
    // Trimmed to agree with the boot gate, which validates the trimmed value —
    // otherwise a secret written with stray whitespace in a .env would pass the
    // length check at boot and then reject every client that sends the value the
    // operator thinks they configured.
    const secret = env.SELF_HOST_GATEWAY_SECRET?.trim();

    // No secret configured ⇒ the operator declared perimeter trust at boot.
    // Resolve on app-row existence alone, as before.
    if (!secret) return resolveAppIdentity(appId, env);

    const presented = authHeader.replace(/^\s*Bearer\s+/i, "");
    if (!timingSafeEqualStrings(presented, secret)) {
      return Promise.resolve(UNAUTHORIZED);
    }

    return resolveAppIdentity(appId, env);
  }
}
