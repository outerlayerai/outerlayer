/**
 * Bearer-JWT verification for CLI / user-authenticated gateway traffic.
 *
 * Companion to `verify-key.ts` (API-key auth). Accepts a Supabase user JWT
 * (`role: 'authenticated'`) and resolves it to the same `UserMeta` shape the
 * API-key path produces, so every downstream handler is auth-mode-agnostic.
 *
 * Design notes:
 *
 * 1. **Two signing algorithms supported.**
 *    - **HS256** (legacy): verified against `SUPABASE_JWT_SECRET`. Still
 *      used by older Supabase projects.
 *    - **ES256** (Supabase's current default): verified against JWKS
 *      fetched from `<supabase>/auth/v1/.well-known/jwks.json`. New
 *      Supabase projects are created with asymmetric keys, and existing
 *      projects switch on their own cadence, so both must be accepted for
 *      the bearer path to work against every project.
 *
 *    The algorithm is read from the JWT header; only HS256 and ES256 are
 *    accepted. Anything else (including `none`) is rejected. The JWT
 *    header declaring HS256 is verified with the symmetric secret; ES256
 *    is verified against the JWKS key whose `kid` matches the token's
 *    `kid` claim. This blocks the classic algorithm-confusion attack
 *    (sending an ES256 header against an HS256-verifier) because the
 *    secret and the public key are never interchangeable in Web Crypto.
 *
 * 2. **Role enforcement: `authenticated` only.** A user JWT minted by the
 *    gateway (`role: 'gateway'`, short-lived) must not be accepted on the
 *    public ingress — those are internal to gateway → Supabase. Reject
 *    anything that isn't `authenticated`.
 *
 * 3. **Tenant: explicit `X-Tenant-Id` header wins over the JWT claim.**
 *    The token's `app_metadata.tenant_id` is session-global — Supabase
 *    sets it when the user's "active tenant" is selected in the dashboard,
 *    and it can be stale for a user who belongs to more than one tenant.
 *    A caller that knows which tenant it is acting in sends an explicit
 *    `X-Tenant-Id`; that value takes precedence over the embedded claim.
 *    Either way the tenant is validated by the SAME active-membership
 *    check (step below), so a header naming a tenant the caller does not
 *    belong to fails closed here — it never silently falls back to the
 *    claim. A caller that sends no header keeps the claim behavior, so
 *    the CLI and any un-migrated caller are unaffected. The resolved
 *    tenant is what the `tenant_id()` SQL function reads in RLS, so
 *    downstream Supabase calls using this JWT inherit the same context.
 *
 * 4. **App ownership check.** The `X-Outerlayer-App-Id` header must point
 *    to an app whose `tenant_id` matches the resolved tenant. Verified
 *    via a service-role lookup. Without this, a user logged into tenant A
 *    could spoof activity against tenant B by supplying a different
 *    app id. One lookup per request, cacheable later if we care.
 *
 * 5. **Permissions resolved by RLS.** Unlike the API-key path which
 *    carries a `gateway_permissions` claim, bearer traffic relies on
 *    the dashboard's existing `app_authorize()` / `authorize()` RLS
 *    helpers. The returned `UserMeta` carries an empty `permissions`
 *    array; the caller (middleware) checks permission via an
 *    `app_authorize` RPC against the user's JWT, giving the same
 *    early-403 UX as API keys without duplicating permission logic
 *    in this service.
 */

