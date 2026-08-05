import type { EntitlementDeniedInfo } from "@/config/entitlements";

import {
  cancelWorkerAction,
  createEnvironmentAction,
  launchWorkerAction,
  runEnvironmentTurnAction,
} from "./actions";

/**
 * Client-facing adapters over the workers server actions. Each action resolves
 * to an `ActionResult` envelope carrying the tenancy/permission/validation
 * outcome; these adapters flatten that envelope into the plain result shape the
 * Workers components render, so a component awaits one call and branches on
 * plain fields instead of unwrapping the envelope itself.
 */

interface LaunchWorkerResult {
  runId?: string;
  status?: string;
  dispatch?: string;
  entitlement?: EntitlementDeniedInfo;
  error?: string;
}

export async function launchWorker(input: unknown): Promise<LaunchWorkerResult> {
  const result = await launchWorkerAction(input);
  if (!result.ok) return { error: result.error.message };
  const data = result.data;
  switch (data.kind) {
    case "invalid":
      return { error: data.message };
    case "entitlement":
      return { entitlement: data.denied };
    case "dispatch_failed":
      return { runId: data.runId, status: "failed", error: data.message };
    case "ok":
      return { runId: data.runId, status: data.status, dispatch: data.dispatch };
  }
}

interface CreateEnvironmentResult {
  environmentId?: string;
  runId?: string;
  status?: string;
  entitlement?: EntitlementDeniedInfo;
  error?: string;
}

export async function createEnvironment(input: unknown): Promise<CreateEnvironmentResult> {
  const result = await createEnvironmentAction(input);
  if (!result.ok) return { error: result.error.message };
  const data = result.data;
  switch (data.kind) {
    case "invalid":
      return { error: data.message };
    case "entitlement":
      return { entitlement: data.denied };
    case "dispatch_failed":
      return { environmentId: data.environmentId, error: data.message };
    case "ok":
      return { environmentId: data.environmentId, runId: data.runId, status: data.status };
  }
}

interface RunEnvironmentTurnResult {
  runId?: string;
  turnIndex?: number;
  busy?: boolean;
  error?: string;
}

export async function runEnvironmentTurn(input: unknown): Promise<RunEnvironmentTurnResult> {
  const result = await runEnvironmentTurnAction(input);
  if (!result.ok) return { error: result.error.message };
  const data = result.data;
  if (data.kind === "failed") {
    return { busy: data.busy, error: data.message };
  }
  return { runId: data.runId, turnIndex: data.turnIndex };
}

interface CancelWorkerResult {
  cancelled: boolean;
  status?: string;
  error?: string;
}

export async function cancelWorker(input: unknown): Promise<CancelWorkerResult> {
  const result = await cancelWorkerAction(input);
  if (!result.ok) return { cancelled: false, error: result.error.message };
  const data = result.data;
  switch (data.kind) {
    case "not_found":
      return { cancelled: false, error: "Run not found" };
    case "noop":
      return { cancelled: false, status: data.status };
    case "ok":
      return { cancelled: true, status: "cancelled" };
  }
}
