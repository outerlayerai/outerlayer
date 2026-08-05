/**
 * OAuth state token signing for the git-connect URL helper.
 *
 * The state token returned from `POST /v1/apps/:appId/git/connect` is a
 * compact, opaque, HMAC-signed envelope binding the OAuth callback to
 * the originating app + tenant + provider + a nonce, with a short TTL.
 *
 * Wire format (URL-safe base64, no padding):
 *
 *     <payload>.<sig>
 *
 * where `<payload>` is `base64url(JSON.stringify({
 *   app_id, tenant_id, provider, exp, nonce
 * }))` and `<sig>` is `base64url(HMAC_SHA256(<payload>, secret))`.
 *
 * Why HMAC and not full JWT: we own both ends (gateway mints, dashboard
 * callback verifies) and need no third-party verification. The minimal
 * envelope keeps URLs short and avoids dragging in a JWT library.
 *
 * Replay protection is stateless: the short TTL (10 min) bounds the
 * window, and the OAuth provider enforces single use on the auth code
 * itself. Nothing here needs a server-side record of issued tokens.
 *
 * Uses Web Crypto SubtleCrypto for Cloudflare Workers compatibility,
 * mirroring `lib/jwt.ts`.
 */

const encoder = new TextEncoder();

/** State token TTL — short enough that a stolen URL is useless before the user clicks. */
export const GIT_CONNECT_STATE_TTL_SECONDS = 10 * 60;

export interface GitConnectStatePayload {
  app_id: string;
  tenant_id: string;
  provider: 'github';
  /** Unix seconds. */
  exp: number;
  /** Per-token random hex. Defense-in-depth against truncation attacks. */
  nonce: string;
}

// ---------------------------------------------------------------------------
// Base64url helpers (mirror lib/jwt.ts)
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

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function randomNonce(): string {
  // 16 bytes -> 32 hex chars. Enough entropy that brute-forcing a valid
  // token within the TTL is infeasible even if the secret leaks (the
  // signature is the actual gate, but the nonce makes log-based replay
  // harder too).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Timing-safe equality on two equal-length base64url-encoded signatures.
 *
 * Returns `false` when lengths differ — short-circuiting on length is
 * acceptable here because the attacker cannot influence the signature
 * length they receive (it's always 43 chars for HMAC-SHA256 base64url).
 */
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

/**
 * Sign a state token binding the OAuth callback to a specific app + tenant.
 *
 * Returns both the wire token and the expiry timestamp so the caller can
 * surface it to the consumer (the dashboard renders an absolute deadline,
 * a CLI shows a relative "expires in N minutes").
 */
export async function signGitConnectState(params: {
  secret: string;
  appId: string;
  tenantId: string;
  provider: 'github';
  ttlSeconds?: number;
  now?: () => number;
}): Promise<{ token: string; payload: GitConnectStatePayload }> {
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const payload: GitConnectStatePayload = {
    app_id: params.appId,
    tenant_id: params.tenantId,
    provider: params.provider,
    exp: now() + (params.ttlSeconds ?? GIT_CONNECT_STATE_TTL_SECONDS),
    nonce: randomNonce(),
  };

  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(params.secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  const sigB64 = base64UrlEncode(signature);

  return { token: `${payloadB64}.${sigB64}`, payload };
}

export type VerifyGitConnectStateResult =
  | { ok: true; payload: GitConnectStatePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a state token. Returns the decoded payload on success, or a
 * structured failure tag. Callers should map all three failures to a
 * single opaque 400 — no hint about which check tripped.
 */
export async function verifyGitConnectState(params: {
  secret: string;
  token: string;
  now?: () => number;
}): Promise<VerifyGitConnectStateResult> {
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const parts = params.token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts as [string, string];

  // Recompute and timing-safe-compare the signature first. Order matters:
  // verifying signature before decoding the payload means an attacker
  // can't probe payload structure via differential errors.
  const key = await importHmacKey(params.secret);
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  const expectedB64 = base64UrlEncode(expected);
  if (!timingSafeEqualB64(sigB64, expectedB64)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Decode payload only after signature passes.
  let payload: GitConnectStatePayload;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(decoded) as GitConnectStatePayload;
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
