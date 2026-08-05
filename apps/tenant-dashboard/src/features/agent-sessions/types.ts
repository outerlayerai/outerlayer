/**
 * Domain types for agent sessions — the wire shape of the list/detail/findings
 * reads, shared by the service and the React Server Component (RSC) pages that call it.
 */
import type { SignedImageRef } from "./blob-url";

interface AgentSessionRow {
  traceId: string;
  sessionId: string;
  title: string | null;
  agentType: string;
  actorId: string;
  /** Display label — resolved name for membership actors, "anonymous" for key:* (seat privacy). */
  actorName?: string;
  /** Run origin: seat | cloud | ci | shared; null on pre-migration rows. */
  workerKind: string | null;
  /** Run origin: '' (legacy) | interactive | agent | worker. Present on
   * list rows (the CH `Origin` column is selected there); absent on the
   * detail read's session summary, whose span query doesn't select it. */
  origin?: string;
  project: string | null;
  startedAt: string;
  durationMs: number | null;
  turnCount: number;
  toolCallCount: number;
  errorCount: number;
  /** Total user turns; > 1 means a human stepped in mid-session (steering). 0 on pre-migration rows. */
  userTurnCount: number;
  /** Tool calls a human denied at a permission prompt. 0 on pre-migration rows. */
  rejectedToolCallCount: number;
  costUsd: number | null;
  models: string[];
  /** PR outcomes for the PR(s) this session produced, grouped by PR. Empty
   * for the majority that never opened one. Present on list rows; the
   * detail read carries its PR outcomes at the top level instead (a single
   * batched read keyed on the one trace), so its session summary omits it. */
  prOutcomes?: SessionPrOutcome[];
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
  /**
   * Pasted images on this span. `token` is the signed, expiring capability
   * the blob route requires (`blob-url.ts`) — minted per caller, so these
   * refs are not shareable and the sha256 alone opens nothing.
   */
  images?: SignedImageRef[];
}

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

export interface AgentSessionDetail {
  session: AgentSessionRow & {
    captureTier: string;
    /**
     * Permission prompts the session raised. NOT SURFACED: no capture adapter
     * can populate this. An approved prompt leaves no trace in any agent
     * transcript — only a DENIED one does, and that is already counted as
     * `rejectedToolCallCount`. Kept on the wire for a future source that can
     * observe prompts directly (a permission hook); until one exists, reading
     * it as a count would report a structural 0 as a measurement.
     */
    permissionPromptCount: number;
    /** api_error session events (provider failures/stalls). 0 on pre-migration rows. */
    apiErrorCount: number;
    /** Longest run of ≥3 consecutive failed edits to one file, or null —
     * the stuck-retry pattern signal, derived from the span sequence. */
    editRetryLoop: { file: string; fails: number } | null;
    /** Hook executions across the session: transcript-derived Stop hooks
     * plus any PreToolUse/PostToolUse hook wrapped via `hooks wrap`. 0 on
     * pre-migration rows. An unwrapped Pre/PostToolUse hook still isn't
     * counted here — the transcript itself never records its timing. */
    hookExecutionCount: number;
    /** Sum of REPORTED hook durations only (unreported executions are
     * excluded, not counted as zero). 0 on pre-migration rows. */
    hookDurationMs: number;
    /** Hook executions with no reported duration. 0 on pre-migration rows. */
    hookUnreportedCount: number;
    slowestHookMs: number;
    /** '' when no hook reported a duration or on pre-migration rows. */
    slowestHookCommand: string;
  };
  spans: AgentSpan[];
  /** PR outcomes for the PR(s) this session produced, grouped by PR. Empty
   * when the session touched no scored PR. Rides the session payload so the
   * detail view needs no second fetch. */
  prOutcomes: SessionPrOutcome[];
}

export interface AgentFinding {
  id: string;
  detectorId: string;
  severity: string;
  summary: string;
  suggestion: string | null;
  costUsd: number | null;
  sessionCount: number;
  sessionIds: string[];
  project: string | null;
}

interface AgentTheme {
  id: string;
  label: string;
  description: string;
  severity: string;
  evidenceSessionIds: string[];
}

export interface AgentFindingsResponse {
  findings: AgentFinding[];
  themes: AgentTheme[];
  computedAt: string | null;
}

export interface SessionsPage {
  repo: string;
  /** The actor-privacy scope the read ran under — "team" (sees everyone) or
   * "self" (pinned to the caller's own seat). Not rendered; a diagnostic
   * signal the acceptance tests pin so a scope regression is visible on the
   * wire, not just in behavior. */
  scope: "self" | "team";
  total: number;
  /** Sessions per origin under the active filters (origin itself excluded) —
   * feeds the People | Agents | All segment badges. Absent on topic
   * drill-downs, where the segments aren't shown. */
  originCounts?: { interactive: number; agent: number; worker: number };
  branches: string[];
  actors: string[];
  agentTypes: string[];
  models: string[];
  workerKinds: string[];
  /** Membership-UUID ActorId → developer display name (best effort). */
  actorNames: Record<string, string>;
  sessions: (AgentSessionRow & { branch: string | null })[];
}

export type SessionsSort = "startedAt" | "cost" | "errors" | "turns" | "steering" | "toolErrorRate";

/** Trajectory-signal filter tokens — the list API's `signal` param. */
export type SessionsSignal = "hands-on" | "denied" | "tool-errors" | "provider-errors" | "clean";
