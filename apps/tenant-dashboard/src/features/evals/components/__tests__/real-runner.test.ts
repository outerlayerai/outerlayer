/**
 * Unit tests for the real eval-runner client.
 *
 * runRealEval dispatches a run through the launch server action and polls the
 * run-by-id route until it terminates. These pin the contract the UI depends
 * on: the returned card/cost/runId on success, and that a denied launch, a
 * failed dispatch, a failed run, a refused status read, and a poll timeout each
 * surface as a throw naming what happened (never a silent hang or a bogus card).
 *
 * The split those cases turn on: a status the poll cannot outlast — no session,
 * no permission, no such run — must end the poll immediately, because retrying
 * it to the deadline reports a timeout, and "the run timed out" is a claim about
 * a run still executing. A status that can clear on its own keeps polling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLaunch, mockRefresh } = vi.hoisted(() => ({
  mockLaunch: vi.fn(),
  mockRefresh: vi.fn(),
}));
vi.mock("@/features/evals/actions", () => ({ launchEvalRun: mockLaunch, refreshEvalRuns: mockRefresh }));

import { isRealRunnerEnabled, loadRunDetail, refreshRunHistory, runRealEval } from "../real-runner";
import { EvalRunError } from "../run-error";
import type { EvalRunRequest } from "../fake-runner";

const REQ: EvalRunRequest = {
  repoLabel: "acme/x",
  taskIds: ["t-0", "t-1", "t-2"],
  configs: [
    { id: "opus", launcher: "claude-code", model: "claude-opus-4-8" },
    { id: "glm", launcher: "claude-code", model: "glm-5.2" },
  ],
  trialsPerTask: 1,
  budgetUsd: 30,
  scenario: "directional",
};

const CARD = { verdict: "clear" };

/** A fetch Response stub with the fields runRealEval reads. */
function res(ok: boolean, body: unknown, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A non-2xx stub whose body is not JSON, so the message can only come from the
 *  status. */
function nonJsonRes(status: number) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token '<'");
    },
    text: async () => "<html>gateway</html>",
  };
}

/**
 * The whole user-facing contract of a thrown run failure, as one comparable
 * object — asserting it with `toEqual` pins the message, the outcome kind, the
 * retry offer, and the status together, and fails on a drifted extra field.
 */
async function failureOf(promise: Promise<unknown>) {
  const thrown = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(thrown).toBeInstanceOf(EvalRunError);
  const { message, kind, retryable, status } = thrown as EvalRunError;
  return { message, kind, retryable, status };
}

