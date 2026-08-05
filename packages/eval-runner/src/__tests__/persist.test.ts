// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, vi } from "vitest";
import type { TrialResult } from "@outerlayer/trial-harness";
import {
  CHUNK_BYTES,
  SESSIONS_PER_SYNC,
  TRIALS_PER_REQUEST,
  chunkTrials,
  evalTrialSessionId,
  persistTrialResults,
  persistTrialSessions,
} from "../persist.js";

const RUN_ID = "d4f7a2b1-9c3e-4f5a-8b6d-1e2f3a4b5c6d";

function trial(over: Partial<TrialResult> = {}): TrialResult {
  return {
    schemaVersion: 1,
    taskId: "fix-divide",
    configId: "opus",
    trialIndex: 0,
    status: "graded",
    resolved: true,
    failToPass: [{ id: "tests/test_divide.py::t", outcome: "pass" }],
    passToPass: [],
    patch: "--- a/calc.py\n",
    patchApplyOk: true,
    trajectory: null,
    cost: { usd: 0.42, source: "measured" },
    leak: {
      agentWorktreeClean: true,
      transcriptClean: true,
      gradeOffline: true,
      patchesNeverInAgentSandbox: true,
      frozenPatchIntact: true,
    },
    quarantinedSkipped: [],
    attempt: 1,
    timings: { agentMs: 40000, gradeMs: 15000, totalMs: 55000 },
    ...over,
  };
}

function okResponse(accepted: string[], rejected: Array<{ reason: string }> = []): Response {
  return new Response(JSON.stringify({ data: { accepted, rejected } }), { status: 200 });
}

describe("evalTrialSessionId", () => {
  it("mints the exact canonical id the gateway and session sync both key on", () => {
    expect(evalTrialSessionId(RUN_ID, "fix-divide", "opus", 2)).toBe(
      `eval:${RUN_ID}:fix-divide:opus:t2`,
    );
  });
});

describe("chunkTrials", () => {
  it("splits by the per-request count cap, preserving order", () => {
    const items = Array.from({ length: 45 }, (_, i) => ({
      sessionId: `s${i}`,
      result: trial({ trialIndex: i }),
    }));
    const chunks = chunkTrials(items, TRIALS_PER_REQUEST, CHUNK_BYTES);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5]);
    expect(chunks[0]![0]!.sessionId).toBe("s0");
    expect(chunks[2]![4]!.sessionId).toBe("s44");
  });

  it("splits by the byte budget and ships an oversize item alone", () => {
    const big = { sessionId: "big", result: trial({ patch: "x".repeat(120) }) };
    const small = { sessionId: "small", result: trial() };
    const budget = JSON.stringify(big).length + 10; // fits one big OR one small, not both
    expect(chunkTrials([big, small, big], 20, budget).map((c) => c.map((i) => i.sessionId))).toEqual([
      ["big"],
      ["small"],
      ["big"],
    ]);
  });
});

