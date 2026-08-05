/**
 * Cloud worker runner orchestration.
 *
 * Dual-mode:
 *   - WORKER_PARAMS set  → local dev: full params inline (child of the dashboard).
 *   - WORKER_TOKEN set   → ephemeral Fly machine: fetch params via the
 *                          one-time Vault handshake.
 *
 * Flow: parse params → status(started) → clone → run agent → collect diff →
 * terminal callback. Every failure path still sends a callback so the run
 * never hangs in a non-terminal state (the reaper is only a backstop).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fetchWorkerParams } from './services/params-fetcher.js';
import { workerParamsPayloadSchema, type WorkerCallbackPayload, type WorkerParamsPayload } from './lib/schemas.js';
import { buildAgentEnv } from './lib/child-env.js';
import { getAgentAdapter } from './agents/registry.js';
import {
  checkoutWorkBranch,
  cloneRepo,
  collectWorkingTreeDiff,
  commitAndPushTurn,
  DiffTooLargeError,
  GitCloneError,
} from './services/git.js';
import { runAgentProcess } from './services/agent-process.js';
import { appendAttachmentsToTask, materializeAttachments } from './services/attachments.js';
import { Reporter } from './services/reporter.js';
import { TranscriptTee, uploadTranscript } from './services/transcript.js';
import type { WorkerAgentAdapter } from './agents/types.js';

/** Derive a safe branch slug from the task prompt. */
export function slugFromTask(task: string): string {
  const base = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base || 'task';
}

interface RawParams {
  callback_url?: unknown;
  worker_secret?: unknown;
  worker_run_id?: unknown;
  app_id?: unknown;
  git_provider?: unknown;
}

async function loadRawParams(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  if (env.WORKER_PARAMS) {
    return JSON.parse(env.WORKER_PARAMS) as Record<string, unknown>;
  }
  if (env.WORKER_PARAMS_FILE) {
    // Local dispatch hands params over via a file: an env var caps out around
    // 128 KB per entry on Linux, which base64 attachments blow straight past.
    // Single-use like the Vault token — consumed (deleted) on read.
    const text = await fs.readFile(env.WORKER_PARAMS_FILE, 'utf8');
    await fs.rm(env.WORKER_PARAMS_FILE, { force: true }).catch(() => undefined);
    return JSON.parse(text) as Record<string, unknown>;
  }
  if (env.WORKER_TOKEN) {
    return fetchWorkerParams(env);
  }
  throw new Error('worker runner requires WORKER_PARAMS / WORKER_PARAMS_FILE (local) or WORKER_TOKEN (ephemeral)');
}

