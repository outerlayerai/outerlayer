/**
 * The WorkerAgentAdapter seam — the single extension
 * point that makes cloud workers agent-agnostic.
 *
 * Every terminal coding agent (Claude Code, Codex, Cursor, opencode, …) is
 * integrated by implementing this interface: how to invoke it, how to parse
 * its output into normalized events, and — for persistent environments —
 * how to *resume* a prior session so a follow-up turn continues with memory.
 *
 * Resume is deliberately per-agent because each CLI does it differently
 * (`claude --resume <id>`, `codex exec resume`, `cursor-agent --resume <id>`,
 * `opencode run --session <id>`). An agent that has no native resume sets
 * `supportsResume = false`; the persistent environment still reuses the same
 * warm workspace and reconstructs context from the transcript — graceful
 * degradation, never a hard dependency on one vendor's session model.
 */

import type { WorkerEventType } from '../lib/schemas.js';

/** A parsed event before the runner assigns it a monotonic seq. */
export interface NormalizedEvent {
  event_type: WorkerEventType;
  payload: Record<string, unknown>;
}

/** Terminal metrics an adapter extracts from its result event, if it emits one. */
export interface AgentResult {
  costUsd?: number;
  numTurns?: number;
  isError: boolean;
}

export interface AgentCommand {
  argv: string[];
  env: Record<string, string>;
}

interface AgentCommandOpts {
  workspace: string;
  wallClockCapS: number;
  /** Adapter-specific model id/alias (e.g. `sonnet`); absent = the CLI default. */
  model?: string;
}

export interface WorkerAgentAdapter {
  id: string;
  displayName: string;
  /**
   * The tenant must supply at least one of these env-var names as the agent
   * credential (BYOK). Preflight checks this before compute is provisioned.
   */
  credentialKeys: { anyOf: string[] };
  /**
   * Whether this agent's CLI can resume a prior session by handle. When false,
   * persistent-environment follow-ups fall back to a fresh session in the same
   * workspace, seeded with reconstructed context.
   */
  supportsResume: boolean;
  /**
   * True when the adapter's invocation/parser are implemented from the CLI's
   * documented interface but NOT yet live-validated against the real binary in
   * this repo's e2e. The UI surfaces these as "experimental" so users opt in
   * knowingly. Claude Code is the validated reference; the rest start here.
   */
  experimental?: boolean;

  /** Build the one-shot CLI invocation for a first turn. */
  command(task: string, opts: AgentCommandOpts): AgentCommand;

  /**
   * Build the invocation for a CONTINUATION turn against an existing session.
   * Only called when `supportsResume` and a `sessionRef` is available.
   */
  resumeCommand?(sessionRef: string, task: string, opts: AgentCommandOpts): AgentCommand;

  /**
   * Map one line of the agent's stdout to zero or more normalized events.
   * Unknown/irrelevant lines return `[]`; a malformed line must not throw.
   */
  parseLine(line: string): NormalizedEvent[];

  /** Extract terminal metrics from the accumulated events, if available. */
  extractResult(events: NormalizedEvent[]): AgentResult | null;

  /**
   * Extract this agent's resume handle (its "session id") from the parsed
   * events, so the environment can persist it for the next turn. Returns null
   * if the agent didn't surface one.
   */
  captureSessionRef(events: NormalizedEvent[]): string | null;
}
