/**
 * applyWorkerCallback semantics: terminal transitions, the pushing claim as
 * the idempotency gate, PR-delivery failure taxonomy, raw_log capping, and
 * Vault cleanup. The double mutates seeded rows, so replay tests exercise the
 * guard against the state the first apply actually wrote.
 */

import { applyWorkerCallback } from "../worker-callback-core";
import { workerCallbackPayloadSchema } from "../worker-payload";
import type { Logger } from "../types";
import { createNoopLogger, createWorkerTestSupabase } from "./test-supabase";

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const APP_ID = "app-1";

function seededRun(status = "running") {
  return {
    worker_run: [
      { id: RUN_ID, app_id: APP_ID, status, task_prompt: "add a version endpoint" },
    ],
  };
}

function callback(overrides: Record<string, unknown> = {}) {
  return workerCallbackPayloadSchema.parse({
    worker_run_id: RUN_ID,
    app_id: APP_ID,
    status: "succeeded",
    outcome: "no_changes",
    raw_log: "agent output",
    duration_ms: 12_345,
    ...overrides,
  });
}

const CHANGES = [
  { path: "src/version.ts", operation: "write", content: "export const v = 1;", encoding: "utf8" },
];

describe("applyWorkerCallback", () => {
  it("lands changes via landChanges and completes the run with branch + PR fields", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));
    const landChanges = vi.fn().mockResolvedValue({
      branchName: "outerlayer/worker/add-version",
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
    });

    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger, landChanges },
      callback({ outcome: "changes", changes: CHANGES, branch_slug: "add-version", cost_usd: 0.27, num_turns: 2 }),
    );

    expect(result).toEqual({ applied: true, finalStatus: "completed" });
    expect(landChanges).toHaveBeenCalledWith({
      appId: APP_ID,
      workerRunId: RUN_ID,
      taskPrompt: "add a version endpoint",
      changes: CHANGES,
      branchSlug: "add-version",
    });

    const claim = db.updatesFor("worker_run")[0]!;
    const terminal = db.updatesFor("worker_run")[1]!;
    expect(claim.payload.status).toBe("pushing");
    expect(claim.matched).toBe(1);
    expect(terminal.payload).toEqual({
      status: "completed",
      outcome: "changes",
      branch_name: "outerlayer/worker/add-version",
      pr_url: "https://github.com/o/r/pull/7",
      pr_number: 7,
      completed_at: expect.any(String),
      updated_at: expect.any(String),
      duration_ms: 12345,
      cost_usd: 0.27,
      num_turns: 2,
      raw_log: "agent output",
    });
    expect(terminal.matched).toBe(1);
    expect(db.rows.worker_run![0]!.status).toBe("completed");
  });

  it("marks push_failed (not completed) when landing the diff throws, preserving the error", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));
    const landChanges = vi.fn().mockRejectedValue(new Error("protected branch rejected"));

    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger, landChanges },
      callback({ outcome: "changes", changes: CHANGES }),
    );

    expect(result).toEqual({ applied: true, finalStatus: "failed" });
    const terminal = db.updatesFor("worker_run")[1]!;
    expect(terminal.payload.status).toBe("failed");
    expect(terminal.payload.failure_code).toBe("push_failed");
    expect(terminal.payload.error_message).toBe(
      "Landing the agent's changes failed: protected branch rejected",
    );
    expect(terminal.payload.branch_name).toBeUndefined();
  });

  it("fails with push_failed when a changes callback arrives and no landChanges hook is wired", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));

    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger },
      callback({ outcome: "changes", changes: CHANGES }),
    );

    expect(result).toEqual({ applied: true, finalStatus: "failed" });
    expect(db.rows.worker_run![0]!.failure_code).toBe("push_failed");
  });

  it("completes a no-changes success without touching branch/PR fields", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));

    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger },
      callback(),
    );

    expect(result).toEqual({ applied: true, finalStatus: "completed" });
    const terminal = db.updatesFor("worker_run")[0]!;
    expect(terminal.payload).toEqual({
      status: "completed",
      outcome: "no_changes",
      failure_code: null,
      error_message: null,
      completed_at: expect.any(String),
      updated_at: expect.any(String),
      duration_ms: 12345,
      cost_usd: null,
      num_turns: null,
      raw_log: "agent output",
    });
  });

  it.each([
    ["failed", undefined, "agent_error", "failed"],
    ["failed", "clone_failed", "clone_failed", "failed"],
    ["timed_out", undefined, "wall_clock_exceeded", "timed_out"],
  ] as const)(
    "maps a %s callback (failure_code %s) to failure_code %s",
    async (status, failureCode, expectedCode, expectedStatus) => {
      const db = createWorkerTestSupabase(seededRun("running"));

      const result = await applyWorkerCallback(
        { supabase: db.client, logger: createNoopLogger() as unknown as Logger },
        callback({
          status,
          outcome: undefined,
          failure_code: failureCode,
          error: "boom",
        }),
      );

      expect(result).toEqual({ applied: true, finalStatus: expectedStatus });
      expect(db.rows.worker_run![0]!.failure_code).toBe(expectedCode);
      expect(db.rows.worker_run![0]!.error_message).toBe("boom");
    },
  );

  it("drops a replayed callback: the second apply sees the terminal row and writes nothing", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));
    const deps = { supabase: db.client, logger: createNoopLogger() as unknown as Logger };

    const first = await applyWorkerCallback(deps, callback());
    const updatesAfterFirst = db.updates.length;
    const second = await applyWorkerCallback(deps, callback());

    expect(first).toEqual({ applied: true, finalStatus: "completed" });
    expect(second).toEqual({ applied: false, reason: "already_terminal" });
    // The replay's guarded update matched 0 rows and mutated nothing.
    expect(db.rows.worker_run![0]!.status).toBe("completed");
    expect(db.updates.length).toBe(updatesAfterFirst + 1);
    expect(db.updates[db.updates.length - 1]!.matched).toBe(0);
  });

  it("never resurrects a cancelled run — cancel wins the race", async () => {
    const db = createWorkerTestSupabase(seededRun("cancelled"));

    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger },
      callback({ outcome: "changes", changes: CHANGES }),
    );

    expect(result).toEqual({ applied: false, reason: "already_terminal" });
    expect(db.rows.worker_run![0]!.status).toBe("cancelled");
  });

  it("returns not_found for an unknown run and issues no writes", async () => {
    const db = createWorkerTestSupabase({ worker_run: [] });

    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger },
      callback(),
    );

    expect(result).toEqual({ applied: false, reason: "not_found" });
    expect(db.updates).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("persists only the TAIL of an oversized raw_log", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));
    const rawLog = "x".repeat(50) + "TAIL";

    await applyWorkerCallback(
      {
        supabase: db.client,
        logger: createNoopLogger() as unknown as Logger,
        maxRawLogChars: 10,
      },
      callback({ raw_log: rawLog }),
    );

    expect(db.rows.worker_run![0]!.raw_log).toBe("xxxxxxTAIL");
  });

  it("deletes both Vault entries (one-time token + per-run secret) after applying", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));

    await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger },
      callback(),
    );

    expect(db.rpcs).toEqual([
      { fn: "delete_secret", params: { secret_name: `worker_token_${RUN_ID}` } },
      { fn: "delete_secret", params: { secret_name: `worker_secret_${RUN_ID}` } },
    ]);
  });
});

