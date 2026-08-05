/**
 * Wire schemas for the worker run lifecycle.
 *
 * Three payloads cross the dashboard <-> runner boundary:
 *
 *   1. Params payload — assembled by the dashboard at dispatch, delivered to
 *      the runner either inline (local child process, WORKER_PARAMS env) or
 *      via the one-time Vault token handshake (ephemeral Fly machine, GET
 *      /api/internal/worker-params). Carries everything secret; the Fly
 *      machine config itself never does.
 *   2. Event batches — see worker-events.ts.
 *   3. Callback payload — the runner's terminal report, POSTed to
 *      /api/internal/worker-callback with the per-run worker secret.
 *
 * The machine-side runner (apps/worker) deliberately duplicates these schemas
 * instead of importing this package so its Fly image ships with zero
 * workspace dependencies. Changing a field here
 * means changing the runner's copy in the same PR.
 */

import { z } from "zod";

/** Caps enforced by the runner; the callback route re-enforces raw_log. */
export const workerCapsSchema = z.object({
  max_diff_files: z.number().int().positive(),
  max_diff_bytes: z.number().int().positive(),
  max_raw_log_chars: z.number().int().positive(),
});

export type WorkerCaps = z.infer<typeof workerCapsSchema>;

export const DEFAULT_WORKER_CAPS: WorkerCaps = {
  max_diff_files: 200,
  max_diff_bytes: 5 * 1024 * 1024,
  max_raw_log_chars: 200_000,
};

/**
 * User-uploaded files that ride along with the task prompt. Content is base64;
 * the runner materializes them into a git-excluded directory inside the
 * workspace and appends their paths to the agent prompt. Caps keep the params
 * payload within what Vault staging and the dashboard request path tolerate.
 *
 * Inline-by-value is deliberate: the params payload is already the secure
 * channel (Vault one-time token / local params file), and unlike trace ingest
 * there is no 128KB queue-message limit forcing an offload. If the caps ever
 * need to grow past what Vault staging tolerates, add a by-reference variant
 * (blob key + fetch) modeled on gateway-core's blob-offload rather than
 * raising these limits.
 */
export const MAX_WORKER_ATTACHMENTS = 4;
export const MAX_WORKER_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_WORKER_ATTACHMENT_TOTAL_BYTES = 3 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte length of a base64 string (0 for malformed padding/length). */
export function decodedBase64Bytes(content: string): number {
  if (content.length % 4 !== 0 || !BASE64_RE.test(content)) return 0;
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return (content.length / 4) * 3 - padding;
}

/**
 * Attachments exist to hand images/documents/data files to a coding agent, so
 * the gate is deliberately loose: only size-heavy media that no terminal agent
 * can consume is rejected. Size caps are the real limit.
 */
export function isAllowedWorkerAttachmentMime(mime: string): boolean {
  return !/^(video|audio|font)\//i.test(mime);
}

export const workerAttachmentSchema = z.object({
  /** Display/file name; the runner sanitizes it before writing to disk. */
  name: z.string().min(1).max(255),
  mime: z.string().max(255),
  /** File bytes, base64. */
  content: z.string().min(1).regex(BASE64_RE, "content must be base64"),
});

export type WorkerAttachment = z.infer<typeof workerAttachmentSchema>;

/** The validated attachment list: count, per-file, total, and mime gates. */
export const workerAttachmentListSchema = z
  .array(workerAttachmentSchema)
  .max(MAX_WORKER_ATTACHMENTS, `at most ${MAX_WORKER_ATTACHMENTS} attachments`)
  .superRefine((attachments, ctx) => {
    let total = 0;
    for (const [index, attachment] of attachments.entries()) {
      const bytes = decodedBase64Bytes(attachment.content);
      if (bytes === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "content"],
          message: `attachment "${attachment.name}" is not valid base64`,
        });
        continue;
      }
      if (bytes > MAX_WORKER_ATTACHMENT_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "content"],
          message: `attachment "${attachment.name}" exceeds the ${MAX_WORKER_ATTACHMENT_BYTES / (1024 * 1024)} MB per-file limit`,
        });
      }
      if (!isAllowedWorkerAttachmentMime(attachment.mime)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "mime"],
          message: `attachment type "${attachment.mime}" is not supported`,
        });
      }
      total += bytes;
    }
    if (total > MAX_WORKER_ATTACHMENT_TOTAL_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `attachments exceed the ${MAX_WORKER_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB total limit`,
      });
    }
  });

