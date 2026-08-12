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
  ForbiddenError,
  type ActorNameResolver,
  type AgentSessionsPorts,
  type ImageRefSigner,
  type PrOutcomeReader,
  type SessionAccessPolicy,
} from "@repo/observability-service";
import type { IClickHouseQuery } from "@repo/observability-service";
import { createTenantReadClient } from "@/lib/analytics/client";
import { checkAppPermission } from "@/utils/permission-check";
import { Permissions } from "@/utils/permissions";
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

/** Bounded scan for the `?pr=` filter's `pull_request_session` lookup — a
 * list filter, never a full-table walk. Matches the sibling bound in
 * `pr-session-comment/read.ts` (`MAX_LINKS`). */
const MAX_PR_LINKED_SESSIONS = 5_000;

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

    // `?pr=` filter: only sessions CONFIRMED-linked (via `pull_request_session`)
    // to this app's PR/MR number, resolved to trace ids HERE rather than
    // inside `@repo/observability-service` — that package has no Postgres
    // dependency, so it can't read `pull_request_session` itself (see
    // `ListSessionsConstraints`); this host resolves the constraint and
    // passes it through.
    //
    // COUPLED to the PR comment's footer link (`pr-session-comment/render.ts`),
    // which is the landing surface for every deep link in that comment. This
    // filter is pinned to ONE `app_id`, but a PR's sessions can span several
    // apps in a tenant — so a reader following that link on a multi-app PR
    // sees a SUBSET of the sessions the comment listed, with smaller totals,
    // a real "every figure matches the dashboard exactly" gap the TODO in
    // render.ts tracks. Rendering the link anyway is the deliberate choice
    // (no doorway at all was worse); closing the gap means making this
    // filter tenant-scoped, and both sides move together. `verification =
    // 'confirmed'` excludes pending/unmatched claims — same rule the
    // PR-comment read layer applies (`pr-session-comment/read.ts`). Read
    // through `ctx.db` (RLS-scoped to this caller's tenant) and pinned to
    // `ctx.appId` — a `pr` value from the URL narrows the existing
    // tenant+app scope, it can never widen it. An undefined constraint
    // means "no pr filter"; an empty (but resolved) array means "filter is
    // active, nothing confirmed-linked" — must resolve to zero rows via
    // the shared service's constraint handling, not "no filter".
    let traceIds: string[] | undefined;
    if (query.pr !== undefined) {
      // `pull_request_session`'s only SELECT policy requires
      // `git_connection.read` on the app, so a member without it reads ZERO
      // rows with NO error — indistinguishable, from here, from "this PR has
      // no linked sessions". Following the comment's footer link, that member
      // would land on an empty list with no explanation, off a comment that
      // just listed N sessions. Checked explicitly so the answer is "you
      // can't see this" rather than a silent empty state. (The sessions
      // themselves stay readable; it is only the PR↔session mapping this
      // permission gates.)
      const linkAccess = await checkAppPermission(Permissions.GIT_CONNECTION_READ, ctx.appId);
      if (linkAccess.error) {
        throw new ForbiddenError(
          "You don't have permission to view which sessions are linked to a pull request",
        );
      }
      const { data: prLinks, error: prLinksError } = await ctx.db
        .from("pull_request_session")
        .select("trace_id")
        .eq("app_id", ctx.appId)
        .eq("pr_number", query.pr)
        .eq("verification", "confirmed")
        .limit(MAX_PR_LINKED_SESSIONS);
      if (prLinksError) throw new Error(`pull_request_session read failed: ${prLinksError.message}`);
      traceIds = [...new Set((prLinks ?? []).map((r) => (r as { trace_id: string }).trace_id))];
    }

    return service.listSessions(
      { tenantId: ctx.tenantId, appId: ctx.appId },
      query,
      policy,
      ports(ctx),
      traceIds !== undefined ? { traceIds } : {},
    );
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const agentSessionsService = new AgentSessionsService();
