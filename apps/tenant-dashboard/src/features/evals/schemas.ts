import { z } from "zod";

/**
 * A single wizard config: the coding agent to run (`launcher`) and the model it
 * drives. `baseUrl` is optional (a self-hosted / proxied model endpoint).
 */
const evalRunConfig = z.object({
  id: z.string().min(1),
  launcher: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
});

/**
 * The launch input. A Report Card compares exactly two configs, so the array is
 * length-pinned at the boundary, so the "exactly two configs" rejection happens
 * before any secret resolution or admin work. `environmentId`
 * names the environment whose Vault vars supply the agents' model keys; it is
 * required because a run with no keys fails every trial.
 */
export const launchEvalRunInput = z.object({
  appId: z.uuid(),
  environmentId: z.uuid(),
  repoLabel: z.string().default(""),
  taskCount: z.number().int().nonnegative().default(0),
  trialsPerTask: z.number().int().positive().default(1),
  budgetUsd: z.number().nonnegative().default(0),
  configs: z.array(evalRunConfig).length(2),
});

export type LaunchEvalRunInput = z.infer<typeof launchEvalRunInput>;

/** The history-refresh input: just the app to list runs for. */
export const listEvalRunsInput = z.object({
  appId: z.uuid(),
});
