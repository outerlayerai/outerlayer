import { z } from "zod";
import { workerAttachmentListSchema } from "@repo/worker-core";

/**
 * Input schemas for the worker mutation actions. `z.uuid()` is strict RFC4122,
 * so `appId` / `envId` / `runId` must be real ids. Attachment payloads reuse the
 * worker-core wire contract (count, per-file and total size, mime gate) so the
 * launch and turn paths can't drift from the runner's expectations.
 */

const taskPrompt = z.string().trim().min(1, "taskPrompt is required.");
const attachments = workerAttachmentListSchema.optional();

export const dispatchRunInput = z.object({
  appId: z.uuid(),
  agent: z.string().min(1),
  model: z.string().optional(),
  taskPrompt,
  attachments,
  baseBranch: z.string().optional(),
  environmentId: z.uuid().optional(),
  wallClockCapS: z.number().int().positive().optional(),
});

export const createEnvironmentInput = z.object({
  appId: z.uuid(),
  agent: z.string().min(1),
  model: z.string().optional(),
  taskPrompt,
  attachments,
  baseBranch: z.string().optional(),
});

export const sendTurnInput = z.object({
  appId: z.uuid(),
  envId: z.uuid(),
  taskPrompt,
  attachments,
});

export const cancelRunInput = z.object({
  appId: z.uuid(),
  runId: z.uuid(),
});
