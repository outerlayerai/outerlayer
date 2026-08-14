/**
 * Sessions OpenAPI Routes
 *
 * `GET /v1/sessions` — filtered, paginated agent-session list.
 * `GET /v1/sessions/{traceId}` — full span-tree transcript for one session.
 *
 * A machine-key caller has no seat to self-pin to, so its reads are always
 * team-scoped; `agents.sessions.team.read` controls only whether actor
 * IDENTITY is visible for it. A bearer (dashboard/OAuth) caller DOES have a
 * seat — its policy mirrors the dashboard's own default exactly: self-pinned
 * to the caller's membership id unless it holds `agents.sessions.team.read`,
 * in which case the read is team-wide. `session.read` alone (granted to
 * every role) must never widen a bearer caller past their own sessions.
 */

import {
  mapClickHouseError,
  toErrorResponse,
  getErrorStatusCode,
  ServiceUnavailableError,
  ValidationError,
  maskActorIds,
} from '@repo/observability-service';
import type { ActorIdMasker, ActorNameResolver, ImageRefSigner, SessionAccessPolicy } from '@repo/observability-service';
import {
  ListSessionsQuerySchema,
  SessionsListResponseSchema,
  SessionDetailResponseSchema,
} from '@repo/api-schemas';
import { z, BaseRoute, type AppContext, errorResponse, getScopedSupabase, structuredError } from './_shared';
import { getGatewaySessionsService, getGatewayChQuery } from '../analytics-factory';
import { signAgentBlobRefs } from '../../lib/agent-blob-token';
import { buildPrOutcomeReader } from '../../lib/pr-outcomes';
import { checkBearerPermission } from '../../lib/verify-bearer';
import { RATE_LIMITS } from '../../rate-limits';
import type { GatewayPermission } from '../../lib/permissions';

/**
 * Sentinel `membershipId` for a bearer caller whose membership row can't be
 * resolved (should be unreachable — auth middleware already required an
 * active membership to authenticate). Not a real membership UUID and not
 * the `key:`-prefixed shape either, so it can never match a stored
 * `actorId` — the policy fails closed to an empty result instead of
 * throwing mid-request or, worse, resolving to `null` (team-wide).
 */
const UNRESOLVED_MEMBERSHIP_SENTINEL = 'unresolved-membership';

/** The caller's own `membership.id` for the resolved tenant, via the
 * RLS-scoped client — a user can always read their own membership row, the
 * same rule the dashboard's `resolveCallerMembershipId` relies on. */
async function resolveMembershipId(c: AppContext): Promise<string | null> {
  const user = c.get('user');
  const supabase = await getScopedSupabase(c);
  const { data, error } = await supabase
    .from('membership')
    .select('id')
    .eq('user_id', user.gatewayUserId ?? '')
    .eq('tenant_id', user.tenantId)
    .single();
  if (error) {
    console.error('[resolveMembershipId] degrading to unresolved membership', error);
    return null;
  }
  return data?.id ?? null;
}

/** Exported so `list_sessions` / `get_session` (MCP) apply the identical
 * actor-privacy policy as these REST routes — one derivation, not two. */
export async function sessionPolicy(c: AppContext): Promise<SessionAccessPolicy> {
  const user = c.get('user');

  if (user.authMode === 'bearer') {
    // Bearer permissions are resolved by RLS, not the `apikey` claims list
    // (`user.permissions` is always empty for bearer) — so team visibility
    // is checked the same way `enforcePermission` checks any other bearer
    // permission: the `app_authorize` RPC under the caller's own JWT.
    const canSeeTeam = user.userJwt
      ? await checkBearerPermission({
          env: c.env,
          userJwt: user.userJwt,
          permission: 'agents.sessions.team.read',
          appId: user.appId,
          requestTenantId: user.tenantId,
        })
      : false;
    const membershipId = await resolveMembershipId(c);
    return {
      kind: 'dashboard-member',
      membershipId: membershipId ?? UNRESOLVED_MEMBERSHIP_SENTINEL,
      canSeeTeam,
    };
  }

  return {
    kind: 'machine-key',
    canSeeTeamActors: (user.permissions ?? []).includes('agents.sessions.team.read'),
  };
}

