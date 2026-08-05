import "server-only";

/**
 * ActorIds → display labels for the agent-sessions surface.
 *
 * Membership-UUID actors resolve to developer display names (profile.name,
 * email fallback). `key:*` actors — local seat syncs and shared keys — label
 * as "anonymous": seat attribution is anonymous BY DESIGN (worker-first
 * identity; privacy attaches to the human), and the raw `key:<id>` actor
 * string is an internal identifier that must never render. When more
 * than one distinct key actor is present, labels get a key-id suffix
 * ("anonymous (…6822)") so filters can tell keys apart without naming anyone.
 *
 * A member cannot read a peer's `profile` row under RLS, so the membership→name
 * lookup has to run through the admin client
 * (`lib/system/resolveMemberDisplayNames`). The authorization check it rides
 * behind: callers pass ONLY actor ids that came out of ClickHouse rows the
 * caller's resolved agent-session scope already let them see (self-pinned or
 * team.read — see features/agent-sessions/scope.ts), so this never widens
 * visibility; it only makes an already-visible column human-readable.
 * Resolution failures degrade to the anonymous/raw label, never an error.
 */
import { resolveMemberDisplayNames } from "@/lib/system";

export async function resolveActorNames(
  tenantId: string,
  actorIds: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(actorIds)].filter(Boolean);
  const keyActors = unique.filter((id) => id.startsWith("key:"));
  const out: Record<string, string> = {};
  for (const id of keyActors) {
    out[id] = keyActors.length > 1 ? `anonymous (…${id.slice(-4)})` : "anonymous";
  }
  const membershipIds = unique.filter((id) => !id.startsWith("key:"));
  if (membershipIds.length === 0) return out;
  const names = await resolveMemberDisplayNames(tenantId, membershipIds);
  return { ...out, ...names };
}