describe("applyWorkerCallback — persistent turn (work_branch pre-pushed)", () => {
  it("records the work branch, opens a PR via ensurePullRequest, and completes", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));
    const ensurePullRequest = vi.fn().mockResolvedValue({
      branchName: "outerlayer/worker/feat",
      prUrl: "https://github.com/o/r/pull/9",
      prNumber: 9,
    });
    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger, ensurePullRequest },
      callback({ outcome: "changes", work_branch: "outerlayer/worker/feat", session_ref: "sess-2" }),
    );
    expect(result).toEqual({ applied: true, finalStatus: "completed" });
    expect(ensurePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, workBranch: "outerlayer/worker/feat" }),
    );
    const row = db.rows.worker_run![0]!;
    expect(row.status).toBe("completed");
    expect(row.branch_name).toBe("outerlayer/worker/feat");
    expect(row.pr_number).toBe(9);
    // Does NOT require a changes[] diff (persistent runner already pushed).
  });

  it("records the branch with no PR when no ensurePullRequest hook is wired (local dev)", async () => {
    const db = createWorkerTestSupabase(seededRun("running"));
    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger },
      callback({ outcome: "changes", work_branch: "outerlayer/worker/feat" }),
    );
    expect(result).toEqual({ applied: true, finalStatus: "completed" });
    expect(db.rows.worker_run![0]!.branch_name).toBe("outerlayer/worker/feat");
    expect(db.rows.worker_run![0]!.pr_url ?? null).toBeNull();
  });

  it("derives the app from the run row, never the caller-supplied payload.app_id", async () => {
    // Run X belongs to app A. A caller holding a valid secret for X (auth is the
    // route's concern) spoofs app_id = B in the payload. The git-delivery
    // context must key off the run's real app (A) — resolving app B's git
    // connection / PR / Vault would be a cross-tenant confused deputy.
    const db = createWorkerTestSupabase({
      worker_run: [
        { id: RUN_ID, app_id: "app-A", status: "running", task_prompt: "add a version endpoint" },
      ],
    });
    const landChanges = vi.fn().mockResolvedValue({
      branchName: "outerlayer/worker/x",
      prUrl: null,
      prNumber: null,
    });

    const result = await applyWorkerCallback(
      { supabase: db.client, logger: createNoopLogger() as unknown as Logger, landChanges },
      callback({ app_id: "app-B", outcome: "changes", changes: CHANGES }),
    );

    expect(result).toEqual({ applied: true, finalStatus: "completed" });
    expect(landChanges).toHaveBeenCalledWith(expect.objectContaining({ appId: "app-A" }));
    expect(landChanges).not.toHaveBeenCalledWith(expect.objectContaining({ appId: "app-B" }));
    // The claim + terminal writes scope to the run's real app, not the payload's.
    expect(db.updatesFor("worker_run")[0]!.matched).toBe(1);
    expect(db.rows.worker_run![0]!.status).toBe("completed");
  });
});