import { createClient } from '@supabase/supabase-js';
import type { Env, UserMeta } from '../types';
import { createSupabaseAdminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifyBearerSuccess = {
  ok: true;
  user: UserMeta;
  /** The raw JWT, forwarded to Supabase by handlers for authenticated-role access. */
  userJwt: string;
};
export type VerifyBearerFailure = { ok: false; status: number; message: string };
export type VerifyBearerResult = VerifyBearerSuccess | VerifyBearerFailure;
export type ResolveBearerIdentitySuccess = {
  ok: true;
  claims: SupabaseUserClaims;
  userId: string;
  tenantId: string;
  userJwt: string;
};
export type ResolveBearerIdentityResult =
  | ResolveBearerIdentitySuccess
  | VerifyBearerFailure;

/** Minimal claim shape we care about. Anything else is ignored. */
interface SupabaseUserClaims {
  sub: string;
  role: string;
  exp: number;
  iat?: number;
  aud?: string;
  app_metadata?: { tenant_id?: string };
}

// ---------------------------------------------------------------------------
// JWT verification (HS256, mirrors mintGatewayJwt)
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function base64UrlDecode(input: string): Uint8Array {
  // Restore standard base64 padding + charset
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  const b64 = padded + '='.repeat(pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface JsonWebKey {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface JwksResponse {
  keys: JsonWebKey[];
}

/** JWKS fetch cache. Key: supabaseUrl. Value: {keys, fetchedAtMs}. */
const jwksCache = new Map<string, { keys: JsonWebKey[]; fetchedAtMs: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h — Supabase rotates rarely; kid mismatch triggers a refresh below

/**
 * Fetch the project's JWKS from Supabase, caching per-URL for an hour.
 * Returns null if the fetch fails; callers reject the token in that case.
 * Test-seam: the module-level Map is exposed via `_resetJwksCache()`.
 */
async function fetchJwks(supabaseUrl: string): Promise<JsonWebKey[] | null> {
  const cached = jwksCache.get(supabaseUrl);
  if (cached && Date.now() - cached.fetchedAtMs < JWKS_TTL_MS) {
    return cached.keys;
  }
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (!response.ok) return null;
    const json = (await response.json()) as JwksResponse;
    if (!Array.isArray(json.keys)) return null;
    jwksCache.set(supabaseUrl, { keys: json.keys, fetchedAtMs: Date.now() });
    return json.keys;
  } catch {
    return null;
  }
}

/** Test-seam: clear JWKS cache between tests. */
export function _resetJwksCache(): void {
  jwksCache.clear();
}

/**
 * Verify a Supabase-issued JWT and return its payload if valid.
 *
 * Accepts HS256 (legacy symmetric) and ES256 (current asymmetric via
 * JWKS). Returns null on any validation failure (bad shape, unknown
 * alg, bad signature, expired). Callers never see the raw exception —
 * auth failures are all surfaced uniformly as 401 by the middleware.
 *
 * Signature: `(env, token)` rather than `(secret, token)` so ES256
 * verification can fetch JWKS from `env.SUPABASE_API_BASE_URL`. The
 * symmetric secret is pulled from `env.SUPABASE_JWT_SECRET` only when
 * the header says HS256.
 */
export async function verifyBearerJwt(
  env: { SUPABASE_JWT_SECRET?: string; SUPABASE_API_BASE_URL: string },
  token: string,
): Promise<SupabaseUserClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // -- Decode header + enforce alg --
  let header: { alg?: string; typ?: string; kid?: string };
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(headerB64)));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' && header.alg !== 'ES256') return null;

  const signingInput = `${headerB64}.${payloadB64}`;

  // Decode signature BEFORE the verify step — a malformed base64 input
  // (e.g. `Bearer <header>.<payload>.!@#$`) would otherwise escape as an
  // `InvalidCharacterError` and surface as a Hono 500 instead of the
  // uniform 401 this module promises. Catch the decode here and treat
  // it as any other "bad token" failure.
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(signatureB64);
  } catch {
    return null;
  }

  let signatureValid = false;

  if (header.alg === 'HS256') {
    // -- Symmetric verify with SUPABASE_JWT_SECRET --
    if (!env.SUPABASE_JWT_SECRET) return null;
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.SUPABASE_JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      signatureValid = await crypto.subtle.verify(
        'HMAC',
        key,
        signatureBytes,
        encoder.encode(signingInput),
      );
    } catch {
      return null;
    }
  } else {
    // -- Asymmetric verify via JWKS --
    let jwks = await fetchJwks(env.SUPABASE_API_BASE_URL);
    if (!jwks) return null; // Fetch failed — don't retry within one request.
    const matchesKid = (keys: JsonWebKey[]) =>
      keys.find((k) => k.kid === header.kid && k.kty === 'EC' && k.crv === 'P-256');
    let jwk = matchesKid(jwks);
    // Self-heal on kid-miss: a Supabase signing-key rotation mid-TTL
    // would otherwise fail every bearer request for up to an hour
    // because the cached key set never refreshes. Invalidate and
    // refetch once before giving up. Only triggered when the fetch
    // itself succeeded — a failed fetch returns null above.
    if (!jwk) {
      jwksCache.delete(env.SUPABASE_API_BASE_URL);
      const refreshed = await fetchJwks(env.SUPABASE_API_BASE_URL);
      if (!refreshed) return null;
      jwk = matchesKid(refreshed);
    }
    if (!jwk) return null;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        jwk as unknown as globalThis.JsonWebKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      signatureValid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        signatureBytes,
        encoder.encode(signingInput),
      );
    } catch {
      return null;
    }
  }

  if (!signatureValid) return null;

  // -- Decode + validate payload --
  let payload: SupabaseUserClaims;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64))) as SupabaseUserClaims;
  } catch {
    return null;
  }
  if (!payload.sub || !payload.role || typeof payload.exp !== 'number') return null;

  // -- Expiry (no clock skew tolerance — Supabase JWTs are 1h, plenty of slack) --
  if (payload.exp * 1000 <= Date.now()) return null;

  return payload;
}

