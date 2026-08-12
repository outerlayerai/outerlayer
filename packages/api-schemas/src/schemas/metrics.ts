import { z } from "zod";
import { itemResponse } from "./common";
import { TOPIC_FACETS } from "./topics";
import { reasonableChDate } from "../validators";

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const MetricsParamsSchema = z.object({
  // Pre-migration contract: ISO 8601 datetime strings (format: date-time).
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
  extended: z.coerce.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Response schemas (snake_case, matching actual API responses)
// ---------------------------------------------------------------------------

export const MetricsSummarySchema = z.object({
  total_requests: z.number().int().nonnegative(),
  success_count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  total_cost: z.number(),
  total_tokens: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  avg_latency_ms: z.number(),
  unique_users: z.number().int().nonnegative(),
  // Extended fields (present when extended=true)
  avg_cost_per_request: z.number().optional(),
  avg_input_tokens_per_request: z.number().optional(),
  avg_output_tokens_per_request: z.number().optional(),
  avg_total_tokens_per_request: z.number().optional(),
  model_count: z.number().int().nonnegative().optional(),
});

export const MetricsTimeSeriesPointSchema = z.object({
  date: z.string().date(),
  hour: z.number().int().min(0).max(23),
  requests: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  cost: z.number(),
  tokens: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  avg_latency_ms: z.number(),
  unique_users: z.number().int().nonnegative(),
});

export const MetricsDataSchema = z.object({
  summary: MetricsSummarySchema,
  time_series: z.array(MetricsTimeSeriesPointSchema),
});

export const MetricsResponseSchema = itemResponse(MetricsDataSchema);

export type MetricsParams = z.infer<typeof MetricsParamsSchema>;
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;
export type MetricsTimeSeriesPoint = z.infer<typeof MetricsTimeSeriesPointSchema>;
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/metrics/models — per-model token spend
//
// `from`/`to` are calendar DATES (not datetimes): the underlying ClickHouse
// filter is `toDate(Timestamp)`, so a value carries no timezone or
// sub-day precision. Both endpoints on this route default trailing windows
// so a caller can omit them entirely.
// ---------------------------------------------------------------------------

export const ModelStatsQuerySchema = z.object({
  from: z.string().date().refine(...reasonableChDate).optional(),
  to: z.string().date().refine(...reasonableChDate).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const ModelStatsEntrySchema = z.object({
  model: z.string(),
  requests: z.number().int().nonnegative(),
  cost: z.number(),
  tokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  avgLatencyMs: z.number(),
  successRate: z.number(),
});

export const ModelStatsResponseSchema = z.object({
  data: z.object({ models: z.array(ModelStatsEntrySchema) }),
});

// ---------------------------------------------------------------------------
// GET /v1/metrics/overview — fleet-wide tiles, current vs prior period
// ---------------------------------------------------------------------------

export const FleetOverviewQuerySchema = z.object({
  from: z.string().date().refine(...reasonableChDate).optional(),
  to: z.string().date().refine(...reasonableChDate).optional(),
});

const FleetTileSchema = z.object({
  current: z.number(),
  prior: z.number(),
});

export const FleetModelMixItemSchema = z.object({
  model: z.string(),
  sessions: z.number().int().nonnegative(),
});

export const FleetOverviewSchema = z.object({
  sessions: FleetTileSchema,
  toolErrorRate: FleetTileSchema,
  cleanSessionRate: FleetTileSchema,
  handsOnRate: FleetTileSchema,
  activeActors: FleetTileSchema,
  totalCost: FleetTileSchema,
  toolDenialRate: FleetTileSchema,
  autoApprovedRate: FleetTileSchema,
  modelMix: z.array(FleetModelMixItemSchema),
});

export const FleetOverviewResponseSchema = z.object({ data: FleetOverviewSchema });

export type ModelStatsQuery = z.infer<typeof ModelStatsQuerySchema>;
export type FleetOverviewQuery = z.infer<typeof FleetOverviewQuerySchema>;

// ---------------------------------------------------------------------------
// GET /v1/metrics/compare — two explicit windows, fleet metrics + topic mix
//
// Unlike /v1/metrics/overview, neither window defaults — a correlational
// comparison across two SPECIFIC windows (e.g. either side of a context or
// prompt change) is the whole point of this endpoint, so there is no
// sensible "trailing N days" fallback for either side.
// ---------------------------------------------------------------------------

export const CompareWindowsQuerySchema = z.object({
  aFrom: z.string().date().refine(...reasonableChDate),
  aTo: z.string().date().refine(...reasonableChDate),
  bFrom: z.string().date().refine(...reasonableChDate),
  bTo: z.string().date().refine(...reasonableChDate),
  facet: z.enum(TOPIC_FACETS).default("issues"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Fleet tiles for ONE window — the `current` half of {@link FleetOverviewSchema}'s
 * pair shape, flattened (no `prior`): a comparison across two explicit,
 * caller-chosen windows has no use for either window's own trailing-period
 * baseline. */
export const FleetWindowMetricsSchema = z.object({
  sessions: z.number(),
  toolErrorRate: z.number(),
  cleanSessionRate: z.number(),
  handsOnRate: z.number(),
  activeActors: z.number(),
  totalCost: z.number(),
  toolDenialRate: z.number(),
  autoApprovedRate: z.number(),
  modelMix: z.array(FleetModelMixItemSchema),
});

const CompareWindowResultSchema = z.object({
  from: z.string(),
  to: z.string(),
  metrics: FleetWindowMetricsSchema,
});

/** Raw facet-row counts for one topic in each window — NOT deduplicated to
 * root sessions (unlike `/v1/topics`' `sessionCount`), so callers judge
 * relative shift, not an exact session total. */
export const TopicMixDeltaSchema = z.object({
  topicId: z.string(),
  name: z.string(),
  countA: z.number().int().nonnegative(),
  countB: z.number().int().nonnegative(),
});

export const CompareWindowsSchema = z.object({
  windowA: CompareWindowResultSchema,
  windowB: CompareWindowResultSchema,
  topicMix: z.array(TopicMixDeltaSchema),
});

export const CompareWindowsResponseSchema = z.object({ data: CompareWindowsSchema });

export type CompareWindowsQuery = z.infer<typeof CompareWindowsQuerySchema>;

// ---------------------------------------------------------------------------
// GET /v1/metrics/breakdown — cost/session/error ranking for one dimension
//
// `branch` / `agent_type` / `worker_kind` and `model` rank
// agent_session_summary sessions; `tool` ranks otel_traces tool-call spans
// and has no session-level cost, so its items carry `requests` instead of
// `sessions`/`costUsd`. Never an `actor` dimension — the privacy invariant
// documented in observability-service's queries-agent-fleet.ts forbids a
// per-actor breakdown anywhere on this surface.
// ---------------------------------------------------------------------------

export const METRICS_BREAKDOWN_DIMENSIONS = ['branch', 'agent_type', 'worker_kind', 'model', 'tool'] as const;

export const MetricsBreakdownQuerySchema = z.object({
  dimension: z.enum(METRICS_BREAKDOWN_DIMENSIONS),
  from: z.string().date().refine(...reasonableChDate).optional(),
  to: z.string().date().refine(...reasonableChDate).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const MetricsBreakdownItemSchema = z.object({
  key: z.string(),
  sessions: z.number().int().nonnegative().optional(),
  costUsd: z.number().optional(),
  toolErrorRate: z.number().optional(),
  requests: z.number().int().nonnegative().optional(),
});

export const MetricsBreakdownSchema = z.object({
  dimension: z.enum(METRICS_BREAKDOWN_DIMENSIONS),
  items: z.array(MetricsBreakdownItemSchema),
});

export const MetricsBreakdownResponseSchema = z.object({ data: MetricsBreakdownSchema });

export type MetricsBreakdownQuery = z.infer<typeof MetricsBreakdownQuerySchema>;

// ---------------------------------------------------------------------------
// GET /v1/metrics/trends — daily sessions/cost/quality trend
// ---------------------------------------------------------------------------

export const MetricsTrendsQuerySchema = z.object({
  from: z.string().date().refine(...reasonableChDate).optional(),
  to: z.string().date().refine(...reasonableChDate).optional(),
});

export const MetricsTrendPointSchema = z.object({
  date: z.string().date(),
  sessions: z.number().int().nonnegative(),
  costUsd: z.number(),
  toolErrorRate: z.number(),
  cleanSessionRate: z.number(),
});

export const MetricsTrendsSchema = z.object({ points: z.array(MetricsTrendPointSchema) });

export const MetricsTrendsResponseSchema = z.object({ data: MetricsTrendsSchema });

export type MetricsTrendsQuery = z.infer<typeof MetricsTrendsQuerySchema>;

// ---------------------------------------------------------------------------
// GET /v1/prs/outcomes — session→PR attribution merged with cost
//
// No date window, matching the underlying attribution reads (a PR's session
// set and cost include work that predates its merge). Merged/reverted/
// CI-green rates aren't included — see AgentPrOutcomesResponse's doc comment
// in @repo/api-types for why.
// ---------------------------------------------------------------------------

export const PrOutcomesItemSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  prNumber: z.number().int().nonnegative(),
  steered: z.boolean(),
  costUsd: z.number(),
});

export const PrOutcomesSchema = z.object({
  branches: z.array(z.string()),
  prNumbers: z.array(z.number().int().nonnegative()),
  steeredPrNumbers: z.array(z.number().int().nonnegative()),
  items: z.array(PrOutcomesItemSchema),
});

export const PrOutcomesResponseSchema = z.object({ data: PrOutcomesSchema });
