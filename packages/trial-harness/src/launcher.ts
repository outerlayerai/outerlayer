// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The agent-launcher seam — the harness
 * runs ONE agent CLI per arm, chosen by config. This is a first-class
 * multi-agent seam: claude-code AND codex ship in v1, others slot in behind
 * the same interface. The harness and grading are launcher-agnostic; a
 * launcher whose transcript lacks a field degrades that metric to null — it
 * never blocks grading.
 *
 * A launcher declares four things:
 *  - how to invoke the CLI headless (command + budgets + statement);
 *  - which auth env var(s) it needs (keys injected per-exec ONLY);
 *  - where its transcript lands in the sandbox;
 *  - how to parse that transcript into a TrajectorySummary.
 */

import type { AgentBudgets, TrajectorySummary } from "./types.js";

export interface LauncherInvocation {
  /** Shell command run inside the agent sandbox (cwd = repo root). */
  command: string;
  /** Auth env for THIS exec only — the sole sanctioned secrets path. */
  env: Record<string, string>;
  /** File to read back for the transcript after the agent exits. */
  transcriptPath: string;
}

export interface LauncherContext {
  statement: string;
  budgets: AgentBudgets;
  model: string;
  baseUrl?: string;
  /** Resolved secret values (from Vault) — never logged. */
  secrets: Record<string, string>;
}

export interface AgentLauncher {
  readonly id: string;
  invoke(ctx: LauncherContext): LauncherInvocation;
  parseTranscript(raw: string): TrajectorySummary;
}

function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Claude Code headless. stream-json events go to stdout; we tee them to a
 * file in the sandbox and read it back (stdout can be hundreds of MB — bound
 * at getFile time). Auth: ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL for
 * Anthropic-compatible vendor arms). Permission bypass is required headless —
 * that's WHY the sandbox is isolated and grading is fresh.
 */
export const claudeCodeLauncher: AgentLauncher = {
  id: "claude-code",
  invoke(ctx) {
    const transcriptPath = "/tmp/outerlayer/agent-transcript.jsonl";
    const flags = [
      `-p ${shq(ctx.statement)}`,
      `--max-turns ${ctx.budgets.maxTurns}`,
      "--output-format stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      `--model ${shq(ctx.model)}`,
    ].join(" ");
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: ctx.secrets.ANTHROPIC_API_KEY ?? "",
      // Sandboxes run as root, and claude-code refuses --dangerously-skip-
      // permissions under root UNLESS IS_SANDBOX is set (its documented escape
      // hatch). We ARE in an isolated, network-gated sandbox — that's the whole
      // design — so set it, or every claude-code trial dies on the first exec
      // with "cannot be used with root/sudo privileges". (Found in e2e.)
      IS_SANDBOX: "1",
    };
    if (ctx.baseUrl) env.ANTHROPIC_BASE_URL = ctx.baseUrl;
    return {
      command: `mkdir -p /tmp/outerlayer && timeout ${ctx.budgets.wallClockS}s claude ${flags} | tee ${transcriptPath}`,
      env,
      transcriptPath,
    };
  },
  parseTranscript(raw) {
    return summarizeStreamJson(raw, "claude-code");
  },
};

/**
 * OpenAI Codex CLI headless (`codex exec`, JSON output). Auth: OPENAI_API_KEY
 * (+ base_url for compatible endpoints). Its rollout JSONL is emitted to
 * stdout with --json; same tee-to-file capture.
 */
export const codexLauncher: AgentLauncher = {
  id: "codex",
  invoke(ctx) {
    const transcriptPath = "/tmp/outerlayer/codex-rollout.jsonl";
    const flags = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      `--model ${shq(ctx.model)}`,
      shq(ctx.statement),
    ].join(" ");
    const env: Record<string, string> = { OPENAI_API_KEY: ctx.secrets.OPENAI_API_KEY ?? "" };
    if (ctx.baseUrl) env.OPENAI_BASE_URL = ctx.baseUrl;
    return {
      command: `mkdir -p /tmp/outerlayer && timeout ${ctx.budgets.wallClockS}s codex ${flags} | tee ${transcriptPath}`,
      env,
      transcriptPath,
    };
  },
  parseTranscript(raw) {
    return summarizeCodexRollout(raw, "codex");
  },
};

