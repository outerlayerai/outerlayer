/**
 * Pseudonymizes a `machine-key` caller's session actorId on a masked read
 * (`mustMaskActors` in `agent-sessions.ts`): the raw value is a stable
 * `membership.id` UUID, itself a per-developer identifier a caller without
 * `agents.sessions.team.read` must never see. HMAC-SHA256 over the actorId,
 * keyed by a secret the host already holds for its blob-token signing (a
 * distinct domain separator keeps this token space from cross-verifying
 * against any other HMAC'd envelope sharing the secret) — the same actorId
 * always produces the same pseudonym, so a masked caller can still group
 * "this developer's other sessions" without ever learning which membership
 * row produced the group.
 */
import { createSignature } from '@repo/shared-utils';

const DOMAIN = 'agent-session-actor-mask.v1';
const PSEUDONYM_PREFIX = 'anon-';
const PSEUDONYM_HEX_LENGTH = 16;

export async function maskActorId(secret: string, actorId: string): Promise<string> {
  const signature = await createSignature(secret, `${DOMAIN}.${actorId}`);
  const hex = signature.slice(signature.indexOf('=') + 1);
  return `${PSEUDONYM_PREFIX}${hex.slice(0, PSEUDONYM_HEX_LENGTH)}`;
}

export async function maskActorIds(secret: string, actorIds: readonly string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(actorIds.map(async (id) => [id, await maskActorId(secret, id)] as const));
  return Object.fromEntries(entries);
}
