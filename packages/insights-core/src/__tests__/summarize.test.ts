// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, vi } from "vitest";
import type { DetectionSession, DetectionToolCall } from "../types.js";
import type { ErrorCluster, LlmClient } from "../summarize/types.js";
import { clusterErrorSignatures } from "../summarize/cluster.js";
import { summarizeClusters } from "../summarize/summarize.js";
import { fetchAnthropicClient, AnthropicHttpError } from "../summarize/anthropic.js";

// ---------- fixtures ----------

let nextId = 0;

function call(over: Partial<DetectionToolCall> = {}): DetectionToolCall {
  return { name: "Bash", status: "ok", isEdit: 0, file: null, errorSignature: null, ...over };
}
const fail = (name: string, signature: string) => call({ name, status: "error", errorSignature: signature });

/** A session with sane defaults; every field overridable. One tool call per
 * assistant turn, mirroring the detectors fixture. */
function sess(over: Partial<DetectionSession> & { calls?: DetectionToolCall[] } = {}): DetectionSession {
  const { calls = [], ...rest } = over;
  return {
    id: `s-${nextId++}`,
    actorId: null,
    project: "/home/dev/acme",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T11:00:00.000Z",
    models: ["claude-opus-4-8"],
    costUsd: 1,
    tokens: { input: 1000, output: 1000, cacheRead: 100_000, cacheCreation: 2000 },
    isSubagent: 0,
    turns: calls.map((c, i) => ({ index: i, role: "assistant", ts: null, toolCalls: [c] })),
    events: [],
    ...rest,
  };
}

/** Two known clusters the summarize tests share. Session ids overlap on s2 so
 * the evidence-union math is observable. */
const CLUSTERS: ErrorCluster[] = [
  { key: "Bash::unknown flag: --limit", tool: "Bash", signature: "unknown flag: --limit", occurrences: 6, sessionIds: ["s1", "s2"], actorCount: 2 },
  { key: "Edit::old_string not found", tool: "Edit", signature: "old_string not found", occurrences: 4, sessionIds: ["s2", "s3"], actorCount: 1 },
];

function fakeClient(response: string) {
  return {
    model: "fake-model",
    complete: vi.fn(async (_req: { system: string; user: string; maxTokens: number }) => response),
  };
}

/** The estimate formula summarize.ts documents: chars/4 input tokens at $1/M + 1000 output tokens at $5/M. */
function expectedEstimate(system: string, user: string): number {
  return ((system.length + user.length) / 4) * (1 / 1_000_000) + 1000 * (5 / 1_000_000);
}

// ---------- clusterErrorSignatures ----------

describe("clusterErrorSignatures", () => {
  it("groups by tool::signature with exact counts, session ids, and actor math, sorted by occurrences desc", () => {
    const a = sess({ id: "sa", actorId: "dev-a", calls: [fail("Bash", "unknown flag: --limit"), fail("Bash", "unknown flag: --limit"), fail("Edit", "old_string not found")] });
    const b = sess({ id: "sb", actorId: "dev-b", calls: [fail("Bash", "unknown flag: --limit"), fail("Edit", "old_string not found")] });
    const c = sess({ id: "sc", actorId: "dev-a", calls: [fail("Bash", "unknown flag: --limit"), fail("Edit", "old_string not found")] });
    expect(clusterErrorSignatures([a, b, c])).toEqual([
      { key: "Bash::unknown flag: --limit", tool: "Bash", signature: "unknown flag: --limit", occurrences: 4, sessionIds: ["sa", "sb", "sc"], actorCount: 2 },
      { key: "Edit::old_string not found", tool: "Edit", signature: "old_string not found", occurrences: 3, sessionIds: ["sa", "sb", "sc"], actorCount: 2 },
    ]);
  });

  it("drops clusters with <3 occurrences and ignores ok calls and errors without a signature", () => {
    const s = sess({
      id: "solo",
      calls: [
        fail("Bash", "rare"),
        fail("Bash", "rare"),
        call(), // ok call — never clustered
        call({ status: "error" }), // error without a signature — nothing to cluster on
        fail("Read", "ENOENT"),
        fail("Read", "ENOENT"),
        fail("Read", "ENOENT"),
      ],
    });
    expect(clusterErrorSignatures([s])).toEqual([
      { key: "Read::ENOENT", tool: "Read", signature: "ENOENT", occurrences: 3, sessionIds: ["solo"], actorCount: 0 },
    ]);
  });

  it("caps at 30 clusters, keeping the highest-occurrence ones", () => {
    const pad = (i: number) => String(i).padStart(2, "0");
    // 31 signatures at 3 occurrences each; the LAST key gets a 4th so the cap
    // must keep it (by count) and drop the lexicographically-last 3-count key.
    const calls = [
      ...Array.from({ length: 31 }, (_, i) => [fail("Bash", `sig-${pad(i)}`), fail("Bash", `sig-${pad(i)}`), fail("Bash", `sig-${pad(i)}`)]).flat(),
      fail("Bash", "sig-30"),
    ];
    const clusters = clusterErrorSignatures([sess({ calls })]);
    expect(clusters).toHaveLength(30);
    expect(clusters.map((cl) => cl.key)[0]).toBe("Bash::sig-30");
    expect(clusters[0]!.occurrences).toBe(4);
    expect(clusters.map((cl) => cl.key)).not.toContain("Bash::sig-29");
  });
});

