/**
 * Signed, expiring capability tokens for content-addressed transcript image
 * bytes — shared by the dashboard's `agent-blob` route (bound to
 * `{tenantId, appId, userId}`, a seated member) and the gateway's
 * (bound to `{tenantId, appId, keyId}`, a machine key with no user identity).
 *
 * Why a token rather than an actor column: the bytes are content-addressed —
 * identical images from many sessions collapse to one ClickHouse row and one
 * object-storage key, so there is nowhere on the stored row to put "whose
 * copy is this". A signature sits ABOVE both stores, which leaves content
 * addressing intact. Without it the sha256 alone is the capability, so a
 * hash that escapes into a log line, an export, or browser history stays
 * usable by anyone with tenant access forever; the token binds the URL to
 * one caller and one window, and a leaked URL dies at `exp`.
 *
 * Each host's `BlobTokenPort` fixes the domain separator and the identity
 * field(s) a binding carries, so a token minted for one host's purpose can
 * never verify as the other host's, or as an unrelated signed envelope
 * sharing the same secret (e.g. an OAuth state token).
 */
import { createSignature, verifySignature, MalformedSignatureError } from '@repo/shared-utils';

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

/** `createSignature` returns a `sha256=`-prefixed header; the token carries the hex only. */
const SIGNATURE_PREFIX = 'sha256=';

export interface SignedBlobRef {
  sha256: string;
  mediaType: string;
  token: string;
}

export type VerifyBlobTokenResult<Claims> =
  | { ok: true; claims: Claims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * One host's token shape: the domain separator, the default TTL, and which
 * fields on `Binding` a token binds identity to (checked present as strings
 * on verify — the same fail-closed shape check a hand-written per-field
 * `typeof` list would do, generalized over the field names).
 */
export interface BlobTokenPort<Binding extends Record<string, string>> {
  domain: string;
  ttlSeconds: number;
  bindingKeys: readonly (keyof Binding & string)[];
}

/** Mint a token for one image. `ttlSeconds`/`now` are injectable so tests can pin the window. */
export async function signBlobToken<Binding extends Record<string, string>>(
  port: BlobTokenPort<Binding>,
  params: {
    secret: string;
    claims: Binding & { sha256: string };
    ttlSeconds?: number;
    now?: () => number;
  },
): Promise<string> {
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const claims = { ...params.claims, exp: now() + (params.ttlSeconds ?? port.ttlSeconds) };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await createSignature(params.secret, `${port.domain}.${payload}`);
  return `${payload}.${signature.slice(SIGNATURE_PREFIX.length)}`;
}

/**
 * Verify a token's signature, shape, and expiry. Does NOT decide whether the
 * claims match the current request — the route re-checks tenant/app/binding
 * and hash against what it actually authorized.
 *
 * Signature is checked before the payload is parsed: reporting envelope
 * problems from an unsigned payload would let a caller probe the shape
 * without ever forging the HMAC.
 */
export async function verifyBlobToken<Binding extends Record<string, string>>(
  port: BlobTokenPort<Binding>,
  params: { secret: string; token: string; now?: () => number },
): Promise<VerifyBlobTokenResult<Binding & { sha256: string; exp: number }>> {
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
      `${port.domain}.${payload}`,
    );
  } catch (error) {
    // A non-hex / odd-length signature is a malformed token, not a server
    // fault. A missing secret is a misconfiguration and must keep throwing.
    if (error instanceof MalformedSignatureError) return { ok: false, reason: 'malformed' };
    throw error;
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' };

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const bindingOk = port.bindingKeys.every((key) => typeof claims?.[key] === 'string');
  if (!bindingOk || typeof claims?.sha256 !== 'string' || typeof claims?.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if ((claims.exp as number) <= now()) return { ok: false, reason: 'expired' };

  return { ok: true, claims: claims as Binding & { sha256: string; exp: number } };
}

/**
 * Stamp a token on each image ref of one span, bound to the caller's
 * identity — every URL in a transcript is minted for the caller who
 * requested it, so a response can never hand one caller a link another
 * caller's request could replay.
 */
export async function signBlobRefs<Binding extends Record<string, string>>(
  port: BlobTokenPort<Binding>,
  secret: string,
  images: { sha256: string; mediaType: string }[],
  binding: Binding,
): Promise<SignedBlobRef[]> {
  return Promise.all(
    images.map(async (image) => ({
      ...image,
      token: await signBlobToken(port, { secret, claims: { ...binding, sha256: image.sha256 } }),
    })),
  );
}
