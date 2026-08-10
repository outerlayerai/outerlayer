import "server-only";

/**
 * AgentSessionsService — the dashboard's adapter over
 * `@repo/observability-service`'s lifted `AgentSessionsService`. Every call
 * resolves the request's `AgentSessionsContext` into the package's port
 * values (a `SessionAccessPolicy` from `scope.ts`, an `ActorNameResolver`
 * over `resolve-actor-names.ts`, a `PrOutcomeReader` over the Postgres
 * PR-outcome reads, an `ImageRefSigner` over `blob-url.ts`) and calls
 * through — this module owns no ClickHouse SQL itself.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AgentSessionsService as ObservabilityAgentSessionsService,
  type ActorNameResolver,
  type AgentSessionsPorts,
  type ImageRefSigner,
  type PrOutcomeReader,
  type SessionAccessPolicy,
} from "@repo/observability-service";
import type { IClickHouseQuery } from "@repo/observability-service";
import { createTenantReadClient } from "@/lib/analytics/client";
import { tenantChQuery, fetchSessionOutcomeScores, getSessionListOutcomes } from "@/lib/adapters";
import { OAUTH_STATE_SECRET } from "@/config-global.server";
import type { TenantContext } from "@/lib/analytics/tenant-context";

import { signImageRefs } from "./blob-url";
import { resolveAgentSessionScope, scopedActorId } from "./scope";
import { resolveActorNames } from "./resolve-actor-names";
import type { ListSessionsQuery } from "./list-query";
import type { AgentSessionDetail, SessionsPage } from "./types";

/** The verified tenant context plus the RLS-scoped client to run Supabase
 * reads through — the service takes both, never constructs either. */
export interface AgentSessionsContext extends TenantContext {
  db: SupabaseClient;
}

/**
 * `resolveAgentSessionScope`'s `{kind: 'team'} | {kind: 'self', actorId}`
 * answers "what can this caller see"; the package's `SessionAccessPolicy`
 * additionally distinguishes seat-bound callers (dashboard members, who can
 * be granted team scope) from machine keys (never seat-bound, privacy
 * enforced by masking identity rather than pinning rows). Every dashboard
 * caller is `dashboard-member` — the `machine-key` branch is for the
 * gateway's future bearer-key reads.
 */
async function resolvePolicy(ctx: AgentSessionsContext): Promise<SessionAccessPolicy> {
  const scope = await resolveAgentSessionScope(ctx);
  if (scope.kind === "team") return { kind: "dashboard-member", membershipId: "", canSeeTeam: true };
  // `scopedActorId` resolves a missing membership row to `NO_ACTOR_SENTINEL`
  // (fail closed — an empty surface, never the whole team's).
  return { kind: "dashboard-member", membershipId: scopedActorId(scope)!, canSeeTeam: false };
}

function actorNameResolver(tenantId: string): ActorNameResolver {
  return { resolve: (actorIds) => resolveActorNames(tenantId, actorIds) };
}

function prOutcomeReader(ctx: AgentSessionsContext): PrOutcomeReader {
  return {
    forSessions: async (traceIds) => {
      if (traceIds.length === 1) {
        const chQuery = tenantChQuery({ tenantId: ctx.tenantId, appId: ctx.appId });
        const outcomes = chQuery
          ? await fetchSessionOutcomeScores(ctx.db, chQuery, {
              tenantId: ctx.tenantId,
              appId: ctx.appId,
              traceId: traceIds[0]!,
            }).catch(() => [])
          : [];
        return () => outcomes;
      }
      return getSessionListOutcomes(
        { tenantId: ctx.tenantId, appId: ctx.appId },
        ctx.db,
        traceIds.map((traceId) => ({ traceId })),
      );
    },
  };
}

function imageRefSigner(ctx: AgentSessionsContext): ImageRefSigner {
  const binding = { tenantId: ctx.tenantId, appId: ctx.appId, userId: ctx.userId };
  return { sign: (images) => signImageRefs(OAUTH_STATE_SECRET, images, binding) };
}

function ports(ctx: AgentSessionsContext): AgentSessionsPorts {
  return {
    actorNames: actorNameResolver(ctx.tenantId),
    prOutcomes: prOutcomeReader(ctx),
    images: imageRefSigner(ctx),
  };
}

class AgentSessionsService {
  async getSessionDetail(ctx: AgentSessionsContext, traceId: string): Promise<AgentSessionDetail | null> {
    const ch = createTenantReadClient({ tenantId: ctx.tenantId, appId: ctx.appId });
    if (!ch) throw new Error("ClickHouse not configured");
    const [policy] = await Promise.all([resolvePolicy(ctx)]);
    const service = new ObservabilityAgentSessionsService(ch as unknown as IClickHouseQuery);
    return service.getSessionDetail(
      { tenantId: ctx.tenantId, appId: ctx.appId },
      traceId,
      policy,
      ports(ctx),
    );
  }

  async listSessions(ctx: AgentSessionsContext, query: ListSessionsQuery): Promise<SessionsPage> {
    const ch = createTenantReadClient({ tenantId: ctx.tenantId, appId: ctx.appId });
    if (!ch) throw new Error("ClickHouse not configured");
    const policy = await resolvePolicy(ctx);
    const service = new ObservabilityAgentSessionsService(ch as unknown as IClickHouseQuery);
    return service.listSessions({ tenantId: ctx.tenantId, appId: ctx.appId }, query, policy, ports(ctx));
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const agentSessionsService = new AgentSessionsService();
