/**
 * Verify HMAC-signed OAuth state tokens minted by the gateway's
 * POST /v1/apps/:appId/git/connect.
 *
 * Mirror of `apps/gateway/src/lib/git-connect-state.ts::verifyGitConnectState`.
 * Duplicated rather than shared because the two halves live in different
 * runtimes (Workers vs Node) and the wire format is stable enough that
 * drift risk is low. If we ever change the envelope, both files need to
 * move together — there's a one-line cross-reference in each.
 *
 * Wire format (matches gateway exactly):
 *
 *     <base64url(payload)>.<base64url(HMAC_SHA256(payload, secret))>
 *
 * where payload = JSON({ app_id, tenant_id, provider, exp, nonce }).
 */

// Not marked `server-only` to keep the module unit-testable under vitest's
// jsdom env. It's effectively server-only by usage — the secret it consumes
// (`OAUTH_STATE_SECRET`) is only exposed via `config-global.server.ts`, so
// any client component that tried to call this would fail at the secret
// import, not here.

const encoder = new TextEncoder();

export interface SignedGitConnectStatePayload {
  app_id: string;
  tenant_id: string;
  provider: 'github';
  /** Unix seconds. */
  exp: number;
  /** Per-token random hex. */
  nonce: string;
}

type VerifySignedGitConnectStateResult =
  | { ok: true; payload: SignedGitConnectStatePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqualB64(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifySignedGitConnectState(params: {
  secret: string;
  token: string;
  now?: () => number;
}): Promise<VerifySignedGitConnectStateResult> {
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const parts = params.token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts as [string, string];
  if (!payloadB64 || !sigB64) return { ok: false, reason: 'malformed' };

  // Verify signature first — order matters. A leak via differential
  // payload-shape errors before signature check would let an attacker
  // probe the envelope without forging the HMAC.
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(params.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  const expectedB64 = base64UrlEncode(expected);
  if (!timingSafeEqualB64(sigB64, expectedB64)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: SignedGitConnectStatePayload;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(decoded) as SignedGitConnectStatePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof payload.app_id !== 'string' ||
    typeof payload.tenant_id !== 'string' ||
    payload.provider !== 'github' ||
    typeof payload.exp !== 'number' ||
    typeof payload.nonce !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.exp <= now()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Format detection
//
// The OAuth callbacks accept only the signed envelope "<payload>.<sig>": it
// contains exactly one "." and both segments are base64url-shaped. Any state
// that fails this shape is rejected by the callback, so a false positive here
// is still caught by the signature check that follows.
// ---------------------------------------------------------------------------

const SIGNED_STATE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function looksLikeSignedGitConnectState(state: string | null | undefined): boolean {
  if (!state) return false;
  const parts = state.split('.');
  if (parts.length !== 2) return false;
  const [a, b] = parts as [string, string];
  if (!a || !b) return false;
  return SIGNED_STATE_SEGMENT_RE.test(a) && SIGNED_STATE_SEGMENT_RE.test(b);
}