/** Best-effort callback when we fail before a reporter is available. */
async function sendBareFailureCallback(
  raw: RawParams,
  failureCode: string,
  error: string,
): Promise<void> {
  const callbackUrl = typeof raw.callback_url === 'string' ? raw.callback_url : undefined;
  const workerSecret = typeof raw.worker_secret === 'string' ? raw.worker_secret : undefined;
  const workerRunId = typeof raw.worker_run_id === 'string' ? raw.worker_run_id : undefined;
  const appId = typeof raw.app_id === 'string' ? raw.app_id : undefined;
  if (!callbackUrl || !workerSecret || !workerRunId || !appId) return;
  const payload: WorkerCallbackPayload = {
    worker_run_id: workerRunId,
    app_id: appId,
    status: 'failed',
    failure_code: failureCode,
    error,
    raw_log: '',
    duration_ms: 0,
  };
  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerSecret}` },
      body: JSON.stringify(payload),
    });
  } catch {
    // Nothing more we can do; the reaper will mark the run failed.
  }
}

export async function runWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let raw: Record<string, unknown>;
  try {
    raw = await loadRawParams(env);
  } catch (err) {
    // No params → nothing to call back to. Surface + exit non-zero.
    throw err;
  }

  const parsed = workerParamsPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    await sendBareFailureCallback(
      raw as RawParams,
      'preflight_failed',
      `invalid worker params: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
    throw new Error('invalid worker params');
  }
  const params: WorkerParamsPayload = parsed.data;

  const reporter = new Reporter({
    eventsUrl: params.events_url,
    callbackUrl: params.callback_url,
    workerSecret: params.worker_secret,
    workerRunId: params.worker_run_id,
    appId: params.app_id,
  });
  reporter.start();

  // Persistent-environment turn: durable workspace, resume the agent session,
  // commit + push a checkpoint to the work branch. Split out because its
  // lifecycle (no mkdtemp, no rm, no diff-to-land) differs from one-shot.
  if (params.persistent) {
    await runPersistentTurn(params, reporter, env);
    return;
  }

  const startedAt = Date.now();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `worker-${params.worker_run_id.slice(0, 8)}-`));

  const duration = () => Date.now() - startedAt;

  try {
    reporter.enqueue([{ event_type: 'status', payload: { phase: 'started' } }]);

    const adapter = getAgentAdapter(params.agent);
    if (!adapter) {
      reporter.enqueue([{ event_type: 'error', payload: { message: `unknown agent: ${params.agent}`, source: 'runner' } }]);
      await reporter.sendCallback({
        worker_run_id: params.worker_run_id,
        app_id: params.app_id,
        status: 'failed',
        failure_code: 'preflight_failed',
        error: `unknown agent adapter: ${params.agent}`,
        raw_log: '',
        duration_ms: duration(),
      });
      return;
    }

    // Clone.
    reporter.enqueue([{ event_type: 'status', payload: { phase: 'cloning' } }]);
    try {
      await cloneRepo({
        repoUrl: params.repo_url,
        branch: params.base_branch,
        token: params.repo_token,
        provider: params.git_provider,
        targetDir: workspace,
      });
    } catch (err) {
      const message = err instanceof GitCloneError ? err.message : 'git clone failed';
      reporter.enqueue([{ event_type: 'error', payload: { message, source: 'runner' } }]);
      await reporter.sendCallback({
        worker_run_id: params.worker_run_id,
        app_id: params.app_id,
        status: 'failed',
        failure_code: 'clone_failed',
        error: message,
        raw_log: '',
        duration_ms: duration(),
      });
      return;
    }

    // Materialize user attachments into the (git-excluded) workspace dir and
    // point the agent at them via a prompt suffix.
    let task = params.task_prompt;
    try {
      const materialized = await materializeAttachments({
        workspace,
        workerRunId: params.worker_run_id,
        attachments: params.attachments ?? [],
      });
      task = appendAttachmentsToTask(task, materialized);
    } catch (err) {
      await reporter.sendCallback({
        worker_run_id: params.worker_run_id,
        app_id: params.app_id,
        status: 'failed',
        failure_code: 'attachment_failed',
        error: err instanceof Error ? err.message : 'failed to write attachments',
        raw_log: '',
        duration_ms: duration(),
      });
      return;
    }

    // Run the agent. The tee captures the raw stream-json transcript for the
    // full-fidelity session upload (every termination path — a failed run is
    // still a session worth reading).
    const transcript = new TranscriptTee();
    const agentEnv = buildAgentEnv(params.env_vars, env);
    const result = await runAgentProcess({
      adapter,
      task,
      workspace,
      env: agentEnv,
      wallClockCapS: params.wall_clock_cap_s,
      model: params.model,
      maxRawLogChars: params.caps.max_raw_log_chars,
      onEvents: (events) => reporter.enqueue(events),
      onRawLine: (line) => transcript.add(line),
    });
    const agentResult = adapter.extractResult(result.events);

    // Ship the transcript BEFORE the callback so the server's full-fidelity
    // parse usually lands first and the callback's event-bridge dedupes away.
    if (params.transcript_url) {
      await uploadTranscript(transcript, {
        url: params.transcript_url,
        workerSecret: params.worker_secret,
        workerRunId: params.worker_run_id,
      });
    }

    if (result.termination === 'timeout') {
      await reporter.sendCallback({
        worker_run_id: params.worker_run_id,
        app_id: params.app_id,
        status: 'timed_out',
        failure_code: 'wall_clock_exceeded',
        error: `agent exceeded the ${params.wall_clock_cap_s}s wall-clock cap`,
        raw_log: result.rawLogTail,
        duration_ms: duration(),
        cost_usd: agentResult?.costUsd,
        num_turns: agentResult?.numTurns,
      });
      return;
    }

    if (result.termination === 'error' || (result.exitCode !== null && result.exitCode !== 0) || agentResult?.isError) {
      await reporter.sendCallback({
        worker_run_id: params.worker_run_id,
        app_id: params.app_id,
        status: 'failed',
        failure_code: 'agent_error',
        error: `agent exited with code ${result.exitCode ?? 'error'}`,
        raw_log: result.rawLogTail,
        duration_ms: duration(),
        cost_usd: agentResult?.costUsd,
        num_turns: agentResult?.numTurns,
      });
      return;
    }

    // Collect the diff.
    reporter.enqueue([{ event_type: 'status', payload: { phase: 'collecting-diff' } }]);
    let changes;
    try {
      changes = await collectWorkingTreeDiff(workspace, {
        maxDiffFiles: params.caps.max_diff_files,
        maxDiffBytes: params.caps.max_diff_bytes,
      });
    } catch (err) {
      const isCap = err instanceof DiffTooLargeError;
      await reporter.sendCallback({
        worker_run_id: params.worker_run_id,
        app_id: params.app_id,
        status: 'failed',
        failure_code: isCap ? 'diff_too_large' : 'agent_error',
        error: err instanceof Error ? err.message : 'failed to collect diff',
        raw_log: result.rawLogTail,
        duration_ms: duration(),
        cost_usd: agentResult?.costUsd,
        num_turns: agentResult?.numTurns,
      });
      return;
    }

    const hasChanges = changes.length > 0;
    await reporter.sendCallback({
      worker_run_id: params.worker_run_id,
      app_id: params.app_id,
      status: 'succeeded',
      outcome: hasChanges ? 'changes' : 'no_changes',
      changes: hasChanges ? changes : undefined,
      branch_slug: hasChanges ? slugFromTask(params.task_prompt) : undefined,
      raw_log: result.rawLogTail,
      duration_ms: duration(),
      cost_usd: agentResult?.costUsd,
      num_turns: agentResult?.numTurns,
    });
  } finally {
    reporter.stop();
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Execute one turn of a persistent-environment worker.
 *
 * The workspace is durable (survives across turns), so we do NOT mkdtemp or rm
 * it. On the first turn we clone; on later turns the repo is already present
 * and we resume the agent's session (when the adapter supports it) so it
 * continues with memory. Every turn commits + pushes a checkpoint to the work
 * branch, and reports the (possibly new) session handle back so the next turn
 * can resume it.
 */
async function runPersistentTurn(
  params: WorkerParamsPayload,
  reporter: Reporter,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const persistent = params.persistent!;
  const startedAt = Date.now();
  const duration = () => Date.now() - startedAt;
  const workspace = persistent.workspace_path;

  const finishFail = async (failureCode: string, error: string, rawLog = '') => {
    await reporter.sendCallback({
      worker_run_id: params.worker_run_id,
      app_id: params.app_id,
      status: 'failed',
      failure_code: failureCode,
      error,
      raw_log: rawLog,
      duration_ms: duration(),
    });
  };

  try {
    reporter.enqueue([{ event_type: 'status', payload: { phase: 'started', turn: persistent.first_turn ? 'first' : 'follow-up' } }]);

    const adapter: WorkerAgentAdapter | null = getAgentAdapter(params.agent);
    if (!adapter) {
      await finishFail('preflight_failed', `unknown agent adapter: ${params.agent}`);
      return;
    }

    // First turn clones into the durable workspace; later turns reuse it.
    if (persistent.first_turn) {
      reporter.enqueue([{ event_type: 'status', payload: { phase: 'cloning' } }]);
      await fs.mkdir(workspace, { recursive: true });
      try {
        await cloneRepo({
          repoUrl: params.repo_url,
          branch: params.base_branch,
          token: params.repo_token,
          provider: params.git_provider,
          targetDir: workspace,
        });
      } catch (err) {
        await finishFail('clone_failed', err instanceof GitCloneError ? err.message : 'git clone failed');
        return;
      }
    }
    await checkoutWorkBranch(workspace, persistent.work_branch, params.base_branch);

    // This turn's attachments land in a per-run subdirectory of the durable
    // workspace (git-excluded), so earlier turns' files are never clobbered.
    let task = params.task_prompt;
    try {
      const materialized = await materializeAttachments({
        workspace,
        workerRunId: params.worker_run_id,
        attachments: params.attachments ?? [],
      });
      task = appendAttachmentsToTask(task, materialized);
    } catch (err) {
      await finishFail('attachment_failed', err instanceof Error ? err.message : 'failed to write attachments');
      return;
    }

    // Resume the session when possible; otherwise a fresh session in the same
    // (already-modified) workspace — the files carry state even without resume.
    const canResume =
      !persistent.first_turn &&
      adapter.supportsResume &&
      !!persistent.session_ref &&
      typeof adapter.resumeCommand === 'function';
    // Durable substrates hand us a volume-backed HOME so the agent's session
    // files (what --resume reads) survive between turns; the machine's rootfs
    // does not. Local substrate omits agent_home and keeps the host HOME.
    const agentBase = persistent.agent_home ? { ...env, HOME: persistent.agent_home } : env;
    if (persistent.agent_home) await fs.mkdir(persistent.agent_home, { recursive: true });
    const agentEnv = buildAgentEnv(params.env_vars, agentBase);

    const transcript = new TranscriptTee();
    const result = await runAgentProcess({
      adapter,
      task,
      workspace,
      env: agentEnv,
      wallClockCapS: params.wall_clock_cap_s,
      model: params.model,
      maxRawLogChars: params.caps.max_raw_log_chars,
      onEvents: (events) => reporter.enqueue(events),
      onRawLine: (line) => transcript.add(line),
      buildCommand: canResume
        ? (a) =>
            a.resumeCommand!(persistent.session_ref!, task, {
              workspace,
              wallClockCapS: params.wall_clock_cap_s,
              model: params.model,
            })
        : undefined,
    });

    const agentResult = adapter.extractResult(result.events);
    const newSessionRef = adapter.captureSessionRef(result.events) ?? persistent.session_ref;

    if (params.transcript_url) {
      await uploadTranscript(transcript, {
        url: params.transcript_url,
        workerSecret: params.worker_secret,
        workerRunId: params.worker_run_id,
      });
    }

    if (result.termination === 'timeout') {
      await finishFail('wall_clock_exceeded', `agent exceeded the ${params.wall_clock_cap_s}s cap`, result.rawLogTail);
      return;
    }
    if (result.termination === 'error' || (result.exitCode !== null && result.exitCode !== 0) || agentResult?.isError) {
      await finishFail('agent_error', `agent exited with code ${result.exitCode ?? 'error'}`, result.rawLogTail);
      return;
    }

    // Checkpoint the turn to the durable work branch.
    reporter.enqueue([{ event_type: 'status', payload: { phase: 'collecting-diff' } }]);
    let committed = false;
    try {
      committed = await commitAndPushTurn(workspace, persistent.work_branch, `worker turn: ${params.task_prompt}`, {
        token: params.repo_token,
        provider: params.git_provider,
      });
    } catch (err) {
      await finishFail('push_failed', err instanceof Error ? err.message : 'failed to push work branch', result.rawLogTail);
      return;
    }

    await reporter.sendCallback({
      worker_run_id: params.worker_run_id,
      app_id: params.app_id,
      status: 'succeeded',
      outcome: committed ? 'changes' : 'no_changes',
      work_branch: committed ? persistent.work_branch : undefined,
      session_ref: newSessionRef,
      raw_log: result.rawLogTail,
      duration_ms: duration(),
      cost_usd: agentResult?.costUsd,
      num_turns: agentResult?.numTurns,
    });
  } finally {
    reporter.stop();
    // Deliberately DO NOT remove the workspace — it persists for the next turn.
  }
}
