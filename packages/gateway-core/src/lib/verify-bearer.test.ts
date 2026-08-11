/**
 * Unit tests for the bearer-JWT verification path.
 *
 * Coverage:
 *
 * - verifyBearerJwt: valid HS256, expired, wrong alg, wrong signature,
 *   malformed shape, missing required claims, tampered payload.
 * - extractBearerToken: scheme variations, case-insensitivity,
 *   missing/empty headers, garbage.
 * - resolveBearerUser: happy path, bad signature → 401, expired → 401,
 *   wrong role → 401, missing tenant → 401, missing SUPABASE_JWT_SECRET
 *   → 500, unknown app → 401, cross-tenant app → 401, missing membership
 *   → 401.
 * - checkBearerPermission: true pass-through, false pass-through,
 *   RPC error fail-closed, thrown error fail-closed.
 *
 * Mints JWTs in-test using the same helper (`mintGatewayJwt`) that the
 * production sign path uses — that way signature + verify are symmetric
 * at the Web Crypto level and we're not hand-signing in tests.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import {
  seedGatewaySupabaseMswState,
} from '../test-helpers/msw-handlers';
import * as verifyBearerModule from './verify-bearer';
import {
  verifyBearerJwt,
  extractBearerToken,
  resolveBearerUser,
  checkBearerPermission,
  _resetJwksCache,
  SESSION_EXPIRED_MESSAGE,
  isExpiredToken,
} from './verify-bearer';
import { mintGatewayJwt } from './jwt';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum-sz';
const TEST_USER_ID = 'a7f3b9c2-4d5e-6f7a-8b9c-0d1e2f3a4b5c';
const TEST_TENANT_ID = 'b8c4d9a2-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
const TEST_APP_ID = 'c9d5e1b3-6f7a-8b9c-0d1e-2f3a4b5c6d7e';

const FAKE_ENV = {
  SUPABASE_JWT_SECRET: TEST_SECRET,
  SUPABASE_API_BASE_URL: 'http://localhost:54321',
  SUPABASE_SECRET_KEY: 'sr-test',
  SUPABASE_PUBLISHABLE_KEY: 'anon-test',
} as unknown as Env;

/**
 * Mint a Supabase-shaped user JWT using Web Crypto. Mirrors what Supabase
 * Auth itself produces: `role: 'authenticated'`, `app_metadata.tenant_id`.
 */
