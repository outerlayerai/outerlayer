/**
 * Normalized, agent-agnostic transcript events.
 *
 * Every agent adapter (Claude Code, Codex CLI, and the rest) maps its native
 * output stream onto these six event types, so the dashboard renders any
 * agent identically and adding an adapter never touches transport or UI code.
 * Rows land in worker_run_event with a per-run monotonic `seq`.
 */

import { z } from "zod";

export const WORKER_EVENT_TYPES = [
  /** Prose from the agent (assistant text blocks). */
  "agent-message",
  /** The agent invoked a tool; payload carries { tool, summary }. */
  "tool-use",
  /** The agent edited a file; payload carries { path, tool }. */
  "file-change",
  /** Lifecycle marker from the runner; payload carries { phase, ...detail }. */
  "status",
  /** Terminal agent result; payload carries { result, cost_usd, num_turns, duration_ms }. */
  "result",
  /** Agent- or runner-level error; payload carries { message, source }. */
  "error",
] as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

/**
 * Runner phases emitted as `status` events. `started` doubles as the
 * running-transition signal: the events route flips queued/provisioning →
 * running when it sees the first batch.
 */
export const WORKER_STATUS_PHASES = [
  "started",
  "cloning",
  "agent-launched",
  "agent-exited",
  "collecting-diff",
] as const;

export const workerEventSchema = z.object({
  /** Per-run monotonic sequence assigned by the runner; ties broken nowhere — unique per run. */
  seq: z.number().int().nonnegative(),
  event_type: z.enum(WORKER_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type WorkerEvent = z.infer<typeof workerEventSchema>;

/**
 * Body of POST /api/internal/worker-events — a batch of events flushed by the
 * runner every couple of seconds. Batches are idempotent: replays collide on
 * the (worker_run_id, seq) unique constraint and are dropped.
 */
export const workerEventBatchSchema = z.object({
  worker_run_id: z.string().min(1),
  events: z.array(workerEventSchema).min(1).max(500),
});

export type WorkerEventBatch = z.infer<typeof workerEventBatchSchema>;