/**
 * User-facing 401 message for a bearer token that verified as one of ours
 * but has expired. Distinguished from the generic "Not authorized" so a
 * caller (CLI, MCP server, a `curl` REST-fallback script) gets an
 * actionable cause instead of hunting for a missing/misconfigured
 * credential. Expiry is the one auth failure safe to disclose: it reveals
 * nothing about authz state (tenant, membership) or another principal.
 */
export const SESSION_EXPIRED_MESSAGE =
  'Session expired — refresh your credentials (e.g. run `outerlayer login`) and retry.';

/**
 * Best-effort: does this token's payload carry an `exp` already in the past?
 *
 * Decodes the payload WITHOUT verifying the signature. Used ONLY to refine a
 * failure message (expired vs generic) on a path that has ALREADY decided to
 * reject — never to grant access. A forged token with a past `exp` also reads
 * as expired, which is harmless: the request still 401s and the message
 * discloses nothing about signature validity. Returns false for anything not
 * cleanly decodable, so the caller falls back to the opaque "Not authorized".
 *
 * Exported as a pure test seam (like `_resetJwksCache`) so every branch —
 * numeric/string/missing exp, malformed base64, non-JSON — is killed by a
 * direct unit test rather than only the indirect resolveBearerUser path.
 */
export function isExpiredToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(decoder.decode(base64UrlDecode(parts[1] as string))) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bearer-path user resolution
// ---------------------------------------------------------------------------

/**
 * UUID-shaped sentinel used for `user.appId` on tenant-scoped routes
 * (POST /v1/apps, GET /v1/apps) where there's no real app context. Any
 * downstream code that accidentally reads it will not match any real
 * row by `id`, so it fails closed.
 */
export const TENANT_SCOPED_APP_ID_SENTINEL = '00000000-0000-0000-0000-000000000000';

/**
 * Resolve a valid user JWT to a `UserMeta`. Validates:
 *
 *   - The JWT's `role` claim is exactly `authenticated`.
 *   - A tenant is resolvable — from an explicit `X-Tenant-Id` header when
 *     present, otherwise the JWT's `app_metadata.tenant_id` claim.
 *   - When `appId` is provided: the header identifies an app in the
 *     resolved tenant. Tenant-scoped routes (e.g. `POST /v1/apps`
 *     first-create where no app exists yet) call with `appId: null` to
 *     skip this lookup — the resolved tenant is the only scope they need.
 *   - The JWT's `sub` has an active membership row for the resolved tenant.
 *
 * On success, returns a `UserMeta` with empty `permissions` (authz is
 * enforced by RLS via the same JWT forwarded downstream). On any failure,
 * returns an opaque 401 — no hint about which check tripped.
 */
