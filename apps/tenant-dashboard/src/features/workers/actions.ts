"use server";

import { authorizedAction } from "@/lib/action-kit";
import {
  dispatchWorkerRun as dispatchWorkerRunMachine,
  startWorkspaceFirstTurn,
  runWorkspaceTurn,
  teardownCancelledRun,
  workerDispatchKind,
} from "@/lib/adapters/worker-machine";
import {
  checkWorkerLaunchEntitlements,
  checkWorkerEnvironmentEntitlements,
} from "@/lib/adapters/worker-entitlements";

import { getAgentDescriptor, resolveAgentModel } from "@/lib/worker-agents";
import { workersService, attachmentMetaFrom } from "./service";
import {
  cancelRunInput,
  createEnvironmentInput,
  dispatchRunInput,
  sendTurnInput,
} from "./schemas";

// Wall-clock bounds mirror the worker_run.wall_clock_cap_s CHECK (0 < cap ≤ 3600).
const DEFAULT_WALL_CLOCK_CAP_S = 1800;
const MAX_WALL_CLOCK_CAP_S = 3600;
const MIN_WALL_CLOCK_CAP_S = 60;

function monthStartIso(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export const launchWorkerAction = authorizedAction({
  input: dispatchRunInput,
  permission: "worker_run.insert",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    if (!getAgentDescriptor(input.agent)) {
      return { kind: "invalid" as const, message: `Unknown agent: ${input.agent}` };
    }
    const model = resolveAgentModel(input.agent, input.model);

    const environmentId =
      input.environmentId ?? (await workersService.defaultEnvironmentId(ctx, input.appId));
    if (!environmentId) {
      return { kind: "invalid" as const, message: "This app has no environment to run against." };
    }

    const activeRuns = await workersService.countActiveRuns(ctx);
    const usedMinutes = Math.floor(
      (await workersService.sumRunDurationMsSince(ctx, monthStartIso())) / 60_000,
    );
    const gate = await checkWorkerLaunchEntitlements(ctx.tenantId, { activeRuns, usedMinutes });
    if (!gate.allowed) return { kind: "entitlement" as const, denied: gate.denied };

    const wallClockCapS = Math.min(
      Math.max(input.wallClockCapS ?? DEFAULT_WALL_CLOCK_CAP_S, MIN_WALL_CLOCK_CAP_S),
      MAX_WALL_CLOCK_CAP_S,
    );
    const created = await workersService.createRun(ctx, {
      appId: input.appId,
      environmentId,
      createdBy: ctx.actor.userId,
      agent: input.agent,
      model: model ?? null,
      taskPrompt: input.taskPrompt,
      attachments: attachmentMetaFrom(input.attachments),
      baseBranch: input.baseBranch ?? "",
      dispatch: workerDispatchKind(),
      wallClockCapS,
    });

    const result = await dispatchWorkerRunMachine({
      appId: input.appId,
      tenantId: ctx.tenantId,
      environmentId,
      runId: created.id,
      agent: input.agent,
      model: model ?? undefined,
      taskPrompt: input.taskPrompt,
      attachments: input.attachments,
      baseBranch: input.baseBranch ?? "",
      wallClockCapS,
    });
    if (!result.ok) {
      return { kind: "dispatch_failed" as const, runId: created.id, message: result.message };
    }
    return { kind: "ok" as const, runId: created.id, status: "provisioning", dispatch: result.dispatch };
  },
});

export const createEnvironmentAction = authorizedAction({
  input: createEnvironmentInput,
  permission: "worker_run.insert",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    if (!getAgentDescriptor(input.agent)) {
      return { kind: "invalid" as const, message: `Unknown agent: ${input.agent}` };
    }
    const model = resolveAgentModel(input.agent, input.model);

    const environmentId = await workersService.defaultEnvironmentId(ctx, input.appId);
    if (!environmentId) {
      return { kind: "invalid" as const, message: "This app has no environment to run against." };
    }

    const activeWorkspaces = await workersService.countActiveWorkspaces(ctx);
    const gate = await checkWorkerEnvironmentEntitlements(ctx.tenantId, { activeWorkspaces });
    if (!gate.allowed) return { kind: "entitlement" as const, denied: gate.denied };

    const substrate = workerDispatchKind();
    const created = await workersService.createWorkspace(ctx, {
      appId: input.appId,
      environmentId,
      createdBy: ctx.actor.userId,
      agent: input.agent,
      model: model ?? null,
      baseBranch: input.baseBranch ?? "",
      substrate,
    });

    const result = await startWorkspaceFirstTurn({
      appId: input.appId,
      workspaceId: created.id,
      taskPrompt: input.taskPrompt,
      attachments: input.attachments,
      createdBy: ctx.actor.userId,
      tenantId: ctx.tenantId,
    });
    if (!result.ok) {
      return { kind: "dispatch_failed" as const, environmentId: created.id, message: result.message };
    }
    return { kind: "ok" as const, environmentId: created.id, runId: result.runId, status: "active" };
  },
});

export const runEnvironmentTurnAction = authorizedAction({
  input: sendTurnInput,
  permission: "worker_run.update",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const result = await runWorkspaceTurn({
      appId: input.appId,
      envId: input.envId,
      taskPrompt: input.taskPrompt,
      attachments: input.attachments,
      createdBy: ctx.actor.userId,
      tenantId: ctx.tenantId,
    });
    if (!result.ok) {
      return { kind: "failed" as const, busy: result.code === "busy", message: result.message };
    }
    return { kind: "ok" as const, runId: result.runId, turnIndex: result.turnIndex };
  },
});

export const cancelWorkerAction = authorizedAction({
  input: cancelRunInput,
  permission: "worker_run.update",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const cancelled = await workersService.cancelRun(ctx, input.appId, input.runId);
    if (!cancelled) {
      const existing = await workersService.getRun(ctx, input.appId, input.runId);
      if (!existing) return { kind: "not_found" as const };
      return { kind: "noop" as const, status: existing.status };
    }
    await teardownCancelledRun({
      runId: cancelled.id,
      dispatch: cancelled.dispatch,
      machineId: cancelled.machine_id,
      workspaceId: cancelled.workspace_id,
    });
    return { kind: "ok" as const, status: "cancelled" };
  },
});
