/**
 * Agent-sessions contracts shared by the dashboard's Sessions list/detail
 * views, the gateway's future `/v1/sessions` routes, and the `list_sessions`/
 * `get_session` MCP tools. Dependency-free: no server-only imports, no
 * Supabase/Next types — a route handler, an MCP tool, and a React Server
 * Component page all validate/shape against the same objects.
 */

import { z } from 'zod';
import { noLoneSurrogates, reasonableChDate } from '../validators';

/** Origin token → SQL literal set. A closed vocabulary: `interactive` also
 * matches legacy pre-Origin-column rows (stamped ''). */
export const ORIGIN_LITERALS: ReadonlyMap<string, string> = new Map([
  ['interactive', "'', 'interactive'"],
  ['agent', "'agent'"],
  ['worker', "'worker'"],
]);

/**
 * Rows per page — kept alongside the query schema so every caller (URL
 * parsing, MCP tool defaults) agrees on the page size.
 */
export const SESSIONS_PAGE_SIZE = 25;

/**
 * Max `offset` a caller may request. `listSessions` runs a full FINAL scan
 * under the WHERE clause per page — an unbounded offset lets a caller walk
 * arbitrarily deep into a large fleet's history at linearly growing cost.
 */
export const MAX_SESSIONS_OFFSET = 10_000;

/**
 * The pre-refine base object, exported so a host that needs a STRUCTURAL
 * variant (e.g. the MCP tool table omitting `pr` from what it advertises —
 * `pr` is dashboard-only, see the field's own doc comment below) can
 * `.omit(...)` it and reapply the topicId/topicFacet refine itself.
 * `ListSessionsQuerySchema.omit(...)` doesn't work directly: zod rejects
 * `.omit()` on a schema that already carries a `.refine()`.
 */
export const ListSessionsQueryBaseSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(SESSIONS_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(MAX_SESSIONS_OFFSET).default(0),
  repo: z.string().refine(...noLoneSurrogates).optional(),
  branch: z.string().refine(...noLoneSurrogates).optional(),
  agentType: z.string().refine(...noLoneSurrogates).optional(),
  /** Exact model id; matches sessions whose Models array contains it. */
  model: z.string().refine(...noLoneSurrogates).optional(),
  /** Run origin (seat|cloud|ci|shared; '' = pre-migration rows). */
  workerKind: z.string().refine(...noLoneSurrogates).optional(),
  /** Case-insensitive title substring. */
  q: z.string().max(200).refine(...noLoneSurrogates).optional(),
  /** Developer filter — the ActorId stamped at ingest (membership id or key:<id>). */
  actor: z.string().refine(...noLoneSurrogates).optional(),
  /** ISO instant lower/upper bounds on StartedAt. `reasonableChDate` rejects
   * far-future/far-past values that overflow ClickHouse's DateTime range —
   * an out-of-range bound reaches parseDateTimeBestEffort undefended
   * otherwise, which stalls rather than erroring cleanly. */
  from: z.string().datetime({ offset: true }).refine(...reasonableChDate).optional(),
  to: z.string().datetime({ offset: true }).refine(...reasonableChDate).optional(),
  sort: z.enum(['startedAt', 'cost', 'errors', 'turns', 'steering', 'toolErrorRate']).default('startedAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  /** Trajectory-signal filter — sessions where that signal fired (or `clean`
   * for none). Composes with every other filter, including origin. */
  signal: z.enum(['hands-on', 'denied', 'tool-errors', 'provider-errors', 'clean']).optional(),
  /** "1" to list subagent transcripts as rows; default hides them — a
   * workflow fan-out can put hundreds of children under one session. */
  includeSubagents: z.enum(['1']).optional(),
  /** Run origin filter — one token or a comma-separated set of
   * interactive|agent|worker; absent lists every origin. */
  origin: z
    .string()
    .optional()
    .refine((v) => v === undefined || (v.length > 0 && v.split(',').every((t) => ORIGIN_LITERALS.has(t))), {
      message: 'origin must be a comma-separated set of interactive|agent|worker',
    }),
  /** Topic drill-down: show only sessions assigned to this topic (by TraceId
   * in trace_facets) for the given facet. Set together; spans repos. */
  topicId: z.string().refine(...noLoneSurrogates).optional(),
  topicFacet: z.enum(['task', 'issues', 'steering']).optional(),
  /** PR filter: show only sessions CONFIRMED-linked (via
   * `pull_request_session`) to this provider PR/MR number. The header link
   * in a rendered PR session comment (`…/sessions?pr=<n>`) is the primary
   * producer of this param. Composes with every other filter; spans repos,
   * the same as the topic drill-down above. Dashboard-only today — resolving
   * it needs a Postgres `pull_request_session` read no gateway/MCP host has
   * wired for list reads, so those surfaces reject a `pr` value rather than
   * silently ignoring it. */
  pr: z.coerce.number().int().positive().optional(),
});

