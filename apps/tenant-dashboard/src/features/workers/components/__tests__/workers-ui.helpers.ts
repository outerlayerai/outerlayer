/**
 * Shared setup for Workers UI tests: absolutize relative /api fetches for
 * node's fetch (MSW intercepts the absolute form), plus canonical fixtures.
 */

export const BASE = "http://localhost:3000";

let realFetch: typeof fetch | null = null;

/** Call from beforeAll/afterAll: relative /api/... → http://localhost:3000/api/... */
export function installFetchBaseShim() {
  realFetch = globalThis.fetch;
  const prior = realFetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    prior(typeof input === "string" && input.startsWith("/") ? `${BASE}${input}` : input, init)) as typeof fetch;
}

export function removeFetchBaseShim() {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
}

export function runFixture(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    agent: "claude-code",
    task_prompt: "Add a /version endpoint",
    status: "completed",
    outcome: "changes",
    branch_name: "outerlayer/worker/version",
    pr_url: null,
    pr_number: null,
    failure_code: null,
    error_message: null,
    duration_ms: 61_000,
    created_at: "2026-07-12T00:00:00Z",
    base_branch: "main",
    cost_usd: 0.0231,
    num_turns: 4,
    ...over,
  };
}

export function environmentFixture(over: Record<string, unknown> = {}) {
  return {
    id: "env-1",
    agent: "claude-code",
    base_branch: "main",
    work_branch: "outerlayer/worker/env-abc12345",
    substrate: "local",
    status: "active",
    current_run_id: null,
    session_ref: "sess-1",
    last_active_at: null,
    created_at: "2026-07-12T00:00:00Z",
    ...over,
  };
}
