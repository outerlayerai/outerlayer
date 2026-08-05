/**
 * Shared API key verification logic.
 *
 * Single source of truth for Postgres key-store verification (peppered HMAC
 * digest → verify_api_key RPC), Zod validation, and optional cache-first
 * lookup. Used by the OpenAPI Hono middleware (openapi/middleware.ts).
 */

import { z } from 'zod';
import { hashApiKey } from '@repo/api-key-service';
import type { Env, GatewayCache, UserMeta } from '../types';
import { GatewayPermissionSchema, ROLE_PERMISSION_SETS } from './permissions';
import { createSupabaseAdminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Zod schema for Unkey response validation
// ---------------------------------------------------------------------------

const UserMetaSchema = z.object({
  appId: z.string().min(1),
  tenantId: z.string().min(1),
  appName: z.string().default(''),
  stripeCustomerId: z.string().default(''),
  // Identity meta legitimately holds `null` here once a subscription is
  // cancelled (see payment webhook). Tolerate null/undefined and normalize
  // to '' so downstream consumers (rate-limit tier check) keep working.
  stripeSubscriptionId: z.string().nullish().transform((v) => v ?? ''),
  branchId: z.string().default(''),
  // The environment the key is bound to, written into Unkey meta at creation.
  // The env resolver reads this off the token and skips the `api_key`-row
  // lookup. Optional: keys minted before this field existed carry no env in
  // meta and fall back to the row lookup.
  environmentId: z.string().optional(),
  // The environment KINDS this key may target when a request selects an env by
  // name/PR. NULL/absent on a legacy pinned key.
  // The resolver authorizes the selected env's kind against this set.
  allowedEnvKinds: z.array(z.string()).optional(),
  // The public api_key.api_key_id, returned by verify_api_key so the trace/score
  // ingest paths can resolve the key's bound environment.
  apiKeyId: z.string().optional(),
  // Developer-seat attribution. Membership id the key is bound to; the
  // agent-session sync endpoint stamps it as ActorId. Absent on shared keys.
  actorMembershipId: z.string().optional(),
  // Stored key rows outlive the permission VOCABULARY: a key minted before a
  // permission was retired from GATEWAY_PERMISSIONS still carries the dead
  // value in its array. A retired permission must cost that key exactly the
  // one capability and nothing else, so entries are validated individually and
  // unknown values are dropped. A strict enum over the whole array would
  // instead fail the entire verify payload and 401 every such key.
  permissions: z
    .array(z.string())
    .optional()
    .default([])
    .transform((values) => values.filter((value) => GatewayPermissionSchema.safeParse(value).success)),
});

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type VerifyKeySuccess = { ok: true; user: UserMeta };
export type VerifyKeyFailure = {
  ok: false;
  status: number;
  message: string;
  /**
   * GatewayErrorCode-compatible string. Included on every failure so the
   * wire response can carry the canonical `{ error: { code, message } }`
   * shape — matches OpenApiErrorResponseSchema and keeps Schemathesis's
   * response_schema_conformance check clean.
   */
  code: string;
};
export type VerifyKeyResult = VerifyKeySuccess | VerifyKeyFailure;

// ---------------------------------------------------------------------------
// Cache key helper
// ---------------------------------------------------------------------------

/**
 * Build a cache key for userMeta that is independent of the request route.
 * The cached value (Unkey metadata) doesn't depend on which route invoked
 * auth, so a single key per (appId, authHeader) maximizes cache hits across
 * routes for the same caller.
 */
export async function buildUserMetaCacheKey(appId: string, authHeader: string): Promise<string> {
  const material = new TextEncoder().encode(`${appId}:${authHeader}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  const digestHex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${appId}-${digestHex}`;
}

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

/**
 * Verify an API key and resolve the authenticated user metadata via the
 * Postgres key-store. When `cache` and `cacheKey` are provided, the verified
 * UserMeta is read from and written to the shared userMeta namespace, skipping
 * the RPC round-trip on subsequent calls within the TTL window.
 *
 * Returns a validated UserMeta on success or a structured error on failure.
 */
export async function verifyKey(params: {
  authHeader: string;
  appId: string;
  env: Env;
  cache?: GatewayCache;
  cacheKey?: string;
}): Promise<VerifyKeyResult> {
  const { authHeader, appId, env, cache, cacheKey } = params;

  // -------------------------------------------------------------------------
  // Cache lookup (when configured)
  //
  // Cache is a latency optimization; the key-store is authoritative. On cache
  // read errors we log and fall through to the key-store rather than failing
  // auth — a transient KV blip shouldn't lock legitimate callers out.
  // -------------------------------------------------------------------------
  if (cache && cacheKey) {
    const cached = await cache.userMeta.get(cacheKey);
    if (cached.err) {
      console.error('userMeta cache read error, falling through to key-store:', cached.err);
    } else if (cached.val) {
      return { ok: true, user: cached.val };
    }
  }

  // -------------------------------------------------------------------------
  // Verify via the Postgres key-store.
  //
  // Hash the incoming key with the pepper and look its digest up through the
  // verify_api_key RPC (SECURITY DEFINER — it reads the private.api_key_secret
  // table that the service_role client cannot select directly). One indexed
  // lookup returns the full UserMeta payload, replacing the external Unkey
  // round-trip. Rate limiting stays a separate, fail-open concern.
  // -------------------------------------------------------------------------
  // Strip the `Bearer ` scheme prefix — the digest is over the raw key alone.
  const rawKey = authHeader.replace(/^\s*Bearer\s+/i, '');

  let result: VerifyKeyResult;
  try {
    const keyDigest = await hashApiKey(rawKey, env.API_KEY_PEPPER!);
    const supabase = createSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('verify_api_key', {
      p_key_digest: keyDigest,
    });

    if (error) {
      // Store unreachable / RPC failure → 502 (same taxonomy as the old
      // "no data returned" branch): a transient DB fault isn't the caller's
      // fault, and a 401 would wrongly signal a bad key.
      console.error('verify_api_key RPC error:', error);
      return { ok: false, status: 502, message: 'Authentication service error', code: 'service_unavailable' };
    }

    if (data == null) {
      // No live key matches this digest: unknown, revoked (row deleted), or
      // expired (verify_api_key gates on expires_at).
      return { ok: false, status: 401, message: 'Not authorized', code: 'unauthorized' };
    }

    const parsed = UserMetaSchema.safeParse(data);

    // The appId cross-check ensures the verified key's bound app matches the
    // app the request targets — without it, a valid key for one app could
    // authenticate requests to another.
    if (!parsed.success || appId !== parsed.data.appId) {
      console.warn('[keystore] auth failed', {
        zodOk: parsed.success,
        appId,
      });
      return { ok: false, status: 401, message: 'Not authorized', code: 'unauthorized' };
    }

    // The RPC already carries apiKeyId (= api_key.api_key_id) so the trace/score
    // ingest paths can resolve the key's bound environment.
    result = { ok: true, user: parsed.data };
  } catch (error) {
    console.error('Error verifying API key:', error);
    return { ok: false, status: 500, message: 'Something went wrong', code: 'internal_error' };
  }

  // -------------------------------------------------------------------------
  // Cache population (on success, when configured)
  // -------------------------------------------------------------------------
  if (result.ok && cache && cacheKey) {
    await cache.userMeta.set(cacheKey, result.user);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Self-host app-identity resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an app's tenant identity directly from Supabase and grant full-access
 * permissions. Used by the node self-host `SelfHostAuthResolver` adapter — the
 * self-host runtime has no key service, so the app row IS the identity.
 *
 * This function validates only that the app exists; it verifies no secret. Any
 * caller reaching it has already been authenticated, or the operator has
 * explicitly opted into perimeter trust — `SelfHostAuthResolver` owns that
 * decision, and `apps/gateway-node/README.md` documents it. Do not call this
 * from a path that has not made the same choice.
 */
export async function resolveAppIdentity(appId: string, env: Env): Promise<VerifyKeyResult> {
  const supabase = createSupabaseAdminClient(env);

  const { data: app } = await supabase
    .from('app')
    .select('id, tenant_id, name')
    .eq('id', appId)
    .single();

  if (!app) {
    return { ok: false, status: 401, message: 'Not authorized', code: 'unauthorized' };
  }

  const { data: branch } = await supabase
    .from('git_branch')
    .select('id')
    .eq('app_id', appId)
    .limit(1)
    .single();

  // This is a machine path — no human profile, so created_by is left to the
  // set_created_columns trigger.
  return {
    ok: true,
    user: {
      appId: app.id,
      tenantId: app.tenant_id,
      appName: app.name || '',
      stripeCustomerId: '',
      stripeSubscriptionId: '',
      branchId: branch?.id || '',
      permissions: Array.from(ROLE_PERMISSION_SETS['full-access'] ?? []),
    },
  };
}