/** topicId/topicFacet must be set together — shared by
 * {@link ListSessionsQuerySchema} and any `.omit(...)` variant built off
 * {@link ListSessionsQueryBaseSchema}, so the two can never drift on this
 * rule. */
export function requireTopicPairTogether<T extends { topicId?: string; topicFacet?: string }>(v: T): boolean {
  return (v.topicId === undefined) === (v.topicFacet === undefined);
}
const TOPIC_PAIR_REFINE_OPTS = {
  message: 'topicId and topicFacet must be set together',
  path: ['topicFacet'] as PropertyKey[],
};

export const ListSessionsQuerySchema = ListSessionsQueryBaseSchema.refine(requireTopicPairTogether, TOPIC_PAIR_REFINE_OPTS);

export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;
export type SessionsSort = ListSessionsQuery['sort'];
export type SessionsSignal = NonNullable<ListSessionsQuery['signal']>;

/** One score's value + human label, or absent when the writer never emitted it. */
interface SessionOutcomeFact {
  score: number;
  label: string;
}

/** PR-outcome scores for one PR the session produced. */
export interface SessionPrOutcome {
  prNumber: number;
  /** Provider PR/MR page for linking out; null when no URL was captured. */
  prUrl: string | null;
  ciGreen: SessionOutcomeFact | null;
  merged: SessionOutcomeFact | null;
  reverted: SessionOutcomeFact | null;
}

/** A capability-token-bound image reference on a span (see the dashboard's
 * `blob-url.ts` / the gateway's future blob-token minting for `token`'s
 * shape) — this package only carries the wire shape. */
export interface SignedImageRef {
  sha256: string;
  mediaType: string;
  token: string;
}

export interface AgentSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: string;
  durationMs: number | null;
  statusCode: string;
  statusMessage: string | null;
  model: string | null;
  cost: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  input: string | null;
  output: string | null;
  reasoning: string | null;
  metadata: Record<string, string>;
  images?: SignedImageRef[];
}

interface AgentSessionRow {
  traceId: string;
  sessionId: string;
  title: string | null;
  agentType: string;
  actorId: string;
  /** Display label — resolved name for membership actors, "anonymous" for key:* (seat privacy). */
  actorName?: string;
  workerKind: string | null;
  origin?: string;
  project: string | null;
  startedAt: string;
  durationMs: number | null;
  turnCount: number;
  toolCallCount: number;
  errorCount: number;
  userTurnCount: number;
  rejectedToolCallCount: number;
  costUsd: number | null;
  models: string[];
  prOutcomes?: SessionPrOutcome[];
}

/** One facet's current summary for a trace — `facet` is the raw ClickHouse
 * facet key ('task' | 'sentiment' | 'issues' | 'steering' | a custom facet's
 * key), not a display label. */
export interface FacetSummary {
  facet: string;
  summary: string;
}

export interface AgentSessionDetail {
  session: AgentSessionRow & {
    captureTier: string;
    permissionPromptCount: number;
    apiErrorCount: number;
    editRetryLoop: { file: string; fails: number } | null;
    hookExecutionCount: number;
    hookDurationMs: number;
    hookUnreportedCount: number;
    slowestHookMs: number;
    slowestHookCommand: string;
  };
  spans: AgentSpan[];
  /** `true` when the span tree hit the {@link MAX_SESSION_SPANS} cap — the
   * caller saw the session's FIRST spans, not necessarily its last. */
  truncated: boolean;
  prOutcomes: SessionPrOutcome[];
  /** Current-extractor-version facet summaries for this trace, in canonical
   * facet order. Empty when Topics is disabled for the app or the pipeline
   * hasn't classified this trace yet. Rides the session payload so the
   * detail view needs no second fetch. */
  facetSummaries: FacetSummary[];
}

