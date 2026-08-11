/**
 * Sessions OpenAPI Routes
 *
 * `GET /v1/sessions` — filtered, paginated agent-session list.
 * `GET /v1/sessions/{traceId}` — full span-tree transcript for one session.
 *
 * Every caller of this REST/MCP surface is a machine key: there is no seat
 * to self-pin to (unlike the dashboard's `dashboard-member` policy), so every
 * read is team-scoped. `agents.sessions.team.read` controls only whether
 * actor IDENTITY is visible — the rows themselves are always visible to a
 * caller with `session.read`.
 */

import { mapClickHouseError, toErrorResponse, getErrorStatusCode, ServiceUnavailableError } from '@repo/observability-service';
import type { ActorNameResolver, ImageRefSigner, SessionAccessPolicy } from '@repo/observability-service';
import {
  ListSessionsQuerySchema,
  SessionsListResponseSchema,
  SessionDetailResponseSchema,
} from '@repo/api-schemas';
import { z, BaseRoute, type AppContext, errorResponse, getScopedSupabase, structuredError } from './_shared';
import { getGatewaySessionsService, getGatewayChQuery } from '../analytics-factory';
import { signAgentBlobRefs } from '../../lib/agent-blob-token';
import { buildPrOutcomeReader } from '../../lib/pr-outcomes';
import { RATE_LIMITS } from '../../rate-limits';
import type { GatewayPermission } from '../../lib/permissions';

/** Exported so `list_sessions` / `get_session` (MCP) apply the identical
 * actor-privacy policy as these REST routes — one derivation, not two. */
export function sessionPolicy(c: AppContext): SessionAccessPolicy {
  const user = c.get('user');
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
      const { data: memberships } = await supabase
        .from('membership')
        .select('id, user_id')
        .eq('tenant_id', user.tenantId)
        .in('id', membershipIds);
      const userIds = (memberships ?? []).map((m) => m.user_id).filter((id): id is string => Boolean(id));
      if (userIds.length === 0) return out;

      const { data: profiles } = await supabase.from('profile').select('id, name, email').in('id', userIds);
      const nameByUser = new Map((profiles ?? []).map((p) => [p.id, p.name || p.email]));
      for (const m of memberships ?? []) {
        const name = m.user_id ? nameByUser.get(m.user_id) : undefined;
        if (name) out[m.id] = name;
      }
      return out;
    },
  };
}

function buildImageRefSigner(c: AppContext): ImageRefSigner {
  const user = c.get('user');
  return {
    async sign(images) {
      return signAgentBlobRefs(c.env.OAUTH_STATE_SECRET, images, {
        tenantId: user.tenantId,
        appId: user.appId,
        // Bearer callers have no key id — fall back to a stable per-tenant
        // binding so mint and verify agree. This REST/MCP surface is
        // API-key-first; the fallback is a defensive rail, not the expected
        // caller.
        keyId: user.apiKeyId ?? user.tenantId,
      });
    },
  };
}

/** Exported for the `list_sessions` / `get_session` MCP tools — same port
 * wiring the REST handlers use, so behavior can't diverge between surfaces. */
export async function buildPorts(c: AppContext) {
  const user = c.get('user');
  const supabase = await getScopedSupabase(c);
  const chQuery = getGatewayChQuery(c.env, { tenantId: user.tenantId, appId: user.appId });
  return {
    actorNames: buildActorNameResolver(c),
    prOutcomes: buildPrOutcomeReader(supabase, chQuery, { tenantId: user.tenantId, appId: user.appId }),
    images: buildImageRefSigner(c),
  };
}

export class ListSessions extends BaseRoute {
  static requiredPermission: GatewayPermission = 'session.read';
  static rateLimit = RATE_LIMITS.observabilityRead;
  schema = {
    tags: ['Sessions'],
    summary: 'List agent sessions',
    operationId: 'list-sessions',
    description:
      'Returns a filtered, paginated list of agent-coding sessions for one repo. Without `agents.sessions.team.read`, actor identities are anonymized and `actor` filters are rejected.',
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
      const service = getGatewaySessionsService(c.env, { tenantId: user.tenantId, appId: user.appId });
      if (!service) throw new ServiceUnavailableError('ClickHouse host not configured');

      const result = await service.listSessions(
        { tenantId: user.tenantId, appId: user.appId },
        query,
        sessionPolicy(c),
        await buildPorts(c),
      );
      return c.json({ data: result });
    } catch (error) {
      console.error(`[${c.req.method} ${c.req.path}]`, error);
      const mapped = mapClickHouseError(error);
      return c.json(toErrorResponse(mapped), getErrorStatusCode(mapped) as 500);
    }
  }
}

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
      params: z.object({ traceId: z.string().min(1) }),
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

      const result = await service.getSessionDetail(
        { tenantId: user.tenantId, appId: user.appId },
        traceId,
        sessionPolicy(c),
        await buildPorts(c),
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
