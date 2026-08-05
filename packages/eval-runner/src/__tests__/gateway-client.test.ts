// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, vi } from "vitest";
import { EvalGatewayClient, EvalGatewayError } from "../gateway-client.js";
import type { EnvEscalationRow } from "../escalation-bridge.js";

const RUN_ID = "d4f7a2b1-9c3e-4f5a-8b6d-1e2f3a4b5c6d";

function client(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return new EvalGatewayClient({
    gatewayUrl: "https://api.example.com/",
    apiKey: "sk_outerlayer_eval_abc",
    appId: "app-1",
    runId: RUN_ID,
    fetchImpl,
    log: () => {},
    retryDelayMs: 0,
    ...over,
  });
}

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe("EvalGatewayClient", () => {
  it("fetchJob GETs the job with the exact auth headers and unwraps data", async () => {
    const job = {
      id: RUN_ID,
      appId: "app-1",
      environmentId: "env-1",
      repoLabel: "acme/calc",
      status: "queued",
      request: { taskCount: 5 },
    };
    const fetchImpl = vi.fn(async () => ok({ data: job }));
    const result = await client(fetchImpl as unknown as typeof fetch).fetchJob();

    expect(result).toEqual(job);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.example.com/v1/evals/runs/${RUN_ID}/job`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk_outerlayer_eval_abc",
      "x-outerlayer-app-id": "app-1",
    });
    expect(init.body).toBeUndefined();
  });

  it("claim / complete / fail POST the exact lifecycle bodies", async () => {
    const fetchImpl = vi.fn(async () => ok({ data: {} }));
    const gw = client(fetchImpl as unknown as typeof fetch);

    await gw.claim();
    await gw.complete({ verdict: "clear" }, 0.42);
    await gw.fail("E2B down");

    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse((c as unknown as [string, { body: string }])[1].body));
    expect(bodies).toEqual([
      { status: "running" },
      { status: "succeeded", card: { verdict: "clear" }, costUsd: 0.42 },
      { status: "failed", error: "E2B down" },
    ]);
    for (const call of fetchImpl.mock.calls) {
      expect((call as unknown as [string])[0]).toBe(`https://api.example.com/v1/evals/runs/${RUN_ID}/status`);
    }
  });

  it("retries transient failures (5xx) then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(ok({ data: {} }));
    await client(fetchImpl as unknown as typeof fetch).claim();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a permanent 4xx — throws with the status preserved", async () => {
    const fetchImpl = vi.fn(async () => new Response("not your run", { status: 404 }));
    const gw = client(fetchImpl as unknown as typeof fetch);
    await expect(gw.claim()).rejects.toMatchObject({ name: "EvalGatewayError", status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries on network errors, emits the alert line, and throws status 0", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const gw = client(fetchImpl as unknown as typeof fetch, {
      maxAttempts: 3,
      log: (line: Record<string, unknown>) => lines.push(line),
    });
    await expect(gw.fetchJob()).rejects.toBeInstanceOf(EvalGatewayError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(lines[0]).toEqual({
      _alert: true,
      evt: "eval.gateway.unreachable",
      runId: RUN_ID,
      path: `/v1/evals/runs/${RUN_ID}/job`,
      detail: "ECONNRESET",
    });
  });

  it("escalationWriter sends ONLY the wire fields — identity never leaves the worker", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const row: EnvEscalationRow = {
      tenant_id: "SHOULD-NOT-BE-SENT",
      app_id: "SHOULD-NOT-BE-SENT",
      eval_run_id: "SHOULD-NOT-BE-SENT",
      repo: "github.com/acme/calc",
      base_commit: "abc123",
      task_ids: ["fix-divide"],
      last_errors: [{ stage: "setup", excerpt: "pip failed" }],
      attempts: 3,
      cost_usd: 0.9,
      suggested_next_steps: "pin python 3.12",
    };
    await client(fetchImpl as unknown as typeof fetch).escalationWriter()(row);

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, { body: string }];
    expect(url).toBe("https://api.example.com/v1/evals/escalations");
    expect(JSON.parse(init.body)).toEqual({
      repo: "github.com/acme/calc",
      base_commit: "abc123",
      task_ids: ["fix-divide"],
      last_errors: [{ stage: "setup", excerpt: "pip failed" }],
      attempts: 3,
      cost_usd: 0.9,
      suggested_next_steps: "pin python 3.12",
    });
    expect(init.body).not.toContain("SHOULD-NOT-BE-SENT");
  });
});