/** Resolves membership actor ids to display names via the RLS-scoped client
 * — a caller can read their own tenant's membership/profile rows, so no
 * admin client is needed (unlike the dashboard's cross-member lookup). */
function buildActorNameResolver(c: AppContext): ActorNameResolver {
  return {
    async resolve(actorIds: string[]): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const id of actorIds) {
        if (id.startsWith('key:')) out[id] = 'anonymous';
      }
      const membershipIds = actorIds.filter((id) => !id.startsWith('key:'));
      if (membershipIds.length === 0) return out;

      const user = c.get('user');
      const supabase = await getScopedSupabase(c);
      const { data: memberships, error: membershipError } = await supabase
        .from('membership')
        .select('id, user_id')
        .eq('tenant_id', user.tenantId)
        .in('id', membershipIds);
      if (membershipError) {
        console.error('[buildActorNameResolver] degrading to unresolved names', membershipError);
        return out;
      }
      const userIds = (memberships ?? []).map((m) => m.user_id).filter((id): id is string => Boolean(id));
      if (userIds.length === 0) return out;

      const { data: profiles, error: profileError } = await supabase
        .from('profile')
        .select('id, name, email')
        .in('id', userIds);
      if (profileError) {
        console.error('[buildActorNameResolver] degrading to unresolved names', profileError);
        return out;
      }
      const nameByUser = new Map((profiles ?? []).map((p) => [p.id, p.name || p.email]));
      for (const m of memberships ?? []) {
        const name = m.user_id ? nameByUser.get(m.user_id) : undefined;
        if (name) out[m.id] = name;
      }
      return out;
    },
  };
}

/**
 * The blob-token binding key for this caller (see `lib/agent-blob-token.ts`'s
 * `keyId`): a machine key's own id, or — for a bearer caller, who has no key
 * id — the SAME resolved membership id `policy` was built from. Two callers
 * in the same tenant+app must never share a binding, or either one's signed
 * image URL verifies for the other's request too — so a machine key with no
 * `apiKeyId` (legacy keys predating per-key ids) gets `null`: no binding
 * exists that is unique to that key, and any per-tenant fallback IS the
 * shared binding. `null` fails closed on both sides — the signer emits no
 * image refs, and the blob-token verify can never match it. Takes the
 * already-resolved `policy` rather than re-resolving membership itself so a
 * request that calls both `sessionPolicy` and this only queries once.
 */
export function blobTokenKeyId(
  user: { tenantId: string; apiKeyId?: string },
  policy: SessionAccessPolicy,
): string | null {
  return policy.kind === 'dashboard-member' ? policy.membershipId : (user.apiKeyId ?? null);
}

function buildImageRefSigner(c: AppContext, policy: SessionAccessPolicy): ImageRefSigner {
  const user = c.get('user');
  const keyId = blobTokenKeyId(user, policy);
  if (keyId === null) {
    // No per-caller binding available — omit image refs entirely rather than
    // mint tokens that would either never verify or verify for sibling keys.
    return { async sign() { return []; } };
  }
  return {
    async sign(images) {
      return signAgentBlobRefs(c.env.OAUTH_STATE_SECRET, images, {
        tenantId: user.tenantId,
        appId: user.appId,
        keyId,
      });
    },
  };
}

/** Only invoked on a masked (`agents.sessions.team.read`-less machine-key)
 * read — reuses the OAuth-state HMAC secret every other signed envelope on
 * this route already keys off, under a distinct domain separator (see
 * `actor-id-mask.ts`). */
function buildActorIdMasker(c: AppContext): ActorIdMasker {
  return { mask: (actorIds) => maskActorIds(c.env.OAUTH_STATE_SECRET, actorIds) };
}

/** Exported for the `list_sessions` / `get_session` MCP tools — same port
 * wiring the REST handlers use, so behavior can't diverge between surfaces.
 * Takes the caller's already-resolved `policy` (every call site resolves it
 * once via `sessionPolicy` for the row-scoping decision) so the image
 * signer's blob-token binding reuses that same membership resolution instead
 * of re-querying it. */
export async function buildPorts(c: AppContext, policy: SessionAccessPolicy) {
  const user = c.get('user');
  const supabase = await getScopedSupabase(c);
  const chQuery = getGatewayChQuery(c.env, { tenantId: user.tenantId, appId: user.appId });
  return {
    actorNames: buildActorNameResolver(c),
    prOutcomes: buildPrOutcomeReader(supabase, chQuery, { tenantId: user.tenantId, appId: user.appId }),
    images: buildImageRefSigner(c, policy),
    actorIdMasker: buildActorIdMasker(c),
  };
}