export const workerParamsPayloadSchema = z.object({
  worker_run_id: z.string().min(1),
  app_id: z.string().min(1),
  tenant_id: z.string().min(1),

  /** Adapter id, e.g. 'claude-code'. The runner rejects unknown adapters. */
  agent: z.string().min(1),
  /**
   * Model the agent CLI should use (adapter-specific id/alias, e.g. `sonnet`).
   * Optional — absent means the agent's own default. The adapter maps it to
   * the CLI's model flag; unknown-to-the-CLI values fail inside the agent.
   */
  model: z.string().min(1).optional(),
  task_prompt: z.string().min(1),

  /**
   * User-uploaded files for this run/turn. The runner writes them into a
   * git-excluded workspace directory and tells the agent where they are.
   */
  attachments: z.array(workerAttachmentSchema).optional(),

  /** https URL of the repo (no credentials embedded). */
  repo_url: z.string().min(1),
  /** Short-lived provider token used only for the clone; never logged. */
  repo_token: z.string().min(1),
  /** `local` clones from / lands to a local bare repo — dev + e2e only. */
  git_provider: z.enum(["github", "local"]),
  base_branch: z.string().min(1),

  /**
   * Tenant env vars (Vault-resolved) exposed to the agent process — includes
   * the agent credential (e.g. ANTHROPIC_API_KEY). OuterLayer reserved keys
   * are scrubbed by the runner before the agent starts.
   */
  env_vars: z.record(z.string(), z.string()),

  /** Where the runner reports: POST event batches + terminal callback. */
  events_url: z.string().min(1),
  callback_url: z.string().min(1),
  /**
   * Where the runner ships the agent's RAW stdout transcript after the run
   * (AC-9 cloud fidelity): the dashboard parses it with the same
   * @outerlayer/capture adapters as seat sessions. Optional — absent (old
   * dispatcher, oversized transcript, upload failure) the session degrades to
   * the normalized-event bridge instead of being lost.
   */
  transcript_url: z.string().min(1).optional(),
  /** Per-run bearer secret for events_url/callback_url. */
  worker_secret: z.string().min(1),

  wall_clock_cap_s: z.number().int().positive().max(3600),
  caps: workerCapsSchema,

  /**
   * Present for a persistent-environment turn. The runner then operates in
   * a durable workspace it does NOT delete, resumes the agent session when a
   * `session_ref` is given, and commits a checkpoint to `work_branch` each turn
   * (accumulating a branch/PR) rather than landing a one-shot diff.
   */
  persistent: z
    .object({
      /** Durable workspace path that survives across turns (the "environment"). */
      workspace_path: z.string().min(1),
      /** Branch that accumulates this environment's work; pushed each turn. */
      work_branch: z.string().min(1),
      /** Agent session handle to resume; absent on the first turn. */
      session_ref: z.string().optional(),
      /** True only for the first turn (clone into the fresh workspace). */
      first_turn: z.boolean(),
      /**
       * HOME for the agent process. Durable substrates point this into the
       * environment's volume so session files (`--resume` state) survive
       * between turns; absent = the runner host's own HOME (local substrate).
       */
      agent_home: z.string().min(1).optional(),
    })
    .optional(),
});

export type WorkerParamsPayload = z.infer<typeof workerParamsPayloadSchema>;

/**
 * One changed file in the runner's terminal report, replayed server-side into
 * the git provider as a single squashed commit. Wire-level shape — the
 * dashboard maps it onto the git service's FileChange. Binary files ride as
 * base64.
 */
export const workerFileChangeSchema = z.object({
  path: z.string().min(1),
  operation: z.enum(["write", "delete"]),
  /** Required for 'write'; absent for 'delete'. */
  content: z.string().optional(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});

export type WorkerFileChange = z.infer<typeof workerFileChangeSchema>;

/**
 * Body of POST /api/internal/worker-transcript — the raw agent transcript,
 * gzipped then base64'd (JSON transport keeps the route on the same
 * secret-auth + zod conventions as events/callback). Caps sized for real
 * transcripts: 24 MiB of base64 ≈ 18 MiB gzip ≈ 100+ MiB of JSONL — far past
 * any session worth keeping; the runner skips the upload above its own raw
 * cap rather than truncating (a torn JSONL tail parses worse than the
 * event-bridge fallback renders).
 */
export const MAX_TRANSCRIPT_BASE64_CHARS = 24 * 1024 * 1024;

export const workerTranscriptPayloadSchema = z.object({
  worker_run_id: z.string().min(1),
  encoding: z.literal("gzip+base64"),
  /** Gzipped transcript bytes, base64-encoded. */
  data: z.string().min(1).max(MAX_TRANSCRIPT_BASE64_CHARS),
});

export type WorkerTranscriptPayload = z.infer<typeof workerTranscriptPayloadSchema>;

export const workerCallbackPayloadSchema = z
  .object({
    worker_run_id: z.string().min(1),
    app_id: z.string().min(1),
    status: z.enum(["succeeded", "failed", "timed_out"]),
    outcome: z.enum(["changes", "no_changes"]).optional(),
    changes: z.array(workerFileChangeSchema).optional(),
    /** Runner-suggested branch slug derived from the task; server sanitizes. */
    branch_slug: z.string().optional(),
    failure_code: z.string().optional(),
    /** Human-readable error; the runner scrubs tokens before sending. */
    error: z.string().optional(),
    raw_log: z.string(),
    duration_ms: z.number().nonnegative(),
    cost_usd: z.number().nonnegative().optional(),
    num_turns: z.number().int().nonnegative().optional(),
    /**
     * Persistent-turn results: the agent's resume handle to persist for the
     * next turn, and the work branch the runner committed/pushed to.
     */
    session_ref: z.string().optional(),
    work_branch: z.string().optional(),
  })
  .refine(
    (p) => p.status !== "succeeded" || p.outcome !== undefined,
    "succeeded callbacks must carry an outcome",
  )
  .refine(
    // Ephemeral runs deliver a diff (changes[]) for the server to land;
    // persistent turns push their own work_branch, so either satisfies "changes".
    (p) => p.outcome !== "changes" || (p.changes?.length ?? 0) > 0 || !!p.work_branch,
    "outcome 'changes' requires either a non-empty changes array or a work_branch",
  );

export type WorkerCallbackPayload = z.infer<typeof workerCallbackPayloadSchema>;
