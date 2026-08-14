/**
 * Signed, expiring capability tokens for session-detail image references.
 *
 * The token shape and the signing/verification logic live in
 * `@repo/observability-service`'s `blob-tokens.ts`, shared with the
 * dashboard's equivalent (`features/agent-sessions/blob-url.ts`) — both mint
 * the same kind of content-address-bound capability token (the blob store is
 * content-addressed, so the binding to a caller has to live on the URL, not
 * the row), differing only in domain separator and which identity field the
 * binding carries. This module fixes the gateway's half of that port: the
 * domain, the TTL, and the `{tenantId, appId, keyId}` binding — a machine
 * key, not a human, because API-key auth has no user identity, and a
 * `session.read`-only key must be able to fetch the images referenced in its
 * OWN session-detail responses without the `trace.read` the raw
 * `GET /v1/agents/blob/:sha256` route requires.
 *
 * A distinct domain separator from the dashboard's token (and from
 * `lib/git-connect-state.ts`'s OAuth state token) keeps every HMAC-signed
 * envelope that shares `OAUTH_STATE_SECRET` from cross-verifying against a
 * different purpose's token.
 */
import {
  signBlobToken,
  verifyBlobToken,
  signBlobRefs,
  type BlobTokenPort,
  type SignedBlobRef,
  type VerifyBlobTokenResult,
} from '@repo/observability-service';

/** Same window as the dashboard's image token — long enough to read a
 * transcript end to end, short enough that a leaked URL dies quickly. */
export const AGENT_BLOB_TOKEN_TTL_SECONDS = 2 * 60 * 60;

type Binding = { tenantId: string; appId: string; keyId: string };

export interface AgentBlobTokenClaims extends Binding {
  sha256: string;
  /** Unix seconds. */
  exp: number;
}

export type VerifyAgentBlobTokenResult = VerifyBlobTokenResult<AgentBlobTokenClaims>;

const PORT: BlobTokenPort<Binding> = {
  domain: 'gateway-agent-blob.v1',
  ttlSeconds: AGENT_BLOB_TOKEN_TTL_SECONDS,
  bindingKeys: ['tenantId', 'appId', 'keyId'],
};

/** Mint a token for one image. `ttlSeconds`/`now` are injectable so tests can pin the window. */
export async function signAgentBlobToken(params: {
  secret: string;
  claims: Omit<AgentBlobTokenClaims, 'exp'>;
  ttlSeconds?: number;
  now?: () => number;
}): Promise<string> {
  return signBlobToken(PORT, params);
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
  return verifyBlobToken(PORT, params);
}

/**
 * Stamp a token on each image ref of one span, bound to the caller's key —
 * every URL in a transcript is minted for the key that requested it, so a
 * response can never hand one key a link another key's request could replay.
 */
export async function signAgentBlobRefs(
  secret: string,
  images: { sha256: string; mediaType: string }[],
  binding: Binding,
): Promise<SignedBlobRef[]> {
  return signBlobRefs(PORT, secret, images, binding);
}
