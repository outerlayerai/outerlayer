/**
 * Signed, expiring capability tokens for the transcript image blob route
 * (`api/orgs/{orgName}/apps/{appId}/agents/blob/{sha256}`).
 *
 * The token shape and the signing/verification logic live in
 * `@repo/observability-service`'s `blob-tokens.ts`, shared with the
 * gateway's equivalent (`lib/agent-blob-token.ts`) — both mint the same kind
 * of content-address-bound capability token, differing only in domain
 * separator and which identity field the binding carries (`userId` here vs
 * the gateway's `keyId`). This module fixes the dashboard's half of that
 * port: the domain, the TTL, and the `{tenantId, appId, userId}` binding.
 *
 * Secret: the deployment's `OAUTH_STATE_SECRET`, which both the dashboard and
 * the gateway already require at 32+ chars. Domain separation keeps every
 * signed message that shares the secret from cross-verifying against a
 * different purpose's token — this route's tokens can never verify as a
 * git-connect state token (`lib/git-connect-state.ts`) or the gateway's blob
 * token, or the reverse.
 *
 * Kept free of `server-only` so it stays unit-testable under vitest's jsdom
 * env; effectively server-only by usage, since the secret reaches it from
 * `config-global.server`.
 */
import {
  signBlobToken,
  verifyBlobToken,
  signBlobRefs,
  type BlobTokenPort,
  type SignedBlobRef,
  type VerifyBlobTokenResult,
} from "@repo/observability-service";

/**
 * How long a minted image URL stays valid. Long enough to read a transcript
 * end to end (images below the fold load lazily, so the clock has to outlast
 * scrolling and reading), short enough that a hash captured in a log or a
 * pasted link is dead well before anyone finds it. A page left open past the
 * window renders the expired-image placeholder; a reload re-mints.
 */
export const AGENT_BLOB_URL_TTL_SECONDS = 2 * 60 * 60;

type Binding = { tenantId: string; appId: string; userId: string };

/** Everything the serve route re-checks against the request it received. */
interface AgentBlobClaims extends Binding {
  sha256: string;
  /** Unix seconds. */
  exp: number;
}

const PORT: BlobTokenPort<Binding> = {
  domain: "agent-blob.v1",
  ttlSeconds: AGENT_BLOB_URL_TTL_SECONDS,
  bindingKeys: ["tenantId", "appId", "userId"],
};

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
  return signBlobToken(PORT, params);
}

/**
 * Verify a token's signature, shape, and expiry. Returns the claims; it does
 * NOT decide whether they match the request — the route compares them against
 * the tenant/app/user it authorized, so this stays a pure crypto seam.
 */
export async function verifyAgentBlobToken(params: {
  secret: string;
  token: string;
  now?: () => number;
}): Promise<VerifyBlobTokenResult<AgentBlobClaims>> {
  return verifyBlobToken(PORT, params);
}

/**
 * Stamp a token on each image ref of one span. Every URL in a transcript is
 * minted for the caller who requested that transcript, so a response can
 * never hand one member a link another member's browser could replay.
 */
export async function signImageRefs(
  secret: string,
  images: { sha256: string; mediaType: string }[],
  binding: Binding,
): Promise<SignedBlobRef[]> {
  return signBlobRefs(PORT, secret, images, binding);
}
