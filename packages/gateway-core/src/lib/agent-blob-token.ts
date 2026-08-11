/**
 * Signed, expiring capability tokens for session-detail image references.
 *
 * Mirrors the dashboard's `features/agent-sessions/blob-url.ts` token shape
 * (same reasoning: the blob store is content-addressed, so the binding to a
 * caller has to live on the URL, not the row). The gateway's binding is
 * `{tenantId, appId, keyId}` — a machine key, not a human — because API-key
 * auth has no user identity, and a `session.read`-only key must be able to
 * fetch the images referenced in its OWN session-detail responses without
 * the `trace.read` the raw `GET /v1/agents/blob/:sha256` route requires.
 *
 * A distinct domain separator from the dashboard's token (and from
 * `lib/git-connect-state.ts`'s OAuth state token) keeps every HMAC-signed
 * envelope that shares `OAUTH_STATE_SECRET` from cross-verifying against a
 * different purpose's token.
 */
import { createSignature, verifySignature, MalformedSignatureError } from '@repo/shared-utils';

/** Same window as the dashboard's image token — long enough to read a
 * transcript end to end, short enough that a leaked URL dies quickly. */
export const AGENT_BLOB_TOKEN_TTL_SECONDS = 2 * 60 * 60;

const DOMAIN = 'gateway-agent-blob.v1';

export interface AgentBlobTokenClaims {
  tenantId: string;
  appId: string;
  /** The API key the token was minted for — the machine-key binding. */
  keyId: string;
  sha256: string;
  /** Unix seconds. */
  exp: number;
}

export type VerifyAgentBlobTokenResult =
  | { ok: true; claims: AgentBlobTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

const encoder = new TextEncoder();

function base64UrlEncode(input: string): string {
  const bytes = encoder.encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const padded = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const SIGNATURE_PREFIX = 'sha256=';

/** Mint a token for one image. `ttlSeconds`/`now` are injectable so tests can pin the window. */
export async function signAgentBlobToken(params: {
  secret: string;
  claims: Omit<AgentBlobTokenClaims, 'exp'>;
  ttlSeconds?: number;
  now?: () => number;
}): Promise<string> {
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const claims: AgentBlobTokenClaims = {
    ...params.claims,
    exp: now() + (params.ttlSeconds ?? AGENT_BLOB_TOKEN_TTL_SECONDS),
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await createSignature(params.secret, `${DOMAIN}.${payload}`);
  return `${payload}.${signature.slice(SIGNATURE_PREFIX.length)}`;
}

/**
 * Verify a token's signature, shape, and expiry. Does NOT decide whether the
 * claims match the current request — the route re-checks tenant/app/key/hash
 * against what it actually authorized.
 */
export async function verifyAgentBlobToken(params: {
  secret: string;
  token: string;
  now?: () => number;
}): Promise<VerifyAgentBlobTokenResult> {
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const parts = params.token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payload, signatureHex] = parts as [string, string];
  if (!payload || !signatureHex) return { ok: false, reason: 'malformed' };

  let signatureOk: boolean;
  try {
    signatureOk = await verifySignature(
      params.secret,
      `${SIGNATURE_PREFIX}${signatureHex}`,
      `${DOMAIN}.${payload}`,
    );
  } catch (error) {
    if (error instanceof MalformedSignatureError) return { ok: false, reason: 'malformed' };
    throw error;
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' };

  let claims: AgentBlobTokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payload)) as AgentBlobTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof claims?.tenantId !== 'string' ||
    typeof claims.appId !== 'string' ||
    typeof claims.keyId !== 'string' ||
    typeof claims.sha256 !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.exp <= now()) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}

/**
 * Stamp a token on each image ref of one span, bound to the caller's key —
 * every URL in a transcript is minted for the key that requested it, so a
 * response can never hand one key a link another key's request could replay.
 */
export async function signAgentBlobRefs(
  secret: string,
  images: { sha256: string; mediaType: string }[],
  binding: { tenantId: string; appId: string; keyId: string },
): Promise<{ sha256: string; mediaType: string; token: string }[]> {
  return Promise.all(
    images.map(async (image) => ({
      ...image,
      token: await signAgentBlobToken({ secret, claims: { ...binding, sha256: image.sha256 } }),
    })),
  );
}
