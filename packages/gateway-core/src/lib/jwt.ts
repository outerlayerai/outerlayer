/**
 * Mint short-lived gateway JWTs for tenant-scoped Supabase access.
 * Uses Web Crypto API (SubtleCrypto) — zero npm dependencies, Workers-compatible.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Standard base64url encoding: replace +→-, /→_, strip trailing =.
 */
function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived gateway JWT for tenant-scoped Supabase access.
 *
 * The resulting token carries claims consumed by two layers:
 * - DB layer: PostgREST switches into the `gateway` Postgres role, and the
 *   `gateway_tenant_*` RLS policies read `app_metadata.tenant_id` via the
 *   `tenant_id()` SQL function. `sub` is the gateway system user — a valid FK
 *   target for created_by/updated_by audit columns.
 * - API layer: Hono middleware reads `gateway_permissions` and authorizes
 *   each request against the route's `requiredPermission` before any DB call.
 *
 * TTL is 60 seconds — enough for a single request round-trip.
 *
 * WARNING: This JWT must never be passed to Supabase `auth.*` APIs
 * (`supabase.auth.getUser()`, `signInWithIdToken`, etc.). `role: 'gateway'` is
 * not a role the auth server recognises, and `aud: 'authenticated'` is set for
 * PostgREST/SDK shape compatibility only. Use only for PostgREST / storage
 * REST calls via `createTenantScopedClient`.
 */
export async function mintGatewayJwt(
  secret: string,
  tenantId: string,
  systemUserId: string,
  permissions: string[],
): Promise<string> {
  // -- Header --
  const header = { alg: 'HS256', typ: 'JWT' };

  // -- Payload --
  // role: 'gateway' — PostgREST switches into the dedicated `gateway` Postgres
  // role for the duration of the request. Tenant isolation is enforced by RLS
  // on that role; gateway_permissions are enforced at the Hono middleware layer.
  //
  // aud: 'authenticated' — Supabase convention. PostgREST itself does not
  // enforce an `aud` check (no PGRST_JWT_AUD in the Supabase PostgREST image),
  // but Supabase Auth helpers that decode JWTs expect this audience. Keeping
  // it as 'authenticated' prevents shape drift from the SDK's expectations
  // even though only PostgREST ever validates this token.
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    role: 'gateway',
    iss: 'gateway',
    sub: systemUserId,
    app_metadata: { tenant_id: tenantId },
    gateway_permissions: permissions,
    iat,
    exp: iat + 60,
  };

  // -- Encode header.payload --
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // -- Sign with HMAC-SHA256 via Web Crypto --
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));

  // -- Assemble JWT --
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
