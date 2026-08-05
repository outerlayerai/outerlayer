import "server-only";

/**
 * EnvEscalationService — reads + lifecycle transitions for the env-escalation
 * queue (`env_escalation`, supabase/schemas/72-env-escalation.sql).
 *
 * Rows are WRITTEN by the eval worker through the gateway bridge
 * (@outerlayer/eval-runner escalation-bridge) with the service-role client;
 * the dashboard only lists them and moves them through the lifecycle:
 *
 *   open → acked      (someone owns it)
 *   open → resolved   (fixed/descoped without a hand-off)
 *   acked → resolved
 *
 * `resolved` is terminal — reopening is a new escalation from a new failed
 * build, so the queue's history stays an honest record. Every method runs its
 * queries through the caller's RLS-scoped `ctx.db`: `env_escalation.read` /
 * `.update` plus the tenant match are enforced by the policies, so a row
 * outside the caller's tenant is indistinguishable from a missing one (no
 * oracle). The service opens no client of its own and reads no request state —
 * `ServiceContext` carries the tenant-scoped client and the actor.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";

import type { EnvEscalationRow, EscalationStatus } from "./types";
import type { TransitionEscalationInput } from "./schemas";

const TRANSITIONS: Record<EscalationStatus, EscalationStatus[]> = {
  open: ["acked", "resolved"],
  acked: ["resolved"],
  resolved: [],
};

export class EnvEscalationTransitionError extends Error {
  constructor(
    public readonly from: EscalationStatus,
    public readonly to: EscalationStatus,
  ) {
    super(`cannot move an escalation from "${from}" to "${to}"`);
    this.name = "EnvEscalationTransitionError";
  }
}

const COLUMNS =
  "id, app_id, eval_run_id, repo, base_commit, task_ids, last_errors, attempts, cost_usd, suggested_next_steps, status, created_at, updated_at";

class EnvEscalationService {
  /**
   * Newest-first escalations for an app. Defaults to the actionable set
   * (open + acked) — the queue view; pass explicit statuses for history.
   */
  async list(
    ctx: ServiceContext,
    appId: string,
    statuses: EscalationStatus[] = ["open", "acked"],
    limit = 100,
  ): Promise<EnvEscalationRow[]> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("env_escalation")
      .select(COLUMNS)
      .eq("app_id", appId)
      .in("status", statuses)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`env_escalation list failed: ${error.message}`);
    return (data ?? []) as unknown as EnvEscalationRow[];
  }

  /**
   * Move an escalation through the lifecycle. Returns the updated row, or
   * null when no row is visible under RLS (unknown id OR foreign tenant —
   * deliberately the same outcome). Throws EnvEscalationTransitionError on
   * an illegal move.
   *
   * No audit triggers exist on this table (matches eval_run/worker_run), so
   * updated_at/updated_by are stamped here explicitly — updated_by is the
   * request actor, never a positional caller argument.
   */
  async transition(
    ctx: ServiceContext,
    { appId, escalationId, status: to }: TransitionEscalationInput,
  ): Promise<EnvEscalationRow | null> {
    const db = ctx.db as SupabaseClient;

    const { data: current, error: readError } = await db
      .from("env_escalation")
      .select("id, status")
      .eq("app_id", appId)
      .eq("id", escalationId)
      .maybeSingle();
    if (readError) throw new Error(`env_escalation read failed: ${readError.message}`);
    if (!current) return null;

    const from = current.status as EscalationStatus;
    if (!TRANSITIONS[from]?.includes(to)) {
      throw new EnvEscalationTransitionError(from, to);
    }

    const { data, error } = await db
      .from("env_escalation")
      .update({ status: to, updated_at: new Date().toISOString(), updated_by: ctx.actor.userId })
      .eq("app_id", appId)
      .eq("id", escalationId)
      // Guard the read-then-write race: only move the row if it is still in
      // the state we validated. A concurrent transition wins and this update
      // matches zero rows → null, same as not-found.
      .eq("status", from)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`env_escalation update failed: ${error.message}`);
    return (data as unknown as EnvEscalationRow) ?? null;
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const escalationsService = new EnvEscalationService();