const LAUNCHERS = new Map<string, AgentLauncher>([
  [claudeCodeLauncher.id, claudeCodeLauncher],
  [codexLauncher.id, codexLauncher],
]);

export function resolveLauncher(id: string): AgentLauncher {
  const launcher = LAUNCHERS.get(id);
  if (!launcher) {
    throw new Error(`unknown agent launcher "${id}" (have: ${[...LAUNCHERS.keys()].join(", ")})`);
  }
  return launcher;
}

export function registerLauncher(launcher: AgentLauncher): void {
  LAUNCHERS.set(launcher.id, launcher);
}

/** Parse Claude Code stream-json: one JSON object per line; tally turns,
 * tool calls/errors, and usage from assistant/result events. Unknown shapes
 * degrade to null rather than throwing. */
function summarizeStreamJson(raw: string, launcher: string): TrajectorySummary {
  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let sawUsage = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // non-JSON noise (e.g. a stray log line) — skip, don't die
    }
    const type = event.type;
    if (type === "assistant") turns += 1;
    const message = event.message as { content?: unknown; usage?: Record<string, number> } | undefined;
    if (Array.isArray(message?.content)) {
      for (const block of message.content as { type?: string; is_error?: boolean }[]) {
        if (block.type === "tool_use") toolCalls += 1;
        if (block.type === "tool_result" && block.is_error) toolErrors += 1;
      }
    }
    const usage = (message?.usage ?? (event.usage as Record<string, number> | undefined)) ?? undefined;
    if (usage) {
      sawUsage = true;
      inputTokens = (inputTokens ?? 0) + (usage.input_tokens ?? 0);
      outputTokens = (outputTokens ?? 0) + (usage.output_tokens ?? 0);
      cacheReadTokens = (cacheReadTokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    }
  }
  return {
    launcher,
    turns: turns || null,
    toolCalls: toolCalls || null,
    toolErrors,
    inputTokens: sawUsage ? inputTokens : null,
    outputTokens: sawUsage ? outputTokens : null,
    cacheReadTokens: sawUsage ? cacheReadTokens : null,
    wallClockMs: 0,
  };
}

/** Parse Codex rollout JSONL: token counts live on `token_count` events;
 * tool calls on `function_call`/`exec_command` items. */
function summarizeCodexRollout(raw: string, launcher: string): TrajectorySummary {
  let turns = 0;
  let toolCalls = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let sawUsage = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (event.type ?? (event.msg as { type?: string } | undefined)?.type) as string | undefined;
    if (type === "agent_message" || type === "assistant") turns += 1;
    if (type === "function_call" || type === "exec_command" || type === "local_shell_call") toolCalls += 1;
    const info = (event.info ?? event.usage ?? (event.msg as Record<string, unknown> | undefined)?.info) as
      | Record<string, number>
      | undefined;
    if (type === "token_count" && info) {
      sawUsage = true;
      inputTokens = (inputTokens ?? 0) + (info.input_tokens ?? info.total_input_tokens ?? 0);
      outputTokens = (outputTokens ?? 0) + (info.output_tokens ?? info.total_output_tokens ?? 0);
    }
  }
  return {
    launcher,
    turns: turns || null,
    toolCalls: toolCalls || null,
    toolErrors: null, // codex rollout doesn't mark tool errors distinctly in v1
    inputTokens: sawUsage ? inputTokens : null,
    outputTokens: sawUsage ? outputTokens : null,
    cacheReadTokens: null,
    wallClockMs: 0,
  };
}