export interface SessionsPage {
  repo: string;
  /** The actor-privacy scope the read ran under — "team" (sees everyone) or
   * "self" (pinned to the caller's own seat). */
  scope: 'self' | 'team';
  total: number;
  originCounts?: { interactive: number; agent: number; worker: number };
  branches: string[];
  actors: string[];
  agentTypes: string[];
  models: string[];
  workerKinds: string[];
  actorNames: Record<string, string>;
  sessions: (AgentSessionRow & { branch: string | null })[];
}

/** Cap on spans a single detail read returns — a pathological session (a
 * runaway tool loop) can carry tens of thousands of rows; past this the
 * response is truncated rather than shipping an unbounded payload. */
export const MAX_SESSION_SPANS = 2000;

// ---------------------------------------------------------------------------
// GET /v1/sessions + GET /v1/sessions/{traceId} — REST + MCP wire contract
// ---------------------------------------------------------------------------

const SessionOutcomeFactSchema = z.object({ score: z.number(), label: z.string() });

const SessionPrOutcomeSchema = z.object({
  prNumber: z.number().int(),
  prUrl: z.string().nullable(),
  ciGreen: SessionOutcomeFactSchema.nullable(),
  merged: SessionOutcomeFactSchema.nullable(),
  reverted: SessionOutcomeFactSchema.nullable(),
});

const SignedImageRefSchema = z.object({
  sha256: z.string(),
  mediaType: z.string(),
  token: z.string(),
});

const AgentSessionRowSchema = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  title: z.string().nullable(),
  agentType: z.string(),
  actorId: z.string(),
  actorName: z.string().optional(),
  workerKind: z.string().nullable(),
  origin: z.string().optional(),
  project: z.string().nullable(),
  startedAt: z.string(),
  durationMs: z.number().nullable(),
  turnCount: z.number().int(),
  toolCallCount: z.number().int(),
  errorCount: z.number().int(),
  userTurnCount: z.number().int(),
  rejectedToolCallCount: z.number().int(),
  costUsd: z.number().nullable(),
  models: z.array(z.string()),
  prOutcomes: z.array(SessionPrOutcomeSchema).optional(),
});

export const AgentSpanSchema = z.object({
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  name: z.string(),
  startTime: z.string(),
  durationMs: z.number().nullable(),
  statusCode: z.string(),
  statusMessage: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  reasoning: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  images: z.array(SignedImageRefSchema).optional(),
});

export const SessionsPageSchema = z.object({
  repo: z.string(),
  scope: z.enum(['self', 'team']),
  total: z.number().int().nonnegative(),
  originCounts: z
    .object({ interactive: z.number().int(), agent: z.number().int(), worker: z.number().int() })
    .optional(),
  branches: z.array(z.string()),
  actors: z.array(z.string()),
  agentTypes: z.array(z.string()),
  models: z.array(z.string()),
  workerKinds: z.array(z.string()),
  actorNames: z.record(z.string(), z.string()),
  sessions: z.array(AgentSessionRowSchema.extend({ branch: z.string().nullable() })),
});

export const AgentSessionDetailSchema = z.object({
  session: AgentSessionRowSchema.extend({
    captureTier: z.string(),
    permissionPromptCount: z.number().int(),
    apiErrorCount: z.number().int(),
    editRetryLoop: z.object({ file: z.string(), fails: z.number().int() }).nullable(),
    hookExecutionCount: z.number().int(),
    hookDurationMs: z.number(),
    hookUnreportedCount: z.number().int(),
    slowestHookMs: z.number(),
    slowestHookCommand: z.string(),
  }),
  spans: z.array(AgentSpanSchema),
  truncated: z.boolean(),
  prOutcomes: z.array(SessionPrOutcomeSchema),
  facetSummaries: z.array(z.object({ facet: z.string(), summary: z.string() })),
});

export const SessionsListResponseSchema = z.object({ data: SessionsPageSchema });
export const SessionDetailResponseSchema = z.object({ data: AgentSessionDetailSchema });