/**
 * `pr` filtering resolves a PR/MR number to confirmed-linked trace ids via a
 * Postgres `pull_request_session` read (see `ListSessionsConstraints` in
 * `@repo/observability-service`, and the dashboard's own resolution in
 * `agent-sessions/service.ts`) — no host on this surface has that reader
 * wired for list reads. Rejected explicitly here, the same way an
 * unauthorized `actor` filter is rejected, rather than silently ignoring
 * the caller's filter and returning an unfiltered page (which would look
 * like "every session matched" instead of "this filter isn't supported").
 * Shared by the REST route and the `list_sessions` MCP tool.
 */
export function rejectPrFilter(query: { pr?: number }): void {
  if (query.pr !== undefined) {
    throw new ValidationError(
      'This surface cannot filter sessions by pr — pr filtering is dashboard-only for now.',
      'pr',
    );
  }
}

export class ListSessions extends BaseRoute {
  static requiredPermission: GatewayPermission = 'session.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Sessions'],
    summary: 'List agent sessions',
    operationId: 'list-sessions',
    description:
      'Returns a filtered, paginated list of agent-coding sessions for one repo. Without `agents.sessions.team.read`, actor identities are anonymized and `actor` filters are rejected. ' +
      "When no repo or topic filter is given, results are scoped to the app's dominant repo (the repo with the highest total spend); pass `repo` to target another repo. " +
      '`pr` is dashboard-only for now — this surface has no Postgres reader wired to resolve a PR/MR number to its confirmed-linked sessions, so a `pr` value is rejected rather than silently ignored.',
    request: {
      query: ListSessionsQuerySchema,
    },
    responses: {
      200: {
        description: 'A page of agent sessions.',
        content: { 'application/json': { schema: SessionsListResponseSchema } },
      },
      400: errorResponse('This key cannot filter sessions by actor.'),
      401: errorResponse('Missing or invalid API key.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const query = data.query;
    const user = c.get('user');

    try {
      rejectPrFilter(query);
      const service = getGatewaySessionsService(c.env, { tenantId: user.tenantId, appId: user.appId });
      if (!service) throw new ServiceUnavailableError('ClickHouse host not configured');

      const policy = await sessionPolicy(c);
      const result = await service.listSessions(
        { tenantId: user.tenantId, appId: user.appId },
        query,
        policy,
        await buildPorts(c, policy),
      );
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

/** Named so route-schema tests can assert against the identical instance,
 * rather than a separately-constructed zod schema that deep-equals wrong
 * (internal zod state differs between two logically-equivalent instances). */
export const GetSessionDetailParamsSchema = z.object({ traceId: z.string().min(1) });

export class GetSessionDetail extends BaseRoute {
  static requiredPermission: GatewayPermission = 'session.read';
  static rateLimit = RATE_LIMITS.sessionDetail;
  schema = {
    tags: ['Sessions'],
    summary: 'Get agent session detail',
    operationId: 'get-session-detail',
    description:
      'Returns the full span tree + rollup identity for one session. Span count is capped — `truncated: true` means only the FIRST spans (not necessarily the last) are included. ' +
      'A missing trace and a trace from another app return the identical 404 — there is no existence oracle for a transcript the caller cannot see.',
    request: {
      params: GetSessionDetailParamsSchema,
    },
    responses: {
      200: {
        description: 'Full session transcript.',
        content: { 'application/json': { schema: SessionDetailResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      404: errorResponse('Session not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const { traceId } = data.params as { traceId: string };
    const user = c.get('user');

    try {
      const service = getGatewaySessionsService(c.env, { tenantId: user.tenantId, appId: user.appId });
      if (!service) throw new ServiceUnavailableError('ClickHouse host not configured');

      const policy = await sessionPolicy(c);
      const result = await service.getSessionDetail(
        { tenantId: user.tenantId, appId: user.appId },
        traceId,
        policy,
        await buildPorts(c, policy),
      );
      if (!result) {
        return c.json(structuredError('trace_not_found', 'Session not found'), 404);
      }
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}
