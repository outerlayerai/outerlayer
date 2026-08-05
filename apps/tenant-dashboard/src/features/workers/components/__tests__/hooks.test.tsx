// @vitest-environment jsdom
/**
 * The Workers client for the dashboard's own API routes: fetch helpers post
 * the exact wire bodies and map
 * status codes; the SWR hooks surface runs/environments/turns. HTTP runs
 * through MSW against the app's own /api/apps/... routes (absolute-URL shim —
 * node fetch can't resolve relative paths).
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { SWRConfig } from "swr";

import { server } from "@/test-helpers/msw-server";
import {
  environmentThreadRefreshInterval,
  environmentsRefreshInterval,
  formatDuration,
  isTerminalStatus,
  runDetailRefreshInterval,
  runsRefreshInterval,
  useWorkerEnvironment,
  useWorkerRun,
  useWorkerRuns,
  type WorkerEnvironmentSummary,
  type WorkerRunSummary,
} from "../../hooks";

const BASE = "http://localhost:3000";

// Relative /api/... URLs (fine in the browser) must be absolutized for node's
// fetch. Wrap whatever fetch is current (MSW has already patched it).
let realFetch: typeof fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(
      typeof input === "string" && input.startsWith("/") ? `${BASE}${input}` : input,
      init,
    )) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const run = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  agent: "claude-code",
  task_prompt: "add endpoint",
  status: "completed",
  outcome: "changes",
  branch_name: "outerlayer/worker/x",
  pr_url: null,
  pr_number: null,
  failure_code: null,
  error_message: null,
  duration_ms: 61_000,
  created_at: "2026-07-12T00:00:00Z",
  ...over,
});

describe("pure helpers", () => {
  it("classifies exactly the four terminal statuses", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("timed_out")).toBe(true);
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("provisioning")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("pushing")).toBe(false);
  });

  it("formats durations: null, seconds, minutes", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });
});

describe("poll cadences", () => {
  const summary = (status: string) => run({ status }) as unknown as WorkerRunSummary;
  const env = (current_run_id: string | null) =>
    ({ id: "e", current_run_id }) as unknown as WorkerEnvironmentSummary;

  it("run list polls at 4s only while a run is in flight", () => {
    expect(runsRefreshInterval(undefined)).toBe(0);
    expect(runsRefreshInterval({ runs: [summary("completed"), summary("failed")] })).toBe(0);
    expect(runsRefreshInterval({ runs: [summary("completed"), summary("running")] })).toBe(4000);
  });

  it("run detail polls at 2s until terminal, including before first data", () => {
    expect(runDetailRefreshInterval(undefined)).toBe(2000);
    expect(runDetailRefreshInterval({ run: summary("running") })).toBe(2000);
    expect(runDetailRefreshInterval({ run: summary("completed") })).toBe(0);
  });

  it("env list polls at 4s only while an environment is mid-turn", () => {
    expect(environmentsRefreshInterval(undefined)).toBe(0);
    expect(environmentsRefreshInterval({ environments: [env(null)] })).toBe(0);
    expect(environmentsRefreshInterval({ environments: [env(null), env("run-1")] })).toBe(4000);
  });

  it("env thread polls at 2.5s while locked OR while any turn is non-terminal", () => {
    expect(environmentThreadRefreshInterval(undefined)).toBe(0);
    expect(
      environmentThreadRefreshInterval({ environment: env(null), turns: [summary("completed")] }),
    ).toBe(0);
    expect(
      environmentThreadRefreshInterval({ environment: env("run-1"), turns: [summary("completed")] }),
    ).toBe(2500);
    expect(
      environmentThreadRefreshInterval({ environment: env(null), turns: [summary("running")] }),
    ).toBe(2500);
  });
});

describe("SWR hooks", () => {
  it("useWorkerRuns returns the run list and [] before data", async () => {
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs`, () => HttpResponse.json({ runs: [run()] })),
    );
    const { result } = renderHook(() => useWorkerRuns("org-1", "app-1"), { wrapper });
    expect(result.current.runs).toEqual([]);
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0]).toEqual(run());
  });

  it("useWorkerRuns fetches nothing without an appId", () => {
    const { result } = renderHook(() => useWorkerRuns("org-1", undefined), { wrapper });
    expect(result.current.runs).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("useWorkerRun returns the run and its ordered events", async () => {
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/run-1`, () =>
        HttpResponse.json({
          run: { ...run(), base_branch: "main", cost_usd: 0.12, num_turns: 3 },
          events: [
            { seq: 0, event_type: "status", payload: { phase: "cloning" }, created_at: "t" },
            { seq: 1, event_type: "agent-message", payload: { text: "hi" }, created_at: "t" },
          ],
        }),
      ),
    );
    const { result } = renderHook(() => useWorkerRun("org-1", "app-1", "run-1"), { wrapper });
    await waitFor(() => expect(result.current.run?.id).toBe("run-1"));
    expect(result.current.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(result.current.run?.cost_usd).toBe(0.12);
  });

  // A missing path segment must yield a null SWR key — no fetch. isLoading is
  // false synchronously only when the key is null; a mutated `&&`/ternary that
  // built a key with `undefined` in it would put SWR into the loading state.
  it.each([
    ["orgName", undefined, "app-1"],
    ["appId", "org-1", undefined],
  ] as const)("useWorkerRuns does not fetch when %s is missing", (_seg, org, app) => {
    const { result } = renderHook(() => useWorkerRuns(org, app), { wrapper });
    expect(result.current.runs).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it.each([
    ["orgName", undefined, "app-1", "run-1"],
    ["appId", "org-1", undefined, "run-1"],
    ["runId", "org-1", "app-1", undefined],
  ] as const)("useWorkerRun does not fetch when %s is missing", (_seg, org, app, runId) => {
    const { result } = renderHook(() => useWorkerRun(org, app, runId), { wrapper });
    expect(result.current.run).toBeUndefined();
    expect(result.current.events).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it.each([
    ["orgName", undefined, "app-1", "env-1"],
    ["appId", "org-1", undefined, "env-1"],
    ["envId", "org-1", "app-1", undefined],
  ] as const)("useWorkerEnvironment does not fetch when %s is missing", (_seg, org, app, envId) => {
    const { result } = renderHook(() => useWorkerEnvironment(org, app, envId), { wrapper });
    expect(result.current.environment).toBeUndefined();
    expect(result.current.turns).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("useWorkerEnvironment returns the environment and its turns", async () => {
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments/env-1`, () =>
        HttpResponse.json({
          environment: {
            id: "env-1",
            agent: "claude-code",
            base_branch: "",
            work_branch: "outerlayer/worker/env-abc",
            substrate: "local",
            status: "active",
            current_run_id: null,
            session_ref: "sess-1",
            last_active_at: null,
            created_at: "t",
          },
          turns: [run({ id: "t0" }), run({ id: "t1" })],
        }),
      ),
    );
    const { result } = renderHook(() => useWorkerEnvironment("org-1", "app-1", "env-1"), { wrapper });
    await waitFor(() => expect(result.current.environment?.id).toBe("env-1"));
    expect(result.current.turns.map((t) => t.id)).toEqual(["t0", "t1"]);
  });
});