async function mintUserJwt(opts: {
  sub?: string;
  tenantId?: string;
  role?: string;
  ttlSeconds?: number;
  /** When set, mints a token shaped like Supabase's OAuth server output
   * (a connector token) — same claims otherwise, since that's the point:
   * it must be indistinguishable except for this one claim. */
  clientId?: string;
} = {}): Promise<string> {
  const sub = opts.sub ?? TEST_USER_ID;
  const tenantId = opts.tenantId;
  const role = opts.role ?? 'authenticated';
  const ttl = opts.ttlSeconds ?? 3600;

  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    sub,
    role,
    aud: 'authenticated',
    iat,
    exp: iat + ttl,
    ...(tenantId !== undefined ? { app_metadata: { tenant_id: tenantId } } : {}),
    ...(opts.clientId !== undefined ? { client_id: opts.clientId } : {}),
  };

  const enc = new TextEncoder();
  const b64 = (s: string) =>
    btoa(unescape(encodeURIComponent(s)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(TEST_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const bytes = new Uint8Array(sigBuf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const sigB64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${signingInput}.${sigB64}`;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  seedGatewaySupabaseMswState({
    apps: [{ id: TEST_APP_ID, tenant_id: TEST_TENANT_ID, name: 'Test App' }],
    memberships: [{
      id: 'membership-1',
      user_id: TEST_USER_ID,
      tenant_id: TEST_TENANT_ID,
      status: 'active',
    }],
  });
});

// ============================================================================
// verifyBearerJwt
// ============================================================================

describe('verifyBearerJwt', () => {
  it('returns the decoded payload on a valid HS256 token', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await verifyBearerJwt(FAKE_ENV,token);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe(TEST_USER_ID);
    expect(result!.role).toBe('authenticated');
    expect(result!.app_metadata?.tenant_id).toBe(TEST_TENANT_ID);
  });

  it('returns null for a token signed with a different secret', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await verifyBearerJwt({ ...FAKE_ENV, SUPABASE_JWT_SECRET: 'wrong-secret-zzzzzzzzzzzzzzzzzzzzzz' } as Env, token);
    expect(result).toBeNull();
  });

  it('returns null for a tampered payload (signature no longer matches)', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const parts = token.split('.');
    // Swap the payload with a longer one; the original signature can't match.
    const tampered = `${parts[0]}.${btoa('{"sub":"attacker","role":"authenticated","exp":9999999999}')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${parts[2]}`;
    const result = await verifyBearerJwt(FAKE_ENV,tampered);
    expect(result).toBeNull();
  });

  it('returns null for an expired token', async () => {
    // ttl=-1 means exp is 1s in the past
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID, ttlSeconds: -1 });
    const result = await verifyBearerJwt(FAKE_ENV,token);
    expect(result).toBeNull();
  });

  it('returns null for a token with alg != HS256 (alg:none attack)', async () => {
    // Hand-craft an unsigned token with alg:none
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = btoa(JSON.stringify({ sub: TEST_USER_ID, role: 'authenticated', exp: 9999999999 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unsignedToken = `${header}.${payload}.`;
    const result = await verifyBearerJwt(FAKE_ENV,unsignedToken);
    expect(result).toBeNull();
  });

  it('returns null for malformed JWT shape (wrong number of segments)', async () => {
    expect(await verifyBearerJwt(FAKE_ENV,'not.a.jwt.extra')).toBeNull();
    expect(await verifyBearerJwt(FAKE_ENV,'onlyonepart')).toBeNull();
    expect(await verifyBearerJwt(FAKE_ENV,'two.parts')).toBeNull();
    expect(await verifyBearerJwt(FAKE_ENV,'')).toBeNull();
  });

  it('returns null when sub claim is missing', async () => {
    // Hand-craft: no sub, valid signature
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = { role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
    const enc = new TextEncoder();
    const b64 = (s: string) =>
      btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(TEST_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
    const bytes = new Uint8Array(sigBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    const sig = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${signingInput}.${sig}`;
    expect(await verifyBearerJwt(FAKE_ENV,token)).toBeNull();
  });

  it('accepts a gateway-minted JWT signature but will fail role check downstream', async () => {
    // This test proves verifyBearerJwt only checks signature + minimal
    // shape. The role enforcement happens in resolveBearerUser.
    const gatewayToken = await mintGatewayJwt(TEST_SECRET, TEST_TENANT_ID, TEST_USER_ID, []);
    const result = await verifyBearerJwt(FAKE_ENV,gatewayToken);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('gateway');
  });
});

// ============================================================================
// isExpiredToken — pure, unverified expiry decode used to refine the 401 message
// ============================================================================

describe('isExpiredToken', () => {
  // Build a 3-segment token with an arbitrary payload. No real signature —
  // isExpiredToken decodes the payload WITHOUT verifying, by design.
  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tokenWithPayload = (payloadJson: string) =>
    `${b64url('{"alg":"HS256"}')}.${b64url(payloadJson)}.${b64url('sig')}`;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true for a numeric exp in the past', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(isExpiredToken(tokenWithPayload(`{"exp":${past}}`))).toBe(true);
  });

  it('returns false for a numeric exp in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isExpiredToken(tokenWithPayload(`{"exp":${future}}`))).toBe(false);
  });

  it('returns true at the exact boundary exp*1000 === now (kills <= → <)', () => {
    // Pin the clock to exactly the token's exp so `<=` (expired) and `<`
    // (not expired) diverge — the only input that distinguishes them.
    const expSeconds = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(expSeconds * 1000);
    expect(isExpiredToken(tokenWithPayload(`{"exp":${expSeconds}}`))).toBe(true);
  });

  it('returns false when exp is a STRING, even if it looks past (kills typeof === → !==)', () => {
    // A string "1" would pass `* 1000 <= now` if the typeof guard were
    // inverted; the `=== 'number'` guard must reject it as not-expired.
    expect(isExpiredToken(tokenWithPayload('{"exp":"1"}'))).toBe(false);
  });

  it('returns false when exp is missing entirely', () => {
    expect(isExpiredToken(tokenWithPayload('{"sub":"u1"}'))).toBe(false);
  });

  it('returns false (no throw) when the payload segment is invalid base64 (kills catch true→false)', () => {
    // `@@@` is not decodable base64url → base64UrlDecode throws → the catch
    // must yield false (not expired), never true.
    expect(isExpiredToken('aaa.@@@.bbb')).toBe(false);
  });

  it('returns false (no throw) when the payload decodes but is not JSON', () => {
    expect(isExpiredToken(`${b64url('{}')}.${b64url('not json at all')}.${b64url('s')}`)).toBe(false);
  });

  it('returns false for a token without exactly three segments', () => {
    expect(isExpiredToken('only.two')).toBe(false);
    expect(isExpiredToken('a.b.c.d')).toBe(false);
    expect(isExpiredToken('')).toBe(false);
  });

  it('rejects on the segment-count guard, not just the decode catch (kills the guard removal)', () => {
    // A 2-segment string whose ONLY segment after the first is a valid,
    // past-exp JSON payload: if the `parts.length !== 3` guard were
    // removed, the decoder would read parts[1] and report expired=true.
    // The guard must short-circuit to false first.
    const past = Math.floor(Date.now() / 1000) - 60;
    const twoSegmentWithValidPayload = `${b64url('{"alg":"HS256"}')}.${b64url(`{"exp":${past}}`)}`;
    expect(isExpiredToken(twoSegmentWithValidPayload)).toBe(false);
  });
});