// ---------- summarizeClusters ----------

describe("summarizeClusters", () => {
  it("maps a fake client's JSON to exact themes, evidence unioned from OUR clusters (not the model)", async () => {
    const client = fakeClient(
      JSON.stringify([
        { label: "CLI flag drift", description: "Agents pass flags the local CLI does not support.", clusterKeys: ["Bash::unknown flag: --limit"], severity: "high" },
        { label: "Stale edit anchors", description: "Edits target strings that no longer exist.", clusterKeys: ["Edit::old_string not found", "Bash::unknown flag: --limit"], severity: "warn" },
      ]),
    );
    const result = await summarizeClusters(CLUSTERS, { client });
    expect(result).toEqual({
      themes: [
        { label: "CLI flag drift", description: "Agents pass flags the local CLI does not support.", clusterKeys: ["Bash::unknown flag: --limit"], evidenceSessionIds: ["s1", "s2"], severity: "high" },
        { label: "Stale edit anchors", description: "Edits target strings that no longer exist.", clusterKeys: ["Edit::old_string not found", "Bash::unknown flag: --limit"], evidenceSessionIds: ["s2", "s3", "s1"], severity: "warn" },
      ],
      degraded: false,
      estimatedCostUsd: expect.any(Number),
      model: "fake-model",
    });
    // The estimate is the documented formula over the exact prompt we sent.
    const req = client.complete.mock.calls[0]![0];
    expect(result.estimatedCostUsd).toBeCloseTo(expectedEstimate(req.system, req.user), 12);
  });

  it("sends the model rollups only — key/tool/signature/occurrences/actorCount, never session ids", async () => {
    const client = fakeClient("[]");
    await summarizeClusters(CLUSTERS, { client });
    expect(client.complete).toHaveBeenCalledWith({
      system: expect.stringContaining("inventing keys is forbidden"),
      user: JSON.stringify(CLUSTERS.map(({ key, tool, signature, occurrences, actorCount }) => ({ key, tool, signature, occurrences, actorCount }))),
      maxTokens: 1000,
    });
    const req = client.complete.mock.calls[0]![0];
    expect(req.user).not.toContain("sessionIds");
    expect(req.user).not.toContain("s1");
  });

  it("drops a theme that references a clusterKey we never produced (no invented findings)", async () => {
    const client = fakeClient(
      JSON.stringify([
        { label: "Real", description: "References clusters we found.", clusterKeys: ["Bash::unknown flag: --limit"], severity: "info" },
        { label: "Invented", description: "References a cluster we never found.", clusterKeys: ["Bash::made-up-error"], severity: "high" },
      ]),
    );
    const result = await summarizeClusters(CLUSTERS, { client });
    expect(result.themes.map((t) => t.label)).toEqual(["Real"]);
    expect(result.degraded).toBe(false);
  });

  it("tolerates ```json fences and a {themes: [...]} wrapper", async () => {
    const fenced = fakeClient('Here you go:\n```json\n[{"label":"Fenced","description":"d","clusterKeys":["Edit::old_string not found"],"severity":"warn"}]\n```');
    expect((await summarizeClusters(CLUSTERS, { client: fenced })).themes).toEqual([
      { label: "Fenced", description: "d", clusterKeys: ["Edit::old_string not found"], evidenceSessionIds: ["s2", "s3"], severity: "warn" },
    ]);
    const wrapped = fakeClient('{"themes":[{"label":"Wrapped","description":"d","clusterKeys":["Bash::unknown flag: --limit"],"severity":"high"}]}');
    expect((await summarizeClusters(CLUSTERS, { client: wrapped })).themes.map((t) => t.label)).toEqual(["Wrapped"]);
  });

  it("defaults invalid severity to info and drops themes beyond maxThemes", async () => {
    const client = fakeClient(
      JSON.stringify(
        Array.from({ length: 4 }, (_, i) => ({
          label: `t${i}`,
          description: "d",
          clusterKeys: ["Bash::unknown flag: --limit"],
          severity: i === 0 ? "catastrophic" : "warn",
        })),
      ),
    );
    const result = await summarizeClusters(CLUSTERS, { client, maxThemes: 2 });
    expect(result.themes.map((t) => ({ label: t.label, severity: t.severity }))).toEqual([
      { label: "t0", severity: "info" },
      { label: "t1", severity: "warn" },
    ]);
  });

  it("degrades gracefully (no throw) on a null client and on empty clusters", async () => {
    expect(await summarizeClusters(CLUSTERS, { client: null })).toEqual({ themes: [], degraded: true, estimatedCostUsd: 0, model: null });
    const client = fakeClient("[]");
    expect(await summarizeClusters([], { client })).toEqual({ themes: [], degraded: true, estimatedCostUsd: 0, model: null });
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("degrades WITHOUT calling the model when the estimate exceeds the cost cap", async () => {
    const client = fakeClient("[]");
    const result = await summarizeClusters(CLUSTERS, { client, costCapUsd: 0 });
    expect(result).toEqual({ themes: [], degraded: true, estimatedCostUsd: expect.any(Number), model: null });
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("degrades (never throws) on garbage output, non-list JSON, and a rejecting client", async () => {
    const garbage = await summarizeClusters(CLUSTERS, { client: fakeClient("Sorry, I cannot help with that.") });
    expect(garbage).toEqual({ themes: [], degraded: true, estimatedCostUsd: expect.any(Number), model: "fake-model" });
    const nonList = await summarizeClusters(CLUSTERS, { client: fakeClient('{"nope": 1}') });
    expect(nonList.degraded).toBe(true);
    expect(nonList.themes).toEqual([]);
    const rejecting: LlmClient = { complete: vi.fn(async () => { throw new Error("boom"); }) };
    const failed = await summarizeClusters(CLUSTERS, { client: rejecting });
    expect(failed).toEqual({ themes: [], degraded: true, estimatedCostUsd: expect.any(Number), model: null });
  });
});

// ---------- fetchAnthropicClient ----------

describe("fetchAnthropicClient", () => {
  const okResponse = (content: unknown) => new Response(JSON.stringify({ content }), { status: 200 });

  it("POSTs /v1/messages with the documented headers and body, returning the first text block", async () => {
    const fetchImpl = vi.fn(async () => okResponse([{ type: "thinking", thinking: "…" }, { type: "text", text: "first" }, { type: "text", text: "second" }]));
    const client = fetchAnthropicClient({ apiKey: "sk-test", fetchImpl });
    const text = await client.complete({ system: "sys", user: "usr", maxTokens: 42 });
    expect(text).toBe("first");
    expect(client.model).toBe("claude-haiku-4-5-20251001");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 42,
        system: "sys",
        messages: [{ role: "user", content: "usr" }],
      }),
    });
  });

  it("uses the model override in both the request body and the client's label", async () => {
    const fetchImpl = vi.fn(async () => okResponse([{ type: "text", text: "ok" }]));
    const client = fetchAnthropicClient({ apiKey: "sk-test", model: "claude-haiku-4-5", fetchImpl });
    await client.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(client.model).toBe("claude-haiku-4-5");
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body) as { model: string };
    expect(body.model).toBe("claude-haiku-4-5");
  });

  it("throws a typed error on non-200 carrying the status and the first 200 chars of the body", async () => {
    const fetchImpl = vi.fn(async () => new Response("B".repeat(300), { status: 429 }));
    const client = fetchAnthropicClient({ apiKey: "sk-test", fetchImpl });
    const err = (await client.complete({ system: "s", user: "u", maxTokens: 1 }).catch((e: unknown) => e)) as AnthropicHttpError;
    expect(err).toBeInstanceOf(AnthropicHttpError);
    expect(err.status).toBe(429);
    expect(err.message).toContain("429");
    expect(err.message).toContain("B".repeat(200));
    expect(err.message).not.toContain("B".repeat(201));
  });
});
