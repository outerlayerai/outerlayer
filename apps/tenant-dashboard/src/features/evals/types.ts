/**
 * Row + lifecycle types for eval runs (`eval_run`,
 * supabase/schemas/71-eval-run.sql).
 *
 * A run is created queued at dispatch, flipped to running by the worker, and
 * completed with its Report Card (or failed). The `card` is the full report and
 * is heavy, so it is fetched only on the single-run detail read — the history
 * list projects the light columns and leaves `card` out.
 */

import type { ReportCard } from "@outerlayer/report-card";

export type EvalRunStatus = "queued" | "running" | "succeeded" | "failed";

/** The wizard's per-config coordinates carried in a run's `request`. */
interface EvalRunConfig {
  id: string;
  launcher: string;
  model: string;
  baseUrl?: string;
}

/** The dispatched run request persisted on the row (the wizard's two configs
 *  plus the task/trial/budget knobs). */
interface EvalRunRequest {
  configs: EvalRunConfig[];
  taskCount?: number;
  trialsPerTask?: number;
  budgetUsd?: number;
}

/** The full single-run row, including the heavy `card`. Returned by the detail
 *  read; never shipped per-row in the history list. */
export interface EvalRunRow {
  id: string;
  app_id: string;
  environment_id: string | null;
  status: EvalRunStatus;
  repo_label: string;
  request: EvalRunRequest;
  card: ReportCard | null;
  cost_usd: number;
  error: string | null;
  created_at: string;
}

/** The history-list projection: every column the list renders, minus the heavy
 *  `card` blob (opened runs fetch the card through the detail read). */
export interface EvalRunSummary {
  id: string;
  status: EvalRunStatus;
  repo_label: string;
  request: EvalRunRequest;
  cost_usd: number;
  error: string | null;
  created_at: string;
}
