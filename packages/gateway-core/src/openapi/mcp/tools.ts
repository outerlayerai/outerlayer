/**
 * The MCP tool table for `POST /v1/mcp`.
 *
 * Every tool wraps the SAME service call and the SAME `@repo/api-schemas`
 * Zod objects its REST counterpart uses (`resolveTopicsScope` /
 * `sessionPolicy` / `buildPorts` / `daysAgo` / `today` / `listContextChanges`
 * are imported straight from the route files, not reimplemented) — a REST
 * response and the
 * matching tool call answer identically because they run the identical code
 * path, not because two implementations were kept in sync by hand.
 *
 * The mount (`dispatcher.ts`) is the only caller of this table's
 * `requiredPermission` / `entitlement` / `rateLimit` fields — registering a
 * tool here does nothing on its own; `tools/call` enforces them.
 */

import { z } from 'zod';
import {
  TopicsQuerySchema,
  TopicsListSchema,
  ListSessionsQuerySchema,
  SessionsPageSchema,
  AgentSessionDetailSchema,
  ModelStatsQuerySchema,
  ModelStatsEntrySchema,
  FleetOverviewQuerySchema,
  FleetOverviewSchema,
  ContextChangesQuerySchema,
  ContextChangesSchema,
} from '@repo/api-schemas';
import { ServiceUnavailableError } from '@repo/observability-service';
import type { AppContext } from '../routes/_shared';
import { getService, buildTenantContext, resolveEnvScope, structuredError } from '../routes/_shared';
import { resolveTopicsScope } from '../routes/topics';
import { daysAgo, today } from '../routes/metrics';
import { sessionPolicy, buildPorts } from '../routes/sessions';
import { listContextChanges } from '../routes/context';
import { getGatewayTopicsService, getGatewaySessionsService } from '../analytics-factory';
import { RATE_LIMITS } from '../../rate-limits';
import type { RouteRateLimit } from '../../rate-limits';
import type { GatewayPermission } from '../../lib/permissions';
import type { GatewayEntitlement } from '../../lib/entitlements';

/** Every field the `get_session` param carries — mirrors `GetSessionDetail`'s
 * `params: z.object({ traceId: ... })`, kept local since it's a path param
 * on REST and has no natural home in the shared schema package. */
const GetSessionInputSchema = z.object({
  traceId: z.string().min(1).describe('The session trace id, from a list_sessions or list_topics result.'),
});

/**
 * Output cap for `get_session`, on top of the SQL-layer span cap
 * (`MAX_SESSION_SPANS`). A pathological session's spans can still exceed 2000
 * rows' worth of tool I/O text; this keeps a single tool call from producing
 * an unusable multi-megabyte result for an MCP client.
 */
const MAX_SESSION_TOOL_OUTPUT_CHARS = 50_000;

/** One entry in {@link MCP_TOOLS}. `execute` returns the exact JSON body a
 * REST caller would receive at `{ data: ... }` — the dispatcher places it
 * verbatim into the JSON-RPC result's `structuredContent`. */
export interface McpToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  /** Input contract — also the source of the wire `inputSchema` (JSON Schema). */
  zodInputSchema: z.ZodType<TInput>;
  /** Output contract, matching the REST route's `data` field shape exactly —
   * used only for conformance testing, never for validating live results
   * (a truncated `get_session` result intentionally exceeds it). */
  zodOutputSchema: z.ZodTypeAny;
  requiredPermission: GatewayPermission;
  entitlement?: GatewayEntitlement;
  rateLimit?: RouteRateLimit;
  execute(c: AppContext, input: TInput): Promise<unknown>;
}

async function listTopicsExecute(c: AppContext, input: z.infer<typeof TopicsQuerySchema>) {
  const scope = await resolveTopicsScope(c);
  const service = getGatewayTopicsService(c.env, { tenantId: scope.tenantId, appId: scope.appId });
  if (!service) throw new ServiceUnavailableError('ClickHouse host not configured');
  const result = await service.listTopics(scope, input.facet, input.limit);
  return { data: result };
}

async function listSessionsExecute(c: AppContext, input: z.infer<typeof ListSessionsQuerySchema>) {
  const user = c.get('user');
  const service = getGatewaySessionsService(c.env, { tenantId: user.tenantId, appId: user.appId });
  if (!service) throw new ServiceUnavailableError('ClickHouse host not configured');
  const result = await service.listSessions(
    { tenantId: user.tenantId, appId: user.appId },
    input,
    sessionPolicy(c),
    await buildPorts(c),
  );
  return { data: result };
}

async function getSessionExecute(c: AppContext, input: z.infer<typeof GetSessionInputSchema>) {
  const user = c.get('user');
  const service = getGatewaySessionsService(c.env, { tenantId: user.tenantId, appId: user.appId });
  if (!service) throw new ServiceUnavailableError('ClickHouse host not configured');
  const result = await service.getSessionDetail(
    { tenantId: user.tenantId, appId: user.appId },
    input.traceId,
    sessionPolicy(c),
    await buildPorts(c),
  );
  if (!result) {
    // Matches the REST 404 body verbatim (`{ error: { code, message } }`) —
    // the dispatcher flags a CallToolResult carrying an `error` key as
    // `isError: true` rather than raising it as a JSON-RPC protocol error,
    // the same way a REST 404 is a normal HTTP response, not a transport fault.
    return structuredError('trace_not_found', 'Session not found');
  }
  const body = { data: result };
  const serialized = JSON.stringify(body);
  if (serialized.length <= MAX_SESSION_TOOL_OUTPUT_CHARS) return body;

  // Drop spans from the tail (keep the FIRST spans, matching the SQL-layer
  // cap's own "first, not last" truncation semantics) until under budget.
  const spans = [...result.spans];
  while (spans.length > 0 && JSON.stringify({ data: { ...result, spans, truncated: true } }).length > MAX_SESSION_TOOL_OUTPUT_CHARS) {
    spans.pop();
  }
  return {
    data: { ...result, spans, truncated: true },
    note: 'Output exceeded the MCP size cap and was truncated to the first spans. Fetch the full transcript via GET /v1/sessions/{traceId} over REST.',
  };
}

