/**
 * Agent-sessions contracts shared by the dashboard's Sessions list/detail
 * views, the gateway's future `/v1/sessions` routes, and the `list_sessions`/
 * `get_session` MCP tools. Dependency-free: no server-only imports, no
 * Supabase/Next types — a route handler, an MCP tool, and a React Server
 * Component page all validate/shape against the same objects.
 */

import { z } from 'zod';

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

export const ListSessionsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(SESSIONS_PAGE_SIZE),
  offset: z.coerce.number().min(0).max(MAX_SESSIONS_OFFSET).default(0),
  repo: z.string().optional(),
  branch: z.string().optional(),
  agentType: z.string().optional(),
  /** Exact model id; matches sessions whose Models array contains it. */
  model: z.string().optional(),
  /** Run origin (seat|cloud|ci|shared; '' = pre-migration rows). */
  workerKind: z.string().optional(),
  /** Case-insensitive title substring. */
  q: z.string().max(200).optional(),
  /** Developer filter — the ActorId stamped at ingest (membership id or key:<id>). */
  actor: z.string().optional(),
  /** ISO instant lower/upper bounds on StartedAt. */
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
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
  topicId: z.string().optional(),
  topicFacet: z.enum(['task', 'issues', 'steering']).optional(),
});

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