describe("persistTrialResults", () => {
  it("POSTs the exact wire contract: url, auth + app-id headers, enveloped trials", async () => {
    const fetchImpl = vi.fn(async () => okResponse([`eval:${RUN_ID}:fix-divide:opus:t0`]));
    const report = await persistTrialResults([trial()], {
      gatewayUrl: "https://api.example.com/",
      apiKey: "sk_outerlayer_eval_abc",
      appId: "app-1",
      evalRunId: RUN_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      retryDelayMs: 0,
    });

    expect(report).toEqual({ total: 1, accepted: 1, rejected: 0, failedChunks: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/evals/trials");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk_outerlayer_eval_abc",
      "x-outerlayer-app-id": "app-1",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      trials: [{ sessionId: `eval:${RUN_ID}:fix-divide:opus:t0`, result: trial() }],
    });
  });

  it("retries a 5xx then succeeds, without double-counting", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(okResponse(["a"]));
    const report = await persistTrialResults([trial()], {
      gatewayUrl: "https://api.example.com",
      apiKey: "k",
      appId: "app-1",
      evalRunId: RUN_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      retryDelayMs: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(report).toEqual({ total: 1, accepted: 1, rejected: 0, failedChunks: 0 });
  });

  it("does NOT retry a 4xx — it alerts and marks the chunk failed", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async () => new Response("bad key", { status: 401 }));
    const report = await persistTrialResults([trial()], {
      gatewayUrl: "https://api.example.com",
      apiKey: "k",
      appId: "app-1",
      evalRunId: RUN_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (line) => lines.push(line),
      retryDelayMs: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ total: 1, accepted: 0, rejected: 0, failedChunks: 1 });
    expect(lines[0]).toEqual({
      _alert: true,
      evt: "eval.persist.failed",
      runId: RUN_ID,
      status: 401,
      trials: 1,
      detail: "bad key",
    });
  });

  it("exhausts retries on persistent network errors, alerts, and never throws", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const report = await persistTrialResults([trial()], {
      gatewayUrl: "https://api.example.com",
      apiKey: "k",
      appId: "app-1",
      evalRunId: RUN_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (line) => lines.push(line),
      maxAttempts: 3,
      retryDelayMs: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(report).toEqual({ total: 1, accepted: 0, rejected: 0, failedChunks: 1 });
    expect(lines[0]).toEqual({
      _alert: true,
      evt: "eval.persist.failed",
      runId: RUN_ID,
      status: 0,
      trials: 1,
      detail: "no 2xx after 3 attempts",
    });
  });

  it("syncs sessions to /v1/agents/sync in <=50 batches with the sync envelope", async () => {
    const sessions = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}` }));
    const fetchImpl = vi.fn(async () => okResponse(["x"]));
    const report = await persistTrialSessions(sessions, {
      gatewayUrl: "https://api.example.com",
      apiKey: "sk_outerlayer_eval_abc",
      appId: "app-1",
      evalRunId: RUN_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      retryDelayMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2); // 50 + 10
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/agents/sync");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk_outerlayer_eval_abc",
      "x-outerlayer-app-id": "app-1",
    });
    const body = JSON.parse(init.body as string);
    expect(body.schemaVersion).toBe(1);
    expect(body.sessions).toHaveLength(SESSIONS_PER_SYNC);
    expect(body.sessions[0]).toEqual({ id: "s0" });
    // one "x" accepted per response
    expect(report).toEqual({ total: 60, accepted: 2, rejected: 0, failedChunks: 0 });
  });

  it("alerts with the sessions event on a hard sync failure and never throws", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const report = await persistTrialSessions([{ id: "s0" }], {
      gatewayUrl: "https://api.example.com",
      apiKey: "k",
      appId: "app-1",
      evalRunId: RUN_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (line) => lines.push(line),
      retryDelayMs: 0,
    });
    expect(report).toEqual({ total: 1, accepted: 0, rejected: 0, failedChunks: 1 });
    expect(lines[0]).toEqual({
      _alert: true,
      evt: "eval.sessions.persist.failed",
      runId: RUN_ID,
      status: 403,
      sessions: 1,
      detail: "nope",
    });
  });

  it("a failed chunk does not stop later chunks; tallies sum across responses", async () => {
    const trials = Array.from({ length: 25 }, (_, i) => trial({ trialIndex: i }));
    const fetchImpl = vi
      .fn()
      // chunk 1 (20 trials): hard failure
      .mockResolvedValue(okResponse(["x1", "x2", "x3", "x4"], [{ reason: "schema: bad" }]))
      .mockResolvedValueOnce(new Response("nope", { status: 400 }));
    const report = await persistTrialResults(trials, {
      gatewayUrl: "https://api.example.com",
      apiKey: "k",
      appId: "app-1",
      evalRunId: RUN_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
      retryDelayMs: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // chunk 2 (5 trials): 4 accepted + 1 rejected from the response body.
    expect(report).toEqual({ total: 25, accepted: 4, rejected: 1, failedChunks: 1 });
  });
});