export async function resolveBearerUser(params: {
  env: Env;
  token: string;
  /**
   * App ID from the `X-Outerlayer-App-Id` header. Pass `null` for
   * tenant-scoped routes that operate at the tenant level and have no
   * relevant app context (POST /v1/apps, GET /v1/apps). The
   * `app_authorize()` permission RPC downstream then runs without an
   * app filter — the route handler still scopes by the resolved
   * `tenant_id`, and RLS enforces tenant isolation at the DB layer.
   */
  appId: string | null;
  /**
   * Value of the `X-Tenant-Id` request header, or undefined when the
   * caller sent none. Forwarded to `resolveBearerIdentity`, where a
   * present value overrides the JWT claim (validated by the same
   * membership check) and undefined preserves the claim behavior.
   */
  requestTenantId?: string;
}): Promise<VerifyBearerResult> {
  const { env, token, appId, requestTenantId } = params;

  const identity = await resolveBearerIdentity({ env, token, requestTenantId });
  if (!identity.ok) {
    return identity;
  }

  // Tenant-scoped fast path: no app lookup, return identity-only context.
  // The route handler reads `user.tenantId` and never
  // dereferences `user.appId` — see `apps.ts::getTenantScope` which
  // ignores `user.appId` entirely. The all-zero UUID sentinel satisfies
  // the `VerifiedAppId` brand (`createVerifiedAppId` rejects empty
  // strings) and is structurally invalid as a real app id, so any
  // downstream code that accidentally reads it will not match any real
  // row — it fails closed rather than leaking across tenants.
  if (appId === null) {
    const user: UserMeta = {
      appId: TENANT_SCOPED_APP_ID_SENTINEL,
      tenantId: identity.tenantId,
      appName: '',
      stripeCustomerId: '',
      stripeSubscriptionId: '',
      branchId: '',
      gatewayUserId: identity.userId,
      permissions: [],
    };
    return { ok: true, user, userJwt: identity.userJwt };
  }

  const admin = createSupabaseAdminClient(env);
  const appResult = await admin
    .from('app')
    .select('id, tenant_id, name')
    .eq('id', appId)
    .eq('tenant_id', identity.tenantId)
    .single();

  if (appResult.error || !appResult.data) {
    return { ok: false, status: 401, message: 'Not authorized' };
  }

  const user: UserMeta = {
    appId: appResult.data.id,
    tenantId: appResult.data.tenant_id,
    appName: appResult.data.name ?? '',
    stripeCustomerId: '',
    stripeSubscriptionId: '',
    branchId: '',
    gatewayUserId: identity.userId,
    // Permissions resolved by RLS downstream. Middleware does an
    // `app_authorize()` RPC with the user JWT for early-403 UX.
    permissions: [],
  };

  return { ok: true, user, userJwt: identity.userJwt };
}

/**
 * Resolve a valid bearer token to the caller's user/tenant identity.
 *
 * This is the shared authentication primitive for internal bearer-authenticated
 * routes. It validates the JWT, enforces `role: authenticated`, resolves the
 * request tenant (explicit `X-Tenant-Id` header over the JWT claim), and
 * confirms the user has an active membership in that tenant.
 */
export async function resolveBearerIdentity(params: {
  env: Env;
  token: string;
  /**
   * Value of the `X-Tenant-Id` request header, or undefined when the
   * caller sent none. When present it selects the tenant this request
   * acts in, overriding the token's embedded `app_metadata.tenant_id`
   * claim. The same active-membership check validates it, so a header
   * naming a tenant the caller does not belong to — or a malformed one —
   * fails closed rather than falling back to the claim. Undefined
   * preserves the claim behavior for un-migrated callers.
   */
  requestTenantId?: string;
}): Promise<ResolveBearerIdentityResult> {
  const { env, token, requestTenantId } = params;

  if (!env.SUPABASE_API_BASE_URL) {
    console.error('[bearer] SUPABASE_API_BASE_URL is not configured');
    return { ok: false, status: 500, message: 'Authentication service misconfigured' };
  }

  const claims = await verifyBearerJwt(env, token);
  if (!claims) {
    // Refine the message for an expired-but-otherwise-ours token; every
    // other rejection (bad signature, wrong alg, malformed) stays opaque.
    return {
      ok: false,
      status: 401,
      message: isExpiredToken(token) ? SESSION_EXPIRED_MESSAGE : 'Not authorized',
    };
  }

  // Only accept end-user JWTs. Rejects:
  //   - gateway-role JWTs minted internally (role: 'gateway')
  //   - service_role keys (role: 'service_role')
  //   - anon keys (role: 'anon')
  // All three have legitimate uses elsewhere, but none should be a valid
  // inbound bearer on the public API.
  if (claims.role !== 'authenticated') {
    return { ok: false, status: 401, message: 'Not authorized' };
  }

  // An explicit X-Tenant-Id header selects the tenant this request acts
  // in and overrides the token's session-global claim; both paths are
  // validated by the membership check below, so a header present but
  // empty/malformed/non-member denies here rather than falling back to
  // the claim. Absent header (undefined) keeps the claim behavior.
  const tenantId =
    requestTenantId !== undefined ? requestTenantId : claims.app_metadata?.tenant_id;
  if (!tenantId) {
    return { ok: false, status: 401, message: 'Not authorized' };
  }

  const admin = createSupabaseAdminClient(env);
  const membershipResult = await admin
    .from('membership')
    .select('id')
    .eq('user_id', claims.sub)
    .eq('tenant_id', tenantId)
    // Restrict to active memberships — pending invitations must NOT pass
    // auth. Without this filter, a user with a pending (invited-but-
    // unaccepted) membership would pass resolveBearerUser and any
    // unmapped /v1/* route would grant access. This also aligns with
    // `get_user_membership_id()` (see 02-functions-core.sql) which is
    // what `app_authorize()` consults downstream.
    .eq('status', 'active')
    .single();

  if (membershipResult.error || !membershipResult.data) {
    return { ok: false, status: 401, message: 'Not authorized' };
  }

  return {
    ok: true,
    claims,
    userId: claims.sub,
    tenantId,
    userJwt: token,
  };
}