async function getModelCostsExecute(c: AppContext, input: z.infer<typeof ModelStatsQuerySchema>) {
  const service = getService(c);
  const ctx = buildTenantContext(c);
  const envScope = await resolveEnvScope(c);
  const result = await service.getModelStats(
    ctx,
    { start: input.from ?? daysAgo(7), end: input.to ?? today() },
    input.limit,
    undefined,
    envScope,
  );
  return { data: result };
}

async function getFleetOverviewExecute(c: AppContext, input: z.infer<typeof FleetOverviewQuerySchema>) {
  const service = getService(c);
  const ctx = buildTenantContext(c);
  const result = await service.getAgentFleetOverview(ctx, {
    start: input.from ?? daysAgo(30),
    end: input.to ?? today(),
  });
  return { data: result };
}

async function listContextChangesExecute(c: AppContext, input: z.infer<typeof ContextChangesQuerySchema>) {
  const result = await listContextChanges(c, input);
  return { data: result };
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'list_topics',
    description:
      'Top clusters of agent sessions for one facet, sized by session count. Use for "what are my agents\' top issue topics?" — ' +
      'call with facet: "issues", limit: 3 for the top 3 issue topics. facet: "task" clusters by what was asked; "steering" clusters by mid-session user corrections. ' +
      'sessionCount/share/trend are live; avgLatencyMs/avgCostUsd/errorRate are snapshots as of generatedAt (see the outerlayer://guide resource).',
    zodInputSchema: TopicsQuerySchema,
    zodOutputSchema: TopicsListSchema,
    requiredPermission: 'metrics.read',
    entitlement: 'topics_enabled',
    rateLimit: RATE_LIMITS.observabilityRead,
    execute: listTopicsExecute,
  },
  {
    name: 'list_sessions',
    description:
      'Filtered, paginated list of agent-coding sessions. Drill into a topic\'s sessions with topicId + topicFacet (topicId comes from list_topics). ' +
      'Without the agents.sessions.team.read permission, actor identities are anonymized and an actorId filter is rejected.',
    zodInputSchema: ListSessionsQuerySchema,
    zodOutputSchema: SessionsPageSchema,
    requiredPermission: 'session.read',
    rateLimit: RATE_LIMITS.observabilityRead,
    execute: listSessionsExecute,
  },
  {
    name: 'get_session',
    description:
      'Full transcript (span tree) for one session, by trace id (from list_sessions or list_topics-driven list_sessions). ' +
      'A missing or cross-app trace id returns the same not-found error. Output is capped — truncated: true means only the FIRST spans are included; ' +
      'fetch the rest via GET /v1/sessions/{traceId} over REST.',
    zodInputSchema: GetSessionInputSchema,
    zodOutputSchema: AgentSessionDetailSchema,
    requiredPermission: 'session.read',
    rateLimit: RATE_LIMITS.sessionDetail,
    execute: getSessionExecute,
  },
  {
    name: 'get_model_costs',
    description:
      'Per-model token spend, request counts, and latency for this app, over from..to (UTC calendar dates, default trailing 7 days). ' +
      'Cost is METERED LLM SPEND ONLY for this app — it excludes seat/subscription cost. Call twice with explicit non-overlapping windows to compare periods.',
    zodInputSchema: ModelStatsQuerySchema,
    zodOutputSchema: z.object({ models: z.array(ModelStatsEntrySchema) }),
    requiredPermission: 'metrics.read',
    rateLimit: RATE_LIMITS.observabilityRead,
    execute: getModelCostsExecute,
  },
  {
    name: 'get_fleet_overview',
    description:
      'Fleet-wide agent behavior tiles (sessions, tool-error rate, hands-on rate, spend, and more) over from..to (UTC calendar dates, default trailing 30 days), ' +
      'each as a current/prior pair against the equal-length preceding period. Call twice with explicit windows to compare before/after a change (e.g. across a context/prompt update).',
    zodInputSchema: FleetOverviewQuerySchema,
    zodOutputSchema: FleetOverviewSchema,
    requiredPermission: 'metrics.read',
    rateLimit: RATE_LIMITS.observabilityRead,
    execute: getFleetOverviewExecute,
  },
  {
    name: 'list_context_changes',
    description:
      'Synced-commit history of the app\'s .outerlayer/ context tree, newest first — a new entry appears only for a commit ' +
      'whose context files actually changed. Use a change\'s timestamp as the boundary between two get_fleet_overview windows ' +
      'to see its before/after effect.',
    zodInputSchema: ContextChangesQuerySchema,
    zodOutputSchema: ContextChangesSchema,
    requiredPermission: 'metrics.read',
    rateLimit: RATE_LIMITS.observabilityRead,
    execute: listContextChangesExecute,
  },
];

export function findTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
