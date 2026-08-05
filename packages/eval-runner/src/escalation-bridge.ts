// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Cloud half of the escalation queue: map env-prep's
 * `EscalationItem` onto the `env_escalation` table row + the `_alert`
 * structured log line, and build the sink the eval worker plugs into
 * `EnvPrepService`.
 *
 * Storage stays injected (`insertRow`) — this package never links a database
 * client; the worker supplies its Supabase service-role writer. A queue-write
 * failure must never fail the run: the alert line still fires (the team gets
 * notified even when the table write breaks), and the failure is logged.
 */

import type { EscalationItem, EscalationSink } from "@outerlayer/env-prep";

/** Where the escalation came from — the worker knows all three from eval_run. */
export interface EscalationContext {
  tenantId: string;
  appId: string;
  evalRunId?: string;
}

/** One `env_escalation` row, snake_cased for the table. */
export interface EnvEscalationRow {
  tenant_id: string;
  app_id: string;
  eval_run_id: string | null;
  repo: string;
  base_commit: string;
  task_ids: string[];
  last_errors: EscalationItem["lastErrors"];
  attempts: number;
  cost_usd: number;
  suggested_next_steps: string;
}

export function envEscalationRow(item: EscalationItem, ctx: EscalationContext): EnvEscalationRow {
  return {
    tenant_id: ctx.tenantId,
    app_id: ctx.appId,
    eval_run_id: ctx.evalRunId ?? null,
    repo: item.repo,
    base_commit: item.baseCommit,
    task_ids: [...item.taskIds],
    last_errors: item.lastErrors,
    attempts: item.attempts,
    cost_usd: item.costUsd,
    suggested_next_steps: item.suggestedNextSteps,
  };
}

/** The structured payload for the notification line — same `_alert` +
 * `_metric` field convention the gateway's DLQ handler uses, so the existing
 * log-based alerting (BetterStack) picks it up without new plumbing. */
export function envEscalationAlert(
  item: EscalationItem,
  ctx: EscalationContext,
): Record<string, unknown> {
  return {
    _alert: true,
    severity: "warning",
    alert_type: "env_escalation",
    _metric: true,
    metric_name: "evals.env_escalation",
    metric_value: 1,
    tenantId: ctx.tenantId,
    appId: ctx.appId,
    evalRunId: ctx.evalRunId ?? null,
    repo: item.repo,
    baseCommit: item.baseCommit,
    taskCount: item.taskIds.length,
    attempts: item.attempts,
    costUsd: item.costUsd,
    suggestedNextSteps: item.suggestedNextSteps,
  };
}

/** Sink for cloud runs: persist the ticket, then emit the alert line. */
export function persistingEscalationSink(
  ctx: EscalationContext,
  insertRow: (row: EnvEscalationRow) => Promise<void>,
  log: (line: string) => void = (line) => console.error(line),
): EscalationSink {
  return {
    async report(item) {
      try {
        await insertRow(envEscalationRow(item, ctx));
      } catch (error) {
        log(
          `[escalation] env_escalation insert failed (queue write only — the alert below still fires): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      log(`[escalation] env escalation ${JSON.stringify(envEscalationAlert(item, ctx))}`);
    },
  };
}
