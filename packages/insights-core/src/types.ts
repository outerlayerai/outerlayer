// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The lean session shape detectors read — a structural subset that BOTH the
 * canonical `AgentSession` (via `fromAgentSession`) and the local SQLite
 * `SessionDetail` satisfy. Detectors never touch storage or an LLM, so the
 * same logic runs identically over local scans and cloud data (the "one
 * definition, two consumers" rule — like the trace mapping).
 */
export interface DetectionToolCall {
  name: string;
  status: string; // "ok" | "error" | "rejected"
  isEdit: boolean | number;
  file?: string | null;
  errorSignature?: string | null;
}

export interface DetectionTurn {
  index: number;
  role: string; // "user" | "assistant"
  ts?: string | null;
  toolCalls: DetectionToolCall[];
}

export interface DetectionEvent {
  type: string;
  ts?: string | null;
  data?: Record<string, unknown> | null;
}

export interface DetectionSession {
  id: string;
  /** Developer identity — null locally (single-actor); set in the cloud. */
  actorId?: string | null;
  /** git repo or cwd, for grouping. */
  project?: string | null;
  startedAt: string;
  endedAt?: string | null;
  models: string[];
  costUsd?: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  isSubagent?: boolean | number;
  turns: DetectionTurn[];
  events: DetectionEvent[];
}

/** A finding's severity. */
export type Severity = "info" | "warn" | "high";

/** A drill-down pointer into a session (turn index, optional tool seq). */
export interface EvidenceRef {
  sessionId: string;
  turnIndex?: number;
  toolSeq?: number;
  note?: string;
}

/**
 * One detector result. Every finding must answer "so what" in dollars or
 * minutes (or an explicit null with a reason), and carry ≥1 evidence ref for
 * drill-down. The dollar figure comes from a documented formula (see each
 * detector's `docs.costFormula`).
 */
export interface Finding {
  detectorId: string;
  severity: Severity;
  /** Sessions implicated (evidence). */
  sessionIds: string[];
  /** One human-readable sentence. */
  summary: string;
  evidence: EvidenceRef[];
  /** Estimated wasted spend, or null when not honestly computable. */
  costUsd: number | null;
  /** Estimated human/agent time lost (minutes), or null. */
  timeMin: number | null;
  /** One-line remediation hint. */
  suggestion?: string;
}

/** Per-detector thresholds + team baselines, merged over documented defaults. */
export interface DetectorConfig {
  /** Arbitrary per-detector thresholds (see each detector's defaults). */
  thresholds?: Record<string, Record<string, number>>;
  /** $/hour used to price time-only findings (default 0 → time reported, not $). */
  dollarsPerHour?: number;
  /** Team baselines computed from the batch (cost p95, cache-read median, …). */
  baselines?: {
    costP95?: number;
    cacheReadRatioMedian?: number;
  };
}

/**
 * A detector: a pure function over a batch of sessions. `scope: 'session'`
 * fires per session; `scope: 'team'` aggregates across the batch (a pattern
 * across many sessions/actors). Ships with its rationale + cost formula so the
 * docs page auto-generates and every $ is explainable.
 */
export interface Detector {
  id: string;
  scope: "session" | "team";
  severity: Severity;
  docs: { rationale: string; costFormula: string };
  run(sessions: DetectionSession[], config: ResolvedConfig): Finding[];
}

/** Config after defaults are applied (baselines always present, maybe empty). */
export interface ResolvedConfig {
  thresholds: Record<string, Record<string, number>>;
  dollarsPerHour: number;
  baselines: { costP95: number; cacheReadRatioMedian: number };
}
