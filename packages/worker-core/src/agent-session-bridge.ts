/**
 * Cloud-worker run → canonical AgentSession.
 *
 * A completed worker run is a coding-agent session and belongs in the Agent
 * Sessions surface next to CLI-synced seat sessions. The runner streams
 * normalized transcript events (worker_run_event) rather than the agent's raw
 * transcript, so this bridge rebuilds a canonical session from what the
 * dashboard already holds: the event stream + the run row + the terminal
 * callback metrics. Pure and Workers-safe, mirroring applyWorkerCallback, so a
 * future gateway loopback persists identically.
 *
 * Fidelity notes (deliberate):
 *  - Normalized events carry no per-turn usage → token totals stay 0 and the
 *    exact run cost is split evenly across assistant turns (the converter then
 *    rescales so SUM(span cost) equals the total to the cent). Flagged under
 *    `vendor.workerRun.costAttribution` so nobody mistakes it for measured
 *    per-turn cost.
 *  - The session id is `worker-run:<runId>` — deterministic, so a replayed
 *    callback re-persists the same TraceId and the replacing tables dedup.
 */

import type { AgentSession, Turn } from "@outerlayer/session-schema";
import type { WorkerCallbackPayload } from "./worker-payload";

/** Mirrors the runner's FILE_EDIT_TOOLS — used only as a display hint. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface WorkerRunSessionInput {
  workerRunId: string;
  /** Adapter id from worker_run.agent (e.g. 'claude-code'). */
  agentType: string;
  taskPrompt: string;
  /** worker_run_event rows, any order — sorted by seq here. */
  events: Array<{ seq: number; event_type: string; payload: Record<string, unknown> }>;
  callback: Pick<
    WorkerCallbackPayload,
    "status" | "cost_usd" | "num_turns" | "duration_ms" | "session_ref" | "failure_code" | "error"
  >;
  /** worker_run.started_at (ISO) — falls back to completedAt - duration. */
  startedAt: string | null;
  /** Callback apply time (ISO) — the session's end anchor. */
  completedAt: string;
  /** Normalized repo identity (github.com/org/repo) — the app=repo join key. */
  gitRepo?: string;
  gitBranch?: string;
}

export function workerRunSessionId(workerRunId: string): string {
  return `worker-run:${workerRunId}`;
}

/**
 * `git@github.com:acme/app.git`, `https://github.com/acme/app` →
 * `github.com/acme/app`. MUST stay in lockstep with `normalizeRemote` in
 * @outerlayer/capture (repo-identity.ts) — it produces the GitRepo join key
 * the sessions list scopes by, and a mismatch would strand cloud sessions
 * outside the app's repo view. Duplicated (not imported) because capture is a
 * Node package and this one is Workers-safe.
 */
