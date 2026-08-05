/**
 * Wire schemas — a DELIBERATE duplicate of @repo/worker-core's worker-payload
 * and worker-events, so the Fly image ships with no workspace dependencies
 * Any change to the protocol must land in both
 * copies in the same PR; a drift test in @repo/worker-core guards this.
 */

import { z } from 'zod';

const workerCapsSchema = z.object({
  max_diff_files: z.number().int().positive(),
  max_diff_bytes: z.number().int().positive(),
  max_raw_log_chars: z.number().int().positive(),
});

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** User-uploaded files riding with the task; content is base64. */
const workerAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().max(255),
  content: z.string().min(1).regex(BASE64_RE, 'content must be base64'),
});

export type WorkerAttachment = z.infer<typeof workerAttachmentSchema>;

export const workerParamsPayloadSchema = z.object({
  worker_run_id: z.string().min(1),
  app_id: z.string().min(1),
  tenant_id: z.string().min(1),
  agent: z.string().min(1),
  /** Adapter-specific model id/alias (e.g. `sonnet`); absent = the CLI default. */
  model: z.string().min(1).optional(),
  task_prompt: z.string().min(1),
  attachments: z.array(workerAttachmentSchema).optional(),
  repo_url: z.string().min(1),
  repo_token: z.string().min(1),
  git_provider: z.enum(['github', 'local']),
  base_branch: z.string().min(1),
  env_vars: z.record(z.string(), z.string()),
  events_url: z.string().min(1),
  callback_url: z.string().min(1),
  /** Raw-transcript upload target (AC-9 cloud fidelity); absent = skip. */
  transcript_url: z.string().min(1).optional(),
  worker_secret: z.string().min(1),
  wall_clock_cap_s: z.number().int().positive().max(3600),
  caps: workerCapsSchema,
  persistent: z
    .object({
      workspace_path: z.string().min(1),
      work_branch: z.string().min(1),
      session_ref: z.string().optional(),
      first_turn: z.boolean(),
      // HOME for the agent on durable substrates (volume-backed session files).
      agent_home: z.string().min(1).optional(),
    })
    .optional(),
});

export type WorkerParamsPayload = z.infer<typeof workerParamsPayloadSchema>;

const WORKER_EVENT_TYPES = [
  'agent-message',
  'tool-use',
  'file-change',
  'status',
  'result',
  'error',
] as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

export interface WorkerEvent {
  seq: number;
  event_type: WorkerEventType;
  payload: Record<string, unknown>;
}

export interface WorkerFileChange {
  path: string;
  operation: 'write' | 'delete';
  content?: string;
  encoding: 'utf8' | 'base64';
}

export interface WorkerCallbackPayload {
  worker_run_id: string;
  app_id: string;
  status: 'succeeded' | 'failed' | 'timed_out';
  outcome?: 'changes' | 'no_changes';
  changes?: WorkerFileChange[];
  branch_slug?: string;
  failure_code?: string;
  error?: string;
  raw_log: string;
  duration_ms: number;
  cost_usd?: number;
  num_turns?: number;
  session_ref?: string;
  work_branch?: string;
}