// ---------------------------------------------------------------------------
// Early permission check via `app_authorize` RPC
// ---------------------------------------------------------------------------

/**
 * Check whether the user JWT has a given permission for the target app.
 *
 * Runs the Supabase `app_authorize` function as the user — the same
 * function the dashboard's RLS policies consult. Single source of truth
 * for permission logic; no duplicate check in this service.
 *
 * Returns `true` if authorized, `false` otherwise. Network / RPC failures
 * fail closed (return `false`) — an auth server error should not grant
 * access.
 */
export async function checkBearerPermission(params: {
  env: Env;
  userJwt: string;
  permission: string;
  appId: string;
  /**
   * The request's resolved tenant. Attached as `X-Tenant-Id` so the
   * `app_authorize` RPC resolves the app and the actor's role under the
   * SAME tenant the request acts in — otherwise the RPC runs under the JWT
   * claim and cannot see an app in a header-resolved tenant, yielding a
   * spurious deny. The DB re-validates membership, so it can't widen scope.
   */
  requestTenantId?: string;
}): Promise<boolean> {
  const { env, userJwt, permission, appId, requestTenantId } = params;

  const userClient = bearerPermissionClientFactory.create(env, userJwt, requestTenantId);

  try {
    const { data, error } = await userClient.rpc('app_authorize', {
      requested_permission: permission,
      target_app_id: appId,
    });
    if (error) {
      console.error('[bearer] app_authorize RPC failed:', error.message);
      return false;
    }
    return data === true;
  } catch (e) {
    console.error('[bearer] app_authorize RPC threw:', e);
    return false;
  }
}

export const bearerPermissionClientFactory = {
  create(env: Env, userJwt: string, requestTenantId?: string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${userJwt}` };
    // Scope the `app_authorize` RPC to the request's resolved tenant via the
    // DB's dual-source resolver; absent ⇒ the JWT claim serves, as before.
    if (requestTenantId) headers['X-Tenant-Id'] = requestTenantId;
    return createClient(env.SUPABASE_API_BASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers },
    });
  },
};

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * Extract a bearer token from the Authorization header, or null if the
 * header is missing / malformed / not a Bearer scheme / not JWT-shaped.
 * Case-insensitive on the scheme per RFC 7235.
 *
 * Both JWTs and Unkey API keys arrive as `Authorization: Bearer <x>`, so
 * we route by JWT's structural signature (RFC 7519): exactly three
 * dot-separated base64url segments. Anything else — e.g. Unkey keys
 * like `sk_outerlayer_...` — returns null here so the middleware falls
 * through to the API-key path instead of failing JWT-decode and 401ing.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^\s*Bearer\s+(\S.*?)\s*$/i);
  if (!match) return null;
  const token = match[1]!;
  if (token.split('.').length !== 3) return null;
  return token;
}