export function normalizeRepoRemote(remote: string): string | undefined {
  let r = remote.trim();
  if (!r) return undefined;
  r = r.replace(/^ssh:\/\//, "").replace(/^https?:\/\//, "").replace(/^git:\/\//, "");
  r = r.replace(/^[^@/]+@/, ""); // drop user@ (git@, ssh user)
  r = r.replace(/:/, "/"); // scp-style host:path → host/path
  r = r.replace(/\.git$/, "").replace(/\/+$/, "");
  return r || undefined;
}

export function workerRunToAgentSession(input: WorkerRunSessionInput): AgentSession {
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const endMs = Date.parse(input.completedAt);
  const startMs =
    (input.startedAt && Date.parse(input.startedAt)) ||
    endMs - Math.max(1, input.callback.duration_ms);

  const turns: Turn[] = [
    {
      index: 0,
      role: "user",
      ts: new Date(startMs).toISOString(),
      toolCalls: [],
      text: input.taskPrompt,
    },
  ];
  const sessionEvents: AgentSession["events"] = [];
  let model: string | undefined;
  let seq = 0;
  let currentAssistant: Turn | null = null;
  const assistantTurn = (): Turn => {
    if (!currentAssistant) {
      currentAssistant = {
        index: turns.length,
        role: "assistant",
        ...(model ? { model } : {}),
        toolCalls: [],
      };
      turns.push(currentAssistant);
    }
    return currentAssistant;
  };

  for (const event of events) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "status": {
        if (typeof p.model === "string" && p.model) model = p.model;
        break;
      }
      case "agent-message": {
        // Each prose block starts a fresh assistant turn; tool-use events that
        // follow attach to it — the same shape the live run view renders.
        currentAssistant = {
          index: turns.length,
          role: "assistant",
          ...(model ? { model } : {}),
          toolCalls: [],
          ...(typeof p.text === "string" ? { text: p.text } : {}),
        };
        turns.push(currentAssistant);
        break;
      }
      case "tool-use": {
        const name = typeof p.tool === "string" && p.tool ? p.tool : "tool";
        assistantTurn().toolCalls.push({
          name,
          status: "ok",
          isEdit: FILE_EDIT_TOOLS.has(name),
          ...(typeof p.summary === "string" && p.summary ? { input: p.summary } : {}),
        });
        break;
      }
      case "file-change": {
        // Enrich the matching tool call with the touched path; the runner
        // emits file-change immediately after its tool-use.
        const calls = currentAssistant?.toolCalls ?? [];
        const last = calls[calls.length - 1];
        if (last && typeof p.path === "string" && p.path && !last.file) {
          last.file = p.path;
          last.isEdit = true;
        }
        break;
      }
      case "error": {
        // Tool-agnostic runner/agent error → session event; if a tool call is
        // in flight, it's the best-attribution error carrier (feeds ErrorCount).
        const calls = currentAssistant?.toolCalls ?? [];
        const last = calls[calls.length - 1];
        if (last && last.status === "ok") last.status = "error";
        sessionEvents.push({
          type: "api_error",
          seq: seq++,
          data: {
            ...(typeof p.source === "string" ? { source: p.source } : {}),
            ...(typeof p.message === "string" ? { message: p.message.slice(0, 500) } : {}),
          },
        });
        break;
      }
      default:
        break;
    }
  }

  // Even-split cost attribution (see header). The converter rescales to the
  // exact total, so rounding here can't drift the sum.
  const assistants = turns.filter((t) => t.role === "assistant");
  const cost = input.callback.cost_usd;
  if (typeof cost === "number" && cost > 0 && assistants.length > 0) {
    for (const t of assistants) t.costUsd = cost / assistants.length;
  }

  const title = input.taskPrompt.split("\n")[0]?.slice(0, 120) || "Cloud worker run";

  return {
    schemaVersion: 1,
    id: workerRunSessionId(input.workerRunId),
    workerKind: "cloud",
    // 'worker' origin marks a run as its own first-class population (the Workers
    // surface + the workerKind facet), distinct from ambient SDK/agent traffic
    // regardless of any origin markers the transcript itself carries.
    agent: { type: input.agentType, entrypoint: "cloud-worker", origin: "worker" },
    env: {
      ...(input.gitRepo ? { gitRepo: input.gitRepo } : {}),
      ...(input.gitBranch ? { gitBranch: input.gitBranch } : {}),
    },
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    models: model ? [model] : [],
    turns,
    events: sessionEvents,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ...(typeof cost === "number" ? { costUsd: cost } : {}),
      wallClockMs: Math.max(0, Math.round(input.callback.duration_ms)),
    },
    title,
    vendor: {
      workerRun: {
        runId: input.workerRunId,
        status: input.callback.status,
        ...(input.callback.session_ref ? { sessionRef: input.callback.session_ref } : {}),
        ...(input.callback.failure_code ? { failureCode: input.callback.failure_code } : {}),
        ...(typeof cost === "number" && cost > 0 && assistants.length > 0
          ? { costAttribution: "even-split" }
          : {}),
      },
    },
    captureTier: "full",
    warnings: [],
  };
}