// ============================================================================
// extractBearerToken
// ============================================================================

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('BEARER abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('tolerates leading/trailing whitespace around the header value', () => {
    expect(extractBearerToken('  Bearer   abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it('returns null for non-Bearer schemes', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    // A raw API key (no scheme) is NOT a Bearer — callers should fall through to the Unkey path.
    expect(extractBearerToken('am_someapikey')).toBeNull();
  });

  it('returns null for missing / empty / whitespace-only headers', () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('   ')).toBeNull();
    // "Bearer" with no token part
    expect(extractBearerToken('Bearer ')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
  });

  it('returns null for Bearer values that are not JWT-shaped', () => {
    // Both JWTs and Unkey API keys arrive as `Authorization: Bearer <x>`.
    // Unkey keys are opaque single strings — they must return null here
    // so the middleware falls through to the API-key path instead of
    // being routed into JWT verification and 401ing.
    expect(extractBearerToken('Bearer sk_outerlayer_Fixture000000000000002')).toBeNull();
    expect(extractBearerToken('Bearer only.two')).toBeNull();
    expect(extractBearerToken('Bearer too.many.parts.here')).toBeNull();
  });
});

// ============================================================================
// resolveBearerUser
// ============================================================================

describe('resolveBearerUser', () => {
  it('returns a well-formed UserMeta on the happy path', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });

    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: TEST_APP_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.user.appId).toBe(TEST_APP_ID);
    expect(result.user.tenantId).toBe(TEST_TENANT_ID);
    expect(result.user.gatewayUserId).toBe(TEST_USER_ID);
    expect(result.user.appName).toBe('Test App');
    expect(result.user.permissions).toEqual([]);
    // The JWT is forwarded so handlers can reuse it for Supabase calls.
    expect(result.userJwt).toBe(token);
  });

  it('rejects a token signed with a different secret (401) with the OPAQUE message', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: { ...FAKE_ENV, SUPABASE_JWT_SECRET: 'different-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxx' } as Env,
      token,
      appId: TEST_APP_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
    // A bad signature must NOT leak as "expired" — only genuine expiry of
    // an otherwise-valid token gets the actionable message. A
    // forged token's exp is attacker-controlled, but here the future-exp
    // token fails on signature, so the generic message is correct.
    expect(result.message).toBe('Not authorized');
  });

  it('rejects an expired token (401) with the actionable SESSION_EXPIRED_MESSAGE', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID, ttlSeconds: -1 });
    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: TEST_APP_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
    // A validly-signed-but-expired session is distinguished
    // from the generic rejection so the caller knows to re-authenticate.
    expect(result.message).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('rejects a token with role != "authenticated" (401) — including internal gateway JWTs', async () => {
    // A gateway-minted JWT with role:'gateway' has a valid signature, correct
    // shape, and non-expired — but must not be accepted on the public ingress.
    const gatewayToken = await mintGatewayJwt(TEST_SECRET, TEST_TENANT_ID, TEST_USER_ID, ['trace.read']);
    const result = await resolveBearerUser({ env: FAKE_ENV, token: gatewayToken, appId: TEST_APP_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('rejects when the JWT has no app_metadata.tenant_id (401)', async () => {
    const token = await mintUserJwt({ /* tenantId intentionally omitted */ });
    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: TEST_APP_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('returns 500 when SUPABASE_API_BASE_URL is not configured', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: { ...FAKE_ENV, SUPABASE_API_BASE_URL: undefined } as unknown as Env,
      token,
      appId: TEST_APP_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(500);
  });

  it('401s an HS256 token when SUPABASE_JWT_SECRET is missing (verifier rejects at sig verify)', async () => {
    // ES256 path works with just SUPABASE_API_BASE_URL (JWKS), but an
    // HS256 token without the secret configured must not verify.
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: { ...FAKE_ENV, SUPABASE_JWT_SECRET: undefined } as unknown as Env,
      token,
      appId: TEST_APP_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('rejects when the appId does not exist (401)', async () => {
    seedGatewaySupabaseMswState({ apps: [] });
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: TEST_APP_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('rejects when the appId belongs to a different tenant (401)', async () => {
    seedGatewaySupabaseMswState({
      apps: [{ id: 'other-tenants-app-id', tenant_id: 'different-tenant', name: 'Other App' }],
    });
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: 'other-tenants-app-id' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('rejects when the user has no membership in the tenant (401)', async () => {
    seedGatewaySupabaseMswState({ memberships: [] });
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: TEST_APP_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  // Review gap: without an explicit status='active' filter, pending
  // (invited-but-unaccepted) memberships pass auth. The mock returns
  // no row for the status='active' query shape, which simulates the DB
  // correctly filtering out pending rows. This test asserts the call
  // chain and makes the test suite fail if someone drops the status
  // filter (the resulting .eq(user).eq(tenant) chain would return a
  // pending-membership row in production).
  it('rejects when the user membership status is not active (401)', async () => {
    seedGatewaySupabaseMswState({
      memberships: [{
        id: 'membership-pending',
        user_id: TEST_USER_ID,
        tenant_id: TEST_TENANT_ID,
        status: 'pending',
      }],
    });
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: TEST_APP_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  // base64UrlDecode(signatureB64) must run INSIDE the try/catch that wraps
  // the crypto verify. Outside it, a malformed signature (valid header +
  // payload shape, junk base64 in the signature slot) escapes as an
  // InvalidCharacterError and becomes a Hono 500 instead of the uniform
  // 401 this module promises.
  it('returns null (→ 401) for a token with malformed base64 signature, not a 500', async () => {
    // Build a syntactically valid JWT shape: real header + real payload,
    // but replace the signature with non-base64 garbage.
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const [h, p] = token.split('.');
    const malformed = `${h}.${p}.!@#not$valid%base64`;
    const result = await verifyBearerJwt(FAKE_ENV, malformed);
    expect(result).toBeNull();
  });
});

// ============================================================================
// resolveBearerUser — connector (OAuth) token confinement
//
// A connector token is a normal `role: authenticated` JWT plus a
// `client_id` claim. `allowConnectorToken` defaults to false, so any bearer
// surface that doesn't explicitly opt in (every REST route) rejects it;
// only the MCP mounts pass `allowConnectorToken: true`.
// ============================================================================
describe('resolveBearerUser — connector token confinement', () => {
  it('rejects a connector token (401, opaque) when allowConnectorToken is unset', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID, clientId: 'connector-abc' });
    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: TEST_APP_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
    expect(result.message).toBe('Not authorized');
  });

  it('rejects a connector token (401) when allowConnectorToken is explicitly false', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID, clientId: 'connector-abc' });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      allowConnectorToken: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('accepts a connector token when allowConnectorToken is true (the MCP-mount case)', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID, clientId: 'connector-abc' });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      allowConnectorToken: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.user.appId).toBe(TEST_APP_ID);
    expect(result.user.gatewayUserId).toBe(TEST_USER_ID);
  });

  it('still accepts an ordinary (non-connector) token when allowConnectorToken is true', async () => {
    // allowConnectorToken widens what's ACCEPTED, it never narrows —
    // dashboard-session tokens on an MCP mount must keep working.
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      allowConnectorToken: true,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a connector token with an empty-string client_id claim (forged/degenerate shape)', async () => {
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID, clientId: '' });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      allowConnectorToken: true,
    });
    // An empty client_id is not a valid connector marker (isConnectorToken
    // requires non-empty), so this is just an ordinary authenticated token
    // — it must still succeed, not be treated as "connector, rejected".
    expect(result.ok).toBe(true);
  });

  it('still enforces role != authenticated on a connector-shaped token', async () => {
    const forged = await mintUserJwt({
      tenantId: TEST_TENANT_ID,
      role: 'service_role',
      clientId: 'connector-abc',
    });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token: forged,
      appId: TEST_APP_ID,
      allowConnectorToken: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });
});

// ============================================================================
// resolveBearerUser — explicit request tenant (X-Tenant-Id)
// ============================================================================

describe('resolveBearerUser — explicit request tenant', () => {
  // A user who belongs to two tenants. The JWT claim names TENANT A (the
  // "active tenant"); the request header can name either. This is exactly
  // the multi-org caller a stale claim would misroute.
  const TENANT_B = 'd0e6f2c4-7a8b-9c0d-1e2f-3a4b5c6d7e8f';
  const APP_IN_B = 'e1f7a3d5-8b9c-0d1e-2f3a-4b5c6d7e8f90';

  function seedTwoOrgUser() {
    seedGatewaySupabaseMswState({
      apps: [
        { id: TEST_APP_ID, tenant_id: TEST_TENANT_ID, name: 'App A' },
        { id: APP_IN_B, tenant_id: TENANT_B, name: 'App B' },
      ],
      memberships: [
        { id: 'm-a', user_id: TEST_USER_ID, tenant_id: TEST_TENANT_ID, status: 'active' },
        { id: 'm-b', user_id: TEST_USER_ID, tenant_id: TENANT_B, status: 'active' },
      ],
    });
  }

  it('resolves the header tenant over the JWT claim for a two-org member', async () => {
    seedTwoOrgUser();
    // Claim says A; header says B; the user belongs to both. The request
    // must act in B (the header) and resolve B's app.
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: APP_IN_B,
      requestTenantId: TENANT_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.user.tenantId).toBe(TENANT_B);
    expect(result.user.appId).toBe(APP_IN_B);
    expect(result.user.appName).toBe('App B');
  });

  it('scopes a tenant-scoped create (appId: null) to the header tenant, not the claim', async () => {
    seedTwoOrgUser();
    // The wrong-tenant-write class: a first-create with claim A but header
    // B must land in B — this is the exact bug the explicit header closes.
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: null,
      requestTenantId: TENANT_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.user.tenantId).toBe(TENANT_B);
  });

  it('hard-denies a header naming a non-member tenant — never falls back to the valid claim', async () => {
    // Default seed: member of A only, claim A (valid + member, so the
    // claim path WOULD succeed). A header naming an unrelated tenant must
    // 401, proving the header is committed to and not silently downgraded.
    const NON_MEMBER_TENANT = 'f2a8b4c6-9c0d-1e2f-3a4b-5c6d7e8f9012';
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      requestTenantId: NON_MEMBER_TENANT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('treats an empty-string header as present-but-invalid (401), not absent', async () => {
    // An empty header is a present header with no resolvable tenant. It must
    // fail closed, NOT degrade to the claim path (which would succeed here).
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      requestTenantId: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('preserves the claim behavior when no header is sent (undefined)', async () => {
    // Default seed: member of A, app A, claim A. No header ⇒ the claim
    // alone decides the tenant.
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      // requestTenantId omitted on purpose
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.user.tenantId).toBe(TEST_TENANT_ID);
  });

  it('runs the app-ownership cross-check against the header tenant, not the claim', async () => {
    seedTwoOrgUser();
    // App A lives in tenant A. The header names tenant B (the user belongs
    // to both). The app is checked against B, so an app that lives in A is
    // denied under a B header — the cross-check follows the resolved tenant.
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID, // lives in A, not B
      requestTenantId: TENANT_B,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });
});

// ============================================================================
// resolveBearerUser — app-scoped tenant fallback (per-app MCP mount)
// ============================================================================

describe('resolveBearerUser — app-scoped tenant fallback', () => {
  it('derives the tenant from the app row when fallback is enabled and neither header nor claim resolves one', async () => {
    const token = await mintUserJwt({ /* no tenantId claim */ });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      appScopedTenantFallback: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.user.tenantId).toBe(TEST_TENANT_ID);
    expect(result.user.appId).toBe(TEST_APP_ID);
  });

  it('still 401s when the user has no active membership in the derived tenant', async () => {
    seedGatewaySupabaseMswState({ memberships: [] });
    const token = await mintUserJwt({});
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      appScopedTenantFallback: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
    expect(result.message).toBe('Not authorized');
  });

  it('401s when the fallback appId does not exist', async () => {
    seedGatewaySupabaseMswState({ apps: [] });
    const token = await mintUserJwt({});
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      appScopedTenantFallback: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('the X-Tenant-Id header still wins over the fallback when both are available', async () => {
    const TENANT_B = 'd0e6f2c4-7a8b-9c0d-1e2f-3a4b5c6d7e8f';
    const APP_IN_B = 'e1f7a3d5-8b9c-0d1e-2f3a-4b5c6d7e8f90';
    seedGatewaySupabaseMswState({
      apps: [
        { id: TEST_APP_ID, tenant_id: TEST_TENANT_ID, name: 'App A' },
        { id: APP_IN_B, tenant_id: TENANT_B, name: 'App B' },
      ],
      memberships: [
        { id: 'm-a', user_id: TEST_USER_ID, tenant_id: TEST_TENANT_ID, status: 'active' },
        { id: 'm-b', user_id: TEST_USER_ID, tenant_id: TENANT_B, status: 'active' },
      ],
    });
    // No claim, but an explicit header naming tenant B. The fallback would
    // derive A from the app row — the header must win instead.
    const token = await mintUserJwt({});
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      requestTenantId: TENANT_B,
      appScopedTenantFallback: true,
    });
    expect(result.ok).toBe(false); // TEST_APP_ID lives in tenant A, not B
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('the JWT claim still wins over the fallback when the claim is populated', async () => {
    // The requested app lives in TENANT_B, but the claim names TENANT_A —
    // the user is a member of both. If the claim correctly wins, the
    // resolved tenant is A, and the app-ownership cross-check (app is in B,
    // not A) then denies. If the fallback wrongly overrode the claim, it
    // would derive B straight from the app row — trivially matching its own
    // app and succeeding. Denial here proves the claim, not the fallback,
    // decided the tenant.
    const TENANT_B = 'd0e6f2c4-7a8b-9c0d-1e2f-3a4b5c6d7e8f';
    const APP_IN_B = 'e1f7a3d5-8b9c-0d1e-2f3a-4b5c6d7e8f90';
    seedGatewaySupabaseMswState({
      apps: [
        { id: TEST_APP_ID, tenant_id: TEST_TENANT_ID, name: 'App A' },
        { id: APP_IN_B, tenant_id: TENANT_B, name: 'App B' },
      ],
      memberships: [
        { id: 'm-a', user_id: TEST_USER_ID, tenant_id: TEST_TENANT_ID, status: 'active' },
        { id: 'm-b', user_id: TEST_USER_ID, tenant_id: TENANT_B, status: 'active' },
      ],
    });
    const token = await mintUserJwt({ tenantId: TEST_TENANT_ID });
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: APP_IN_B,
      appScopedTenantFallback: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('an empty-string X-Tenant-Id header still 401s without trying the fallback', async () => {
    // A present-but-empty header is a deliberate bad signal, not "nothing
    // sent" — it must not degrade into the fallback lookup.
    const token = await mintUserJwt({});
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: TEST_APP_ID,
      requestTenantId: '',
      appScopedTenantFallback: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });

  it('fallback DISABLED (default) preserves the exact current 401 — no header, no claim, no fallback', async () => {
    const token = await mintUserJwt({ /* no tenantId claim */ });
    const result = await resolveBearerUser({ env: FAKE_ENV, token, appId: TEST_APP_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
    expect(result.message).toBe('Not authorized');
  });

  it('fallback has no effect when appId is null (tenant-scoped routes never enable it in practice, but pin the behavior anyway)', async () => {
    const token = await mintUserJwt({});
    const result = await resolveBearerUser({
      env: FAKE_ENV,
      token,
      appId: null,
      appScopedTenantFallback: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(401);
  });
});

// ============================================================================
// checkBearerPermission
// ============================================================================

// ============================================================================
// ES256 / JWKS path
// ============================================================================

describe('verifyBearerJwt — ES256 / JWKS path', () => {
  // Generate an ES256 keypair once; mint tokens + serve JWKS from it.
  let es256KeyPair: {
    privateKey: globalThis.CryptoKey;
    publicKey: globalThis.CryptoKey;
  };
  let publicJwk: globalThis.JsonWebKey;
  const KID = 'test-es256-key';

  beforeAll(async () => {
    es256KeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    publicJwk = await crypto.subtle.exportKey('jwk', es256KeyPair.publicKey);
  });

  async function mintEs256Token(opts: {
    sub?: string;
    tenantId?: string;
    role?: string;
    ttlSeconds?: number;
  } = {}): Promise<string> {
    const header = { alg: 'ES256', typ: 'JWT', kid: KID };
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
      sub: opts.sub ?? TEST_USER_ID,
      role: opts.role ?? 'authenticated',
      aud: 'authenticated',
      iat,
      exp: iat + (opts.ttlSeconds ?? 3600),
      ...(opts.tenantId !== undefined ? { app_metadata: { tenant_id: opts.tenantId } } : {}),
    };
    const b64 = (s: string) =>
      btoa(unescape(encodeURIComponent(s)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      es256KeyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const bytes = new Uint8Array(sigBuf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const sig = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${signingInput}.${sig}`;
  }

  // Every ES256 test fetches JWKS — stub global fetch + reset the cache so
  // each test has a clean slate.
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetJwksCache();
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        keys: [{ ...publicJwk, kid: KID, alg: 'ES256', use: 'sig' }],
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('verifies a valid ES256 token via JWKS', async () => {
    const token = await mintEs256Token({ tenantId: TEST_TENANT_ID });
    const result = await verifyBearerJwt(FAKE_ENV, token);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe(TEST_USER_ID);
    expect(result!.role).toBe('authenticated');
    expect(mockFetch).toHaveBeenCalledWith(
      `${FAKE_ENV.SUPABASE_API_BASE_URL}/auth/v1/.well-known/jwks.json`,
    );
  });

  it('caches JWKS — second call does not re-fetch', async () => {
    const token = await mintEs256Token({ tenantId: TEST_TENANT_ID });
    await verifyBearerJwt(FAKE_ENV, token);
    await verifyBearerJwt(FAKE_ENV, token);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  // If Supabase rotates signing keys mid-TTL, the cached JWKS does not
  // contain the new kid. The verifier must invalidate
  // the cache and refetch on kid-miss — otherwise bearer auth fails
  // for up to an hour with no self-healing.
  it('invalidates the cache and refetches JWKS when kid does not match', async () => {
    // Generate a second keypair — will be introduced "after rotation"
    const rotatedKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    );
    const rotatedPublicJwk = await crypto.subtle.exportKey('jwk', rotatedKeyPair.publicKey);
    const ROTATED_KID = 'rotated-es256-key';

    // First request: JWKS returns only the original key, and the token
    // is signed with it — should cache and verify successfully.
    const originalToken = await mintEs256Token({ tenantId: TEST_TENANT_ID });
    const firstResult = await verifyBearerJwt(FAKE_ENV, originalToken);
    expect(firstResult).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();

    // Mint a token with the NEW kid, signed with the rotated private key.
    const header = { alg: 'ES256', typ: 'JWT', kid: ROTATED_KID };
    const payload = {
      sub: TEST_USER_ID,
      role: 'authenticated',
      app_metadata: { tenant_id: TEST_TENANT_ID },
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const b64 = (s: string) =>
      btoa(unescape(encodeURIComponent(s)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      rotatedKeyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const bytes = new Uint8Array(sigBuf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const sig = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const rotatedToken = `${signingInput}.${sig}`;

    // Now the JWKS endpoint returns BOTH the original and rotated keys —
    // simulating Supabase having rotated. The first refetch on kid-miss
    // should pick up the rotated key and verify successfully.
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        keys: [
          { ...publicJwk, kid: KID, alg: 'ES256', use: 'sig' },
          { ...rotatedPublicJwk, kid: ROTATED_KID, alg: 'ES256', use: 'sig' },
        ],
      }),
    });

    const rotatedResult = await verifyBearerJwt(FAKE_ENV, rotatedToken);
    expect(rotatedResult).not.toBeNull();
    expect(rotatedResult!.sub).toBe(TEST_USER_ID);
    // Two fetches total: initial cache populate + refetch on kid miss
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null when the kid does not match any JWKS key', async () => {
    // Mint a token whose kid points at a key the JWKS doesn't have
    const header = { alg: 'ES256', typ: 'JWT', kid: 'unknown-kid' };
    const payload = {
      sub: TEST_USER_ID, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      es256KeyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const bytes = new Uint8Array(sigBuf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const sig = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${signingInput}.${sig}`;

    const result = await verifyBearerJwt(FAKE_ENV, token);
    expect(result).toBeNull();
  });

  it('returns null when JWKS fetch fails (network / 500)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const token = await mintEs256Token({ tenantId: TEST_TENANT_ID });
    const result = await verifyBearerJwt(FAKE_ENV, token);
    expect(result).toBeNull();
  });

  it('returns null for ES256 token with tampered payload (signature no longer matches)', async () => {
    const token = await mintEs256Token({ tenantId: TEST_TENANT_ID });
    const parts = token.split('.');
    const tamperedPayload = btoa('{"sub":"attacker","role":"authenticated","exp":9999999999}')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const result = await verifyBearerJwt(FAKE_ENV, tampered);
    expect(result).toBeNull();
  });

  it('rejects algorithm-confusion: HS256 header with secret that matches the JWKS public key material', async () => {
    // Classic attack: sign a token with HS256 using the PUBLIC KEY bytes
    // as the secret. A naive verifier that trusted the header's alg
    // would accept it. Our verifier uses alg to DISPATCH, and HS256
    // goes through env.SUPABASE_JWT_SECRET — unrelated to the JWKS
    // public key. So the attack cannot succeed by construction.
    const pubKeyBytes = new TextEncoder().encode(JSON.stringify(publicJwk));
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = { sub: 'attacker', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
    const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
    const key = await crypto.subtle.importKey('raw', pubKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
    const bytes = new Uint8Array(sigBuf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    const sig = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const confusedToken = `${signingInput}.${sig}`;

    const result = await verifyBearerJwt(FAKE_ENV, confusedToken);
    expect(result).toBeNull(); // signature doesn't match SUPABASE_JWT_SECRET, so it's just "bad HS256"
  });
});

describe('checkBearerPermission', () => {
  it('returns true when app_authorize returns true', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    vi.spyOn(verifyBearerModule.bearerPermissionClientFactory, 'create').mockReturnValue({ rpc } as any);
    const ok = await checkBearerPermission({
      env: FAKE_ENV,
      userJwt: 'user-jwt',
      permission: 'trace.read',
      appId: TEST_APP_ID,
    });
    expect(ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('app_authorize', {
      requested_permission: 'trace.read',
      target_app_id: TEST_APP_ID,
    });
  });

  it('returns false when app_authorize returns false', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
    vi.spyOn(verifyBearerModule.bearerPermissionClientFactory, 'create').mockReturnValue({ rpc } as any);
    const ok = await checkBearerPermission({
      env: FAKE_ENV,
      userJwt: 'user-jwt',
      permission: 'trace.write',
      appId: TEST_APP_ID,
    });
    expect(ok).toBe(false);
  });

  it('fails closed (returns false) on RPC error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'network blip' } });
    vi.spyOn(verifyBearerModule.bearerPermissionClientFactory, 'create').mockReturnValue({ rpc } as any);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await checkBearerPermission({
      env: FAKE_ENV,
      userJwt: 'user-jwt',
      permission: 'trace.read',
      appId: TEST_APP_ID,
    });
    expect(ok).toBe(false);
    consoleSpy.mockRestore();
  });

  it('fails closed on thrown exception', async () => {
    const rpc = vi.fn().mockImplementation(() => {
      throw new Error('client exploded');
    });
    vi.spyOn(verifyBearerModule.bearerPermissionClientFactory, 'create').mockReturnValue({ rpc } as any);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await checkBearerPermission({
      env: FAKE_ENV,
      userJwt: 'user-jwt',
      permission: 'trace.read',
      appId: TEST_APP_ID,
    });
    expect(ok).toBe(false);
    consoleSpy.mockRestore();
  });

  it('passes the request tenant to the RPC client so app_authorize resolves under it', async () => {
    // The permission RPC must run under the resolved tenant, not the JWT
    // claim — otherwise a header-resolved app is invisible and denies.
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const createSpy = vi
      .spyOn(verifyBearerModule.bearerPermissionClientFactory, 'create')
      .mockReturnValue({ rpc } as any);
    await checkBearerPermission({
      env: FAKE_ENV,
      userJwt: 'user-jwt',
      permission: 'trace.read',
      appId: TEST_APP_ID,
      requestTenantId: 'header-tenant',
    });
    expect(createSpy).toHaveBeenCalledWith(FAKE_ENV, 'user-jwt', 'header-tenant');
  });

  it('returns false for any non-true data value — guards against null/undefined coercion', async () => {
    for (const value of [null, undefined, 'true', 1, {}]) {
      const rpc = vi.fn().mockResolvedValue({ data: value, error: null });
      vi.spyOn(verifyBearerModule.bearerPermissionClientFactory, 'create').mockReturnValue({ rpc } as any);
      const ok = await checkBearerPermission({
        env: FAKE_ENV,
        userJwt: 'user-jwt',
        permission: 'trace.read',
        appId: TEST_APP_ID,
      });
      expect(ok).toBe(false);
    }
  });
});
