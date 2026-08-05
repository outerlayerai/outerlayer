/**
 * Row + lifecycle types for the env-escalation queue (`env_escalation`,
 * supabase/schemas/72-env-escalation.sql).
 *
 * The row mirrors the producer's escalation payload field-for-field, so the
 * external `@outerlayer/env-prep` type round-trips into the table and back out.
 */

export interface EnvEscalationRow {
  id: string;
  app_id: string;
  eval_run_id: string | null;
  repo: string;
  base_commit: string;
  task_ids: string[];
  /** [{stage, excerpt, setup}] — most recent first, bounded by the producer. */
  last_errors: Array<{ stage?: string; excerpt?: string; setup?: string }>;
  attempts: number;
  cost_usd: number;
  suggested_next_steps: string;
  status: "open" | "acked" | "resolved";
  created_at: string;
  updated_at: string | null;
}

export type EscalationStatus = EnvEscalationRow["status"];
