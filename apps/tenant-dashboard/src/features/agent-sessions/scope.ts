/**
 * Actor-privacy scope for the agents surface.
 *
 * Sessions are SELF-BY-DEFAULT: a member sees agent sessions attributed to
 * their own seat and nothing else. Team-wide read (other developers' sessions
 * and transcripts) is an explicit, admin-granted permission
 * (`agents.sessions.team.read` — owner/admin by default, grantable to custom
 * roles). This is the documented market norm: no coding-agent analytics
 * vendor exposes peers' sessions, and even per-user usage METRICS are
 * admin-gated by industry norm.
 *
 * Without `team.read`, every agents QUERY route computes over the caller's OWN
 * sessions only — members see their own data. Enforcement lives here because
 * agent sessions are ClickHouse rows: there is no RLS to attach, so this seam
 * is the policy.
 *
 * One route enforces the rule differently: the transcript image serve
 * (`api/orgs/[orgName]/apps/[appId]/agents/blob/[sha256]`, and the gateway's
 * `GET /v1/agents/blob/:sha256`). Those bytes are content-addressed and carry
 * no actor, on the row or on the storage key, so there is no column for this
 * seam to filter. The binding to a person rides the URL instead: the detail
 * read this seam gates mints a signed, expiring token per image
 * (`blob-url.ts`) and the route re-checks it. Its own file carries the
 * rationale. Treat that route as out of scope for this seam rather than
 * assuming it inherits the rule.
 */
import "server-only";
import { resolveCallerMembershipId } from "@/lib/adapters";
import { checkAppPermission } from "@/utils/permission-check";
import { Permissions } from "@/utils/permissions";
import { ForbiddenError } from "@repo/observability-service";
import type { TenantContext } from "@/lib/analytics/tenant-context";

type AgentSessionScope =
  | { kind: "team" }
  | { kind: "self"; actorId: string | null };

/**
 * `ActorId` values are membership UUIDs (or `key:<id>` for shared keys) —
 * this sentinel can never collide, so pinning a filter to it matches nothing.
 * A caller whose membership row is missing sees an EMPTY surface, never the
 * whole team's (fail closed).
 */
export const NO_ACTOR_SENTINEL = "__no_actor__";

export function scopedActorId(scope: AgentSessionScope): string | null {
  if (scope.kind === "team") return null;
  return scope.actorId ?? NO_ACTOR_SENTINEL;
}

export async function resolveAgentSessionScope(
  context: TenantContext,
): Promise<AgentSessionScope> {
  const [team, self] = await Promise.all([
    checkAppPermission(Permissions.AGENTS_SESSIONS_TEAM_READ, context.appId),
    checkAppPermission(Permissions.AGENTS_SESSIONS_SELF_READ, context.appId),
  ]);
  if (!team.error) return { kind: "team" };
  if (self.error) {
    throw new ForbiddenError("You don't have permission to view agent sessions");
  }

  // ActorId is stamped at ingest as the developer's membership id (dev-key
  // minting binds `actor_membership_id`). Resolve the caller's seat the same
  // way; RLS lets a user read their own membership row.
  const membershipId = await resolveCallerMembershipId(context.userId, context.tenantId);

  return { kind: "self", actorId: membershipId };
}
