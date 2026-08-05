/**
 * Dashboard-side agent registry.
 *
 * Plain data + pure helpers, safe to import from client and server (the launch
 * dialog renders WORKER_AGENTS) — deliberately NOT `server-only`, and
 * deliberately not under `src/lib/system/` or `src/features/`: the dispatch
 * path (`lib/system/workers/worker-dispatch.ts`) and the launch UI
 * (`features/workers/components/*.tsx`) both need it, and a `"use client"`
 * module cannot import `lib/system/**` while `lib/system/**` cannot import
 * `features/**` — this is the one home both tiers can reach without a bridge.
 *
 * The authoritative adapter implementations live in the worker runner
 * (apps/worker), which the dashboard doesn't import. This mirrors just the
 * metadata the dashboard needs at preflight + in the launch UI: the agent id,
 * its display name, and the BYOK credential keys one of which must be present
 * in the environment's Vault-backed env vars. Adding an agent means adding a
 * runner adapter AND a row here (kept in sync by the drift test).
 */

interface AgentModelOption {
  /** Adapter-specific id/alias passed to the CLI (e.g. `sonnet`). */
  id: string;
  label: string;
}

interface AgentDescriptor {
  id: string;
  displayName: string;
  credentialKeys: string[];
  /**
   * Selectable models + the default one when the user doesn't choose. Absent
   * means the agent has no dashboard-side model picker and always runs the
   * CLI's own default (experimental agents whose model flags aren't wired yet).
   */
  models?: { default: string; options: AgentModelOption[] };
  /**
   * Implemented from the CLI's documented interface but not yet live-validated
   * against the real binary — surfaced as "experimental" in the launch UI.
   * Keep in sync with the runner adapters' `experimental` flag.
   */
  experimental?: boolean;
}

export const WORKER_AGENTS: AgentDescriptor[] = [
  {
    id: "claude-code",
    // API key only. Anthropic's credential policy prohibits third-party
    // services from routing requests through subscription (OAuth) credentials;
    // plan-based access would be a separate per-user feature via the Agent SDK
    // lane, never an env var. https://code.claude.com/docs/en/legal-and-compliance
    displayName: "Claude Code",
    credentialKeys: ["ANTHROPIC_API_KEY"],
    // `claude --model` aliases; the CLI resolves each to the current model so
    // these don't pin a dated id. Sonnet balances cost/quality for coding.
    models: {
      default: "sonnet",
      options: [
        { id: "opus", label: "Opus" },
        { id: "sonnet", label: "Sonnet" },
        { id: "haiku", label: "Haiku" },
      ],
    },
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    credentialKeys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    experimental: true,
  },
  {
    id: "cursor",
    displayName: "Cursor CLI",
    credentialKeys: ["CURSOR_API_KEY"],
    experimental: true,
  },
  {
    id: "opencode",
    displayName: "opencode",
    // No ANTHROPIC_API_KEY: opencode removed Claude support upstream (Anthropic
    // legal request, Feb 2026) — an injected Anthropic key would never be used.
    credentialKeys: ["OPENAI_API_KEY", "OPENCODE_API_KEY"],
    experimental: true,
  },
];

export function getAgentDescriptor(id: string): AgentDescriptor | null {
  return WORKER_AGENTS.find((a) => a.id === id) ?? null;
}

export function getAgentCredentialKeys(id: string): string[] | null {
  return getAgentDescriptor(id)?.credentialKeys ?? null;
}

/**
 * Resolve the model to run for an agent: the caller's choice when it's one the
 * agent offers, otherwise the agent's default. Returns undefined when the agent
 * has no model picker (the runner then uses the CLI's own default). Callers
 * pass the result straight to dispatch — this is the single validation point,
 * so an unknown/spoofed model can never reach the CLI.
 */
export function resolveAgentModel(agentId: string, requested?: string | null): string | undefined {
  const models = getAgentDescriptor(agentId)?.models;
  if (!models) return undefined;
  if (requested && models.options.some((o) => o.id === requested)) return requested;
  return models.default;
}
