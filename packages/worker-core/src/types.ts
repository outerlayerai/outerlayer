/**
 * Cloud Workers core types.
 *
 * Import-safe — pure type module, no runtime dependencies beyond the
 * generated Supabase types. Bundles into both the dashboard and the
 * Workers gateway.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@repo/db-types";

/** Properly typed Supabase client with Database schema. */
export type SupabaseClientType = SupabaseClient<Database>;

/**
 * Structural logger contract. Callers pass the dashboard's server logger or
 * a stub; this package never imports a concrete logger.
 */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): Promise<void>;
  error(error: Error, context?: Record<string, unknown>): Promise<void>;
  withAppId(appId: string): {
    info(message: string, context?: Record<string, unknown>): Promise<void>;
    error(error: Error, context?: Record<string, unknown>): Promise<void>;
  };
}

/** Run lifecycle states — mirrors the chk_worker_run_status CHECK constraint. */
export type WorkerRunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "pushing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Terminal states: once reached, no transition may leave them. */
export const TERMINAL_WORKER_RUN_STATUSES: readonly WorkerRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export function isTerminalWorkerRunStatus(status: string): boolean {
  return (TERMINAL_WORKER_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Machine-readable failure taxonomy recorded in worker_run.failure_code.
 * error_message carries the human-readable (token-scrubbed) detail.
 */
export type WorkerFailureCode =
  | "preflight_failed"
  | "dispatch_failed"
  | "clone_failed"
  | "agent_error"
  | "diff_too_large"
  | "wall_clock_exceeded"
  | "push_failed"
  | "callback_missing";