beforeEach(() => {
  mockLaunch.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runRealEval — dispatch + poll", () => {
  it("dispatches via the launch action, polls once, and returns the card, cost, and runId", async () => {
    mockLaunch.mockResolvedValue({ ok: true, data: { runId: "run-1", status: "running" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(true, { run: { id: "run-1", status: "succeeded", card: CARD, cost_usd: 1.25, error: null } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runRealEval("app-1", "org-1", "env-1", REQ);

    expect(result).toEqual({ card: CARD, spentUsd: 1.25, runId: "run-1" });

    // dispatch called the launch action with the request-shaped input
    expect(mockLaunch).toHaveBeenCalledWith({
      appId: "app-1",
      environmentId: "env-1",
      repoLabel: "acme/x",
      taskCount: 3,
      trialsPerTask: 1,
      budgetUsd: 30,
      configs: [
        { id: "opus", launcher: "claude-code", model: "claude-opus-4-8", baseUrl: undefined },
        { id: "glm", launcher: "claude-code", model: "glm-5.2", baseUrl: undefined },
      ],
    });
    // poll hit the canonical org-scoped run-by-id route
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/orgs/org-1/apps/app-1/evals/runs/run-1?appId=app-1");
  });

  it("throws the action's error when the launch is denied, and does not offer a retry", async () => {
    mockLaunch.mockResolvedValue({ ok: false, error: { code: "forbidden", message: "Permission denied: eval_run.insert" } });
    expect(await failureOf(runRealEval("app-1", "org-1", "env-1", REQ))).toEqual({
      message: "Permission denied: eval_run.insert",
      kind: "dispatch_failed",
      retryable: false,
      status: undefined,
    });
  });

  it("offers a retry when the launch failed internally rather than being refused", async () => {
    mockLaunch.mockResolvedValue({ ok: false, error: { code: "internal_error", message: "db exploded" } });
    expect(await failureOf(runRealEval("app-1", "org-1", "env-1", REQ))).toEqual({
      message: "db exploded",
      kind: "dispatch_failed",
      retryable: true,
      status: undefined,
    });
  });

  it("throws the dispatch error when the run fails to start (no key set)", async () => {
    mockLaunch.mockResolvedValue({ ok: true, data: { runId: "run-x", status: "failed", error: "no key set" } });
    expect(await failureOf(runRealEval("app-1", "org-1", "env-1", REQ))).toEqual({
      message: "no key set",
      kind: "run_failed",
      retryable: true,
      status: undefined,
    });
  });

  it("throws the run's error when the run terminates failed during the poll", async () => {
    mockLaunch.mockResolvedValue({ ok: true, data: { runId: "run-2", status: "running" } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(res(true, { run: { id: "run-2", status: "failed", card: null, cost_usd: 0, error: "executor crashed" } })),
    );
    // A run the backend graded as failed is a fact about the run, distinct from
    // never having learned its status at all.
    expect(await failureOf(runRealEval("app-1", "org-1", "env-1", REQ))).toEqual({
      message: "executor crashed",
      kind: "run_failed",
      retryable: true,
      status: undefined,
    });
  });

  it("keeps polling through non-terminal statuses, then resolves on success", async () => {
    vi.useFakeTimers();
    mockLaunch.mockResolvedValue({ ok: true, data: { runId: "run-3", status: "running" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(false, {}, 502)) // transient poll error — ignored
      .mockResolvedValueOnce(res(true, { run: { id: "run-3", status: "running", card: null, cost_usd: 0, error: null } }))
      .mockResolvedValueOnce(res(true, { run: { id: "run-3", status: "succeeded", card: CARD, cost_usd: 2, error: null } }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = runRealEval("app-1", "org-1", undefined, REQ);
    // two 2s poll gaps between the three GET polls
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toEqual({ card: CARD, spentUsd: 2, runId: "run-3" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws a timeout once the poll deadline passes, distinct from a failed status read", async () => {
    // useFakeTimers fakes both setTimeout and Date, so advancing the clock past
    // the 15-minute deadline makes the next poll observe Date.now() > deadline.
    vi.useFakeTimers();
    mockLaunch.mockResolvedValue({ ok: true, data: { runId: "run-4", status: "running" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res(true, { run: { id: "run-4", status: "running", card: null, cost_usd: 0, error: null } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = failureOf(runRealEval("app-1", "org-1", "env-1", REQ));
    await vi.advanceTimersByTimeAsync(15 * 60 * 1_000 + 2_000);
    // A run still executing when the client gave up waiting — its own copy, not
    // the copy a refused status read produces.
    expect(await outcome).toEqual({
      message: "The eval run timed out.",
      kind: "timed_out",
      retryable: true,
      status: undefined,
    });
  });
});

describe("runRealEval — a status read the server refuses", () => {
  beforeEach(() => {
    mockLaunch.mockResolvedValue({ ok: true, data: { runId: "run-9", status: "running" } });
  });

  /**
   * Each of these ends the poll on the FIRST response. The single-call
   * assertion is the one that matters: retrying any of them would only delay
   * the identical refusal until the 15-minute deadline and then report a
   * timeout, which describes a run that is still executing — something these
   * responses say nothing about.
   */
  it.each([
    [401, "Your session expired. Sign in again to see this run's result."],
    [403, "You don't have permission to read this benchmark run."],
    [404, "This benchmark run is no longer available."],
  ])("ends the poll at once on %i rather than waiting out the deadline", async (status, message) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(res(false, { error: { code: "x", message: "raw" } }, status));
    vi.stubGlobal("fetch", fetchMock);

    // No timer advance: a poll that ends on the first response needs none, so
    // this rejecting under frozen time is itself proof the loop did not sleep.
    expect(await failureOf(runRealEval("app-1", "org-1", "env-1", REQ))).toEqual({
      message,
      kind: "poll_failed",
      retryable: false,
      status,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/orgs/org-1/apps/app-1/evals/runs/run-9?appId=app-1");
  });

  it("names the status and the server's message for a terminal status with no dedicated copy", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res(false, { error: { code: "invalid_field_value", message: "appId path segment and query must match" } }, 400));
    vi.stubGlobal("fetch", fetchMock);

    expect(await failureOf(runRealEval("app-1", "org-1", "env-1", REQ))).toEqual({
      message: "Couldn't read the benchmark run's status (400): appId path segment and query must match",
      kind: "poll_failed",
      retryable: false,
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still names the status when the error body is not JSON", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(nonJsonRes(400)));

    expect(await failureOf(runRealEval("app-1", "org-1", "env-1", REQ))).toEqual({
      message: "Couldn't read the benchmark run's status (400).",
      kind: "poll_failed",
      retryable: false,
      status: 400,
    });
  });

  it.each([408, 429, 500, 503])("keeps polling through %i, which can clear on its own", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(false, {}, status))
      .mockResolvedValueOnce(res(true, { run: { id: "run-9", status: "succeeded", card: CARD, cost_usd: 3, error: null } }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = runRealEval("app-1", "org-1", "env-1", REQ);
    // One 2s poll gap between the refused read and the succeeding one.
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(promise).resolves.toEqual({ card: CARD, spentUsd: 3, runId: "run-9" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("isRealRunnerEnabled", () => {
  it("is false when NEXT_PUBLIC_EVAL_RUNNER_URL is unset in the test env", () => {
    expect(isRealRunnerEnabled()).toBe(false);
  });
});

describe("loadRunDetail — on-demand single-run fetch", () => {
  it("GETs the canonical org-scoped route and returns the run, including its card", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(true, { run: { id: "run-1", status: "succeeded", card: CARD, cost_usd: 1.25, error: null } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadRunDetail("app-1", "org-1", "run-1")).resolves.toEqual({
      id: "run-1",
      status: "succeeded",
      card: CARD,
      cost_usd: 1.25,
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/orgs/org-1/apps/app-1/evals/runs/run-1?appId=app-1");
  });

  it("throws with the status on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res(false, {}, 404)));
    await expect(loadRunDetail("app-1", "org-1", "run-1")).rejects.toThrow("Run detail failed (404).");
  });
});

describe("refreshRunHistory — persisted run history", () => {
  beforeEach(() => {
    mockRefresh.mockReset();
  });

  it("calls the refresh action with the app id and returns the runs array verbatim", async () => {
    const runs = [{ id: "run-1", status: "succeeded", cost_usd: 0.14 }];
    mockRefresh.mockResolvedValue({ ok: true, data: runs });

    await expect(refreshRunHistory("app-1")).resolves.toEqual(runs);
    expect(mockRefresh).toHaveBeenCalledWith({ appId: "app-1" });
  });

  it("throws the action's error when the refresh is denied", async () => {
    mockRefresh.mockResolvedValue({ ok: false, error: { code: "forbidden", message: "Permission denied: eval_run.read" } });
    await expect(refreshRunHistory("app-1")).rejects.toThrow("Permission denied: eval_run.read");
  });
});
