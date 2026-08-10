/**
 * Signed, expiring capability tokens for the transcript image blob route
 * (`api/orgs/{orgName}/apps/{appId}/agents/blob/{sha256}`).
 *
 * Why a token rather than an actor column: the bytes are content-addressed —
 * identical images from many sessions collapse to one ClickHouse row and one
 * object-storage key (`agentBlobKey(tenantId, appId, sha256)`), so there is
 * nowhere on the stored row to put "whose copy is this". A signature sits
 * ABOVE both stores, which leaves content addressing intact.
 *
 * What the signature buys: without it the sha256 alone is the capability, so
 * a hash that escapes into a log line, an export, or browser history stays
 * usable by any member of the tenant forever. The token binds the URL to one
 * person and one window; a leaked URL dies at `exp`.
 *
 * Secret: the deployment's `OAUTH_STATE_SECRET`, which both the dashboard and
 * the gateway already require at 32+ chars. Every signed message here is
 * prefixed with `DOMAIN`, so a token minted for this route can never verify
 * as a git-connect state token (or the reverse) even though the key is shared.
 *
 * Kept free of `server-only` so it stays unit-testable under vitest's jsdom
 * env; effectively server-only by usage, since the secret reaches it from
 * `config-global.server`.
 */
import { createSignature, verifySignature, MalformedSignatureError } from "@repo/shared-utils";

/**
 * How long a minted image URL stays valid. Long enough to read a transcript
 * end to end (images below the fold load lazily, so the clock has to outlast
 * scrolling and reading), short enough that a hash captured in a log or a
 * pasted link is dead well before anyone finds it. A page left open past the
 * window renders the expired-image placeholder; a reload re-mints.
 */
export const AGENT_BLOB_URL_TTL_SECONDS = 2 * 60 * 60;

/**
 * Domain separator. It is part of the signed message, never the token, so a
 * signature is only ever valid for the purpose it was minted for.
 */
const DOMAIN = "agent-blob.v1";

/** Everything the serve route re-checks against the request it received. */
interface AgentBlobClaims {
  tenantId: string;
  appId: string;
  /** The auth user the URL was minted for — the "person" half of the binding. */
  userId: string;
  sha256: string;
  /** Unix seconds. */
  exp: number;
}

type VerifyAgentBlobTokenResult =
  | { ok: true; claims: AgentBlobClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

const encoder = new TextEncoder();

function base64UrlEncode(input: string): string {
  const bytes = encoder.encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** `createSignature` returns a `sha256=`-prefixed header; the token carries the hex only. */
const SIGNATURE_PREFIX = "sha256=";

/**
 * Mint a token for one image. `ttlSeconds`/`now` are injectable so tests can
 * pin the window instead of sleeping.
 */
export async function signAgentBlobToken(params: {
  secret: string;
  claims: Omit<AgentBlobClaims, "exp">;
  ttlSeconds?: number;
  now?: () => number;
}): Promise<string> {
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const claims: AgentBlobClaims = {
    ...params.claims,
    exp: now() + (params.ttlSeconds ?? AGENT_BLOB_URL_TTL_SECONDS),
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await createSignature(params.secret, `${DOMAIN}.${payload}`);
  return `${payload}.${signature.slice(SIGNATURE_PREFIX.length)}`;
}

/**
 * Verify a token's signature, shape, and expiry. Returns the claims; it does
 * NOT decide whether they match the request — the route compares them against
 * the tenant/app/user it authorized, so this stays a pure crypto seam.
 *
 * Signature is checked before the payload is parsed: reporting envelope
 * problems from an unsigned payload would let a caller probe the shape
 * without ever forging the HMAC.
 */
export async function verifyAgentBlobToken(params: {
  secret: string;
  token: string;
  now?: () => number;
}): Promise<VerifyAgentBlobTokenResult> {
  const now = params.now ?? (() => Math.floor(Date.now() / 1000));
  const parts = params.token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, signatureHex] = parts as [string, string];
  if (!payload || !signatureHex) return { ok: false, reason: "malformed" };

  let signatureOk: boolean;
  try {
    signatureOk = await verifySignature(
      params.secret,
      `${SIGNATURE_PREFIX}${signatureHex}`,
      `${DOMAIN}.${payload}`,
    );
  } catch (error) {
    // A non-hex / odd-length signature is a malformed token, not a server
    // fault. A missing secret is a misconfiguration and must keep throwing.
    if (error instanceof MalformedSignatureError) return { ok: false, reason: "malformed" };
    throw error;
  }
  if (!signatureOk) return { ok: false, reason: "bad_signature" };

  let claims: AgentBlobClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payload)) as AgentBlobClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims?.tenantId !== "string" ||
    typeof claims.appId !== "string" ||
    typeof claims.userId !== "string" ||
    typeof claims.sha256 !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp <= now()) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}

/** An image ref as stored on a span, plus the token that unlocks its bytes. */
interface SignedImageRef {
  sha256: string;
  mediaType: string;
  token: string;
}

/**
 * Stamp a token on each image ref of one span. Every URL in a transcript is
 * minted for the caller who requested that transcript, so a response can
 * never hand one member a link another member's browser could replay.
 */
export async function signImageRefs(
  secret: string,
  images: { sha256: string; mediaType: string }[],
  binding: { tenantId: string; appId: string; userId: string },
): Promise<SignedImageRef[]> {
  return Promise.all(
    images.map(async (image) => ({
      ...image,
      token: await signAgentBlobToken({ secret, claims: { ...binding, sha256: image.sha256 } }),
    })),
  );
}
