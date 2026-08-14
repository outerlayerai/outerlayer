// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Socket } from "node:net";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync, SyncConfigError, SyncTransportError, cloudConfigPath } from "../sync-cmd.js";
import { hookExecSpoolPath } from "../hook-wrap-fast.js";
import { readHookExecWatermark } from "../hook-exec-merge.js";
import {
  artifactBlobsDir,
  artifactsSpoolPath,
  artifactsWatermarkPath,
  readArtifactsWatermark,
} from "../artifact-spool.js";

let root: string;
let home: string;
let hermetic: { rawRoot: string; codexRoot: string; cursorRoot: string; cursorProjectsRoot: string };

function transcript(id: string, lines: Record<string, unknown>[], mtime?: Date): string {
  const dir = join(root, "-Users-x-acme");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

function userLine(id: string, text: string): Record<string, unknown> {
  return {
    sessionId: id,
    type: "user",
    version: "2.1.193",
    cwd: "/home/x/acme",
    gitBranch: "main",
    timestamp: "2026-07-10T09:59:59.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistant(id: string, model: string, text = "hi"): Record<string, unknown> {
  return {
    sessionId: id,
    type: "assistant",
    version: "2.1.193",
    cwd: "/home/x/acme",
    gitBranch: "main",
    timestamp: "2026-07-10T10:00:00.000Z",
    message: {
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 5 },
    },
  };
}

type FetchCall = { url: string; init: RequestInit };

function okFetch(calls: FetchCall[]): typeof fetch {
  return (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const body = JSON.parse(String(init!.body)) as { sessions: Array<{ id: string }> };
    return new Response(
      JSON.stringify({
        data: {
          accepted: body.sessions.map((s) => s.id),
          rejected: [],
          spanRows: body.sessions.length * 3,
          blobsStored: 0,
          tenantTier: "redacted",
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

const CREDS = { url: "https://gw.outerlayer.test", apiKey: "sk_test_key", appId: "app-123" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-sync-root-"));
  home = mkdtempSync(join(tmpdir(), "ol-sync-home-"));
  hermetic = {
    rawRoot: join(root, "no-raw"),
    codexRoot: join(root, "no-codex"),
    cursorRoot: join(root, "no-cursor"),
    cursorProjectsRoot: join(root, "no-projects"),
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("runSync configuration", () => {
  it("fails actionably when credentials are missing", async () => {
    await expect(runSync({ root, home, ...hermetic, quiet: true, env: {} })).rejects.toThrow(SyncConfigError);
    await expect(runSync({ root, home, ...hermetic, quiet: true, env: {} })).rejects.toThrow(
      /--url, --api-key, --app-id/,
    );
  });

  it("reads credentials from env vars", async () => {
    transcript("s1", [userLine("s1", "fix build"), assistant("s1", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    const result = await runSync({
      root, home, ...hermetic, quiet: true,
      env: { OUTERLAYER_URL: CREDS.url, OUTERLAYER_API_KEY: CREDS.apiKey, OUTERLAYER_APP_ID: CREDS.appId },
      fetchImpl: okFetch(calls),
    });
    expect(result.synced).toBe(1);
    expect(calls[0]!.url).toBe("https://gw.outerlayer.test/v1/agents/sync");
  });

  it("rejects an unknown tier", async () => {
    await expect(
      runSync({ ...CREDS, tier: "everything" as never, root, home, ...hermetic, quiet: true, env: {} }),
    ).rejects.toThrow(/unknown tier/);
  });
});

describe("runSync shipping", () => {
  it("POSTs sessions with auth headers and the canonical payload shape", async () => {
    transcript("s1", [userLine("s1", "fix build"), assistant("s1", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });

    expect(result.synced).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CREDS.apiKey}`);
    expect(headers["x-outerlayer-app-id"]).toBe(CREDS.appId);
    // Retirement guard: the legacy header names must be GONE from
    // the wire, not sent alongside the new one.
    expect(headers["x-agentmark-app-id"]).toBeUndefined();
    expect(headers["x-puzzlet-app-id"]).toBeUndefined();

    const payload = JSON.parse(String(calls[0]!.init.body)) as {
      schemaVersion: number;
      sessions: Array<{ id: string; captureTier: string; workerKind?: string }>;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]!.id).toBe("s1");
    expect(payload.sessions[0]!.captureTier).toBe("full");
    // A local sync is a developer seat by default.
    expect(payload.sessions[0]!.workerKind).toBe("seat");
  });

  it("stamps workerKind=ci when the sync runs inside a CI pipeline (CI env convention)", async () => {
    transcript("s1", [userLine("s1", "fix build"), assistant("s1", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    await runSync({
      ...CREDS, root, home, ...hermetic, quiet: true,
      env: { CI: "true" },
      fetchImpl: okFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { sessions: Array<{ workerKind?: string }> };
    expect(payload.sessions[0]!.workerKind).toBe("ci");
  });

  it("strips the repo-root prefix from in-repo paths before shipping (structured fields + raw content)", async () => {
    // A real repo so `git rev-parse --show-toplevel` resolves; realpath so it
    // matches the cwd the transcript carries (macOS /var → /private/var).
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "ol-sync-repo-")));
    execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
    const dir = join(root, "-repo-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "r1.jsonl"),
      [
        JSON.stringify({
          sessionId: "r1", type: "user", version: "2.1.193", cwd: repo, gitBranch: "main",
          timestamp: "2026-07-10T09:59:59.000Z", message: { role: "user", content: [{ type: "text", text: "edit it" }] },
        }),
        JSON.stringify({
          sessionId: "r1", type: "assistant", version: "2.1.193", cwd: repo, gitBranch: "main",
          timestamp: "2026-07-10T10:00:00.000Z",
          message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: `${repo}/apps/web/src/page.tsx` } }] },
        }),
      ].join("\n") + "\n",
    );
    try {
      const calls: FetchCall[] = [];
      await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
      const payload = JSON.parse(String(calls[0]!.init.body)) as {
        sessions: Array<{ env: { cwd?: string }; turns: Array<{ toolCalls: Array<{ file?: string }> }> }>;
      };
      const s = payload.sessions.find((x) => (x as { id: string }).id === "r1")!;
      expect(s.env.cwd).toBe(".");
      const files = s.turns.flatMap((t) => t.toolCalls.map((c) => c.file)).filter(Boolean);
      expect(files).toEqual(["apps/web/src/page.tsx"]);
      // Strip is a plain scrubber over every string, so the absolute root is
      // gone from the raw tool input (tier:full content) too — nothing leaks.
      expect(JSON.stringify(s)).not.toContain(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("strips message text at the redacted tier — before anything leaves", async () => {
    transcript("s1", [userLine("s1", "SECRET business plan"), assistant("s1", "claude-opus-4-8", "the plan is...")]);
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, tier: "redacted", root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    const raw = String(calls[0]!.init.body);
    expect(raw).not.toContain("SECRET business plan");
    expect(raw).not.toContain("the plan is...");
    // Structure identifiers (redacted tier) still present:
    expect(raw).toContain("main"); // gitBranch
  });

  it("ships full content when --tier full is explicit", async () => {
    transcript("s1", [userLine("s1", "fix the login bug"), assistant("s1", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, tier: "full", root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(String(calls[0]!.init.body)).toContain("fix the login bug");
  });

  it("advances the watermark: a second sync ships nothing, a new transcript ships alone", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")], new Date("2026-07-10T10:00:00Z"));
    const calls: FetchCall[] = [];
    const first = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(first.synced).toBe(1);

    const second = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(second.eligible).toBe(0);
    expect(second.synced).toBe(0);
    expect(calls).toHaveLength(1); // no second POST

    transcript("s2", [userLine("s2", "two"), assistant("s2", "claude-opus-4-8")], new Date("2026-07-11T10:00:00Z"));
    const third = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(third.synced).toBe(1);
    const payload = JSON.parse(String(calls[1]!.init.body)) as { sessions: Array<{ id: string }> };
    expect(payload.sessions.map((s) => s.id)).toEqual(["s2"]);
  });

  it("--all ignores the checkpoint", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    const again = await runSync({ ...CREDS, all: true, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(again.synced).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("a transport failure stops the run without advancing the watermark", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    const failing = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    const noSleep = async () => {};
    await expect(
      runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: failing, sleepImpl: noSleep }),
    ).rejects.toThrow(SyncTransportError);

    // Watermark untouched → the next run re-ships the same session.
    const calls: FetchCall[] = [];
    const retry = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(retry.synced).toBe(1);
  });

  it("retries a transient 5xx with exponential backoff and completes without double-shipping", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    const ok = okFetch(calls);
    let failures = 2;
    const flaky = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (failures > 0) {
        failures -= 1;
        calls.push({ url: String(url), init: init! });
        return new Response("upstream connect error", { status: 503 });
      }
      return ok(url, init);
    }) as typeof fetch;
    const delays: number[] = [];
    const result = await runSync({
      ...CREDS, root, home, ...hermetic, quiet: true, env: {},
      fetchImpl: flaky,
      sleepImpl: async (ms) => { delays.push(ms); },
    });
    // 2 failed attempts + 1 success — one session, accepted exactly once.
    expect(result.synced).toBe(1);
    expect(calls.length).toBe(3);
    expect(delays).toEqual([2_000, 4_000]);
  });

  it("honors a server Retry-After hint when it exceeds the backoff schedule", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    const ok = okFetch(calls);
    let first = true;
    const hinted = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (first) {
        first = false;
        return new Response("busy", { status: 503, headers: { "retry-after": "7" } });
      }
      return ok(url, init);
    }) as typeof fetch;
    const delays: number[] = [];
    await runSync({
      ...CREDS, root, home, ...hermetic, quiet: true, env: {},
      fetchImpl: hinted,
      sleepImpl: async (ms) => { delays.push(ms); },
    });
    expect(delays).toEqual([7_000]);
  });

  it("gives up after the attempt budget and surfaces the non-JSON body in the error", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    let attempts = 0;
    const dead = (async () => {
      attempts += 1;
      return new Response("<html><body><h1>Service Temporarily Unavailable</h1></body></html>", { status: 503 });
    }) as typeof fetch;
    const delays: number[] = [];
    await expect(
      runSync({
        ...CREDS, root, home, ...hermetic, quiet: true, env: {},
        fetchImpl: dead,
        sleepImpl: async (ms) => { delays.push(ms); },
      }),
    ).rejects.toThrow(/sync failed \(503\): Service Temporarily Unavailable/);
    expect(attempts).toBe(6);
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  it("does NOT retry the 429 monthly-cap response — fails fast with the usage numbers", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    let attempts = 0;
    const capped = (async () => {
      attempts += 1;
      return new Response(
        JSON.stringify({ error: { message: "monthly ingest cap reached", details: { currentCount: 20000, limit: 20000 } } }),
        { status: 429 },
      );
    }) as typeof fetch;
    const delays: number[] = [];
    await expect(
      runSync({
        ...CREDS, root, home, ...hermetic, quiet: true, env: {},
        fetchImpl: capped,
        sleepImpl: async (ms) => { delays.push(ms); },
      }),
    ).rejects.toThrow(/monthly ingest cap reached \(20,000\/20,000 units used this month\)/);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it("401 surfaces an actionable message", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    const unauthorized = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(
      runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: unauthorized }),
    ).rejects.toThrow(/not authorized/);
  });

  it("surfaces server-side rejects and exits with them in the result", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    const rejecting = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { sessions: Array<{ id: string }> };
      return new Response(
        JSON.stringify({
          data: {
            accepted: [],
            rejected: body.sessions.map((s, i) => ({ index: i, id: s.id, reason: "schema: turns: invalid" })),
            spanRows: 0,
            blobsStored: 0,
            tenantTier: "redacted",
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: rejecting });
    expect(result.synced).toBe(0);
    expect(result.rejected).toEqual([{ index: 0, id: "s1", reason: "schema: turns: invalid" }]);
  });

  it("persists flag credentials to the config file after a fully-shipped run", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")], new Date("2026-07-10T10:00:00Z"));
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch([]) });
    const saved = JSON.parse(readFileSync(cloudConfigPath(home), "utf8")) as Record<string, string>;
    expect(saved).toEqual({ url: CREDS.url, apiKey: CREDS.apiKey, appId: CREDS.appId });

    // Next run needs no flags/env.
    transcript("s2", [userLine("s2", "two"), assistant("s2", "claude-opus-4-8")], new Date("2026-07-12T10:00:00Z"));
    const calls: FetchCall[] = [];
    const result = await runSync({ root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(result.synced).toBe(1);
  });

  it("splits large corpora into ≤25-session batches", async () => {
    for (let i = 0; i < 30; i += 1) {
      transcript(`s${i}`, [userLine(`s${i}`, "x"), assistant(`s${i}`, "claude-opus-4-8")]);
    }
    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(result.synced).toBe(30);
    expect(calls).toHaveLength(2);
    const sizes = calls.map((c) => (JSON.parse(String(c.init.body)) as { sessions: unknown[] }).sessions.length);
    expect(sizes).toEqual([25, 5]);
  });

  it("flushes on the server's 64-blob request cap: image-heavy sessions split across batches, nothing dropped", async () => {
    // 5 sessions × 20 distinct screenshots = 100 blobs; sessions are tiny so
    // only the blob cap can force a split.
    const imageUser = (id: string, start: number): Record<string, unknown> => ({
      ...userLine(id, "look"),
      message: {
        role: "user",
        content: Array.from({ length: 20 }, (_, k) => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: Buffer.from(`img-${start + k}`).toString("base64") },
        })),
      },
    });
    for (let i = 0; i < 5; i += 1) {
      transcript(`s${i}`, [imageUser(`s${i}`, i * 20), assistant(`s${i}`, "claude-opus-4-8")]);
    }
    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(result.synced).toBe(5);
    const payloads = calls.map((c) => JSON.parse(String(c.init.body)) as { sessions: { id: string }[]; blobs?: { sha256: string }[] });
    // every request respects the server cap
    for (const p of payloads) expect((p.blobs ?? []).length).toBeLessThanOrEqual(64);
    // 3+3 sessions won't fit (60+20 blobs) → [3 sessions/60 blobs, 2 sessions/40 blobs]
    expect(payloads.map((p) => [p.sessions.length, (p.blobs ?? []).length])).toEqual([[3, 60], [2, 40]]);
    // no blob lost or duplicated across the split
    const shas = payloads.flatMap((p) => (p.blobs ?? []).map((b) => b.sha256));
    expect(new Set(shas).size).toBe(100);
    expect(shas).toHaveLength(100);
  });

  it("ships an oversized session as chunk parts: whole-session counts on every part, no turn lost, every request under the batch cap", async () => {
    // ~6MB of tool output across 30 tool turns forces chunking (trigger 3.5MB).
    const lines: Record<string, unknown>[] = [];
    for (let i = 0; i < 30; i += 1) {
      lines.push({
        ...assistant("s-big", "claude-opus-4-8", `step ${i}`),
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `run ${i}` } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      lines.push({
        ...userLine("s-big", "x"),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: i === 0, content: `${"x".repeat(200_000)}-${i}` }],
        },
      });
    }
    lines.push({ sessionId: "s-big", type: "pr-link", prNumber: 42, prUrl: "https://github.com/x/acme/pull/42", version: "2.1.193", cwd: "/home/x/acme", gitBranch: "main" });
    transcript("s-big", lines);
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    type Part = { id: string; turns: { index: number }[]; chunk?: { part: number; of: number; counts: Record<string, number> }; outcome?: { prs?: unknown[] } };
    const parts = calls.flatMap((c) => (JSON.parse(String(c.init.body)) as { sessions: Part[] }).sessions);
    // every part is s-big, chunk-stamped, with identical WHOLE-session counts
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.id).toBe("s-big");
      expect(p.chunk!.of).toBe(parts.length);
      expect(p.chunk!.counts).toEqual({ turns: 30, toolCalls: 30, errors: 1, userTurns: 0 });
      // part-invariant envelope: the pr-link outcome rides every part
      expect(p.outcome).toEqual({ prNumber: 42, prUrl: "https://github.com/x/acme/pull/42", prs: [{ prNumber: 42, prUrl: "https://github.com/x/acme/pull/42" }] });
    }
    expect(parts.map((p) => p.chunk!.part)).toEqual(parts.map((_, i) => i + 1));
    // no turn lost or duplicated across parts
    const indexes = parts.flatMap((p) => p.turns.map((t) => t.index)).sort((a, b) => a - b);
    expect(indexes).toEqual(Array.from({ length: 30 }, (_, i) => i));
    // every request stays under the serialized batch cap (server 413s at 8MiB)
    for (const c of calls) expect(String(c.init.body).length).toBeLessThan(3_600_000);
  });

  it("chunk userTurns count is human-only: relayed peer/notification turns are excluded", async () => {
    // A multi-agent session large enough to chunk (20 × 200KB tool results),
    // carrying real user turns tagged by their JSONL `origin`: 3 human prompts,
    // 2 relayed peer messages, 1 task notification. The whole-session
    // `userTurns` count on every part must be 3 — the human steering only.
    const originUser = (kind: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...userLine("s-multi", text),
      origin: { kind, ...extra },
    });
    const lines: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i += 1) {
      lines.push({
        ...assistant("s-multi", "claude-opus-4-8", `step ${i}`),
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `run ${i}` } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      lines.push({
        ...userLine("s-multi", "x"),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `${"x".repeat(200_000)}-${i}` }] },
      });
    }
    lines.push(originUser("human", "start: build the parser"));
    lines.push(originUser("peer", "peer: mind the chunk boundary", { from: "reviewer" }));
    lines.push(originUser("task-notification", "background task finished"));
    lines.push(originUser("human", "no, use the other API"));
    lines.push(originUser("peer", "peer: another relayed note", { from: "reviewer" }));
    lines.push(originUser("human", "ship it once tests are green"));
    transcript("s-multi", lines);

    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    type Part = { chunk?: { counts: Record<string, number> } };
    const parts = calls.flatMap((c) => (JSON.parse(String(c.init.body)) as { sessions: Part[] }).sessions);
    expect(parts.length).toBeGreaterThan(1);
    // 20 assistant turns + 6 classified user turns = 26 total; 3 human of them.
    for (const p of parts) {
      expect(p.chunk!.counts.turns).toBe(26);
      expect(p.chunk!.counts.userTurns).toBe(3);
    }
  });

  it("adaptively splits a batch the server keeps 503ing until requests are small enough, losing nothing", async () => {
    // Server refuses any multi-session request (deterministic resource
    // blowout), accepts singles. One image on s2 must travel with s2.
    for (let i = 0; i < 5; i += 1) {
      const lines: Record<string, unknown>[] = [userLine(`s${i}`, "x"), assistant(`s${i}`, "claude-opus-4-8")];
      if (i === 2) {
        lines.push({
          ...userLine("s2", "shot"),
          message: {
            role: "user",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("s2-shot").toString("base64") } }],
          },
        });
      }
      transcript(`s${i}`, lines, new Date(Date.UTC(2026, 6, 1, 10, i)));
    }
    const calls: FetchCall[] = [];
    const stubbornFetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const body = JSON.parse(String(init!.body)) as { sessions: Array<{ id: string }>; blobs?: unknown[] };
      if (body.sessions.length > 1) return new Response("Worker exceeded resource limits", { status: 503 });
      return new Response(
        JSON.stringify({ data: { accepted: body.sessions.map((s) => s.id), rejected: [], spanRows: 1, blobsStored: body.blobs?.length ?? 0, tenantTier: "full" } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: stubbornFetch, sleepImpl: async () => {} });
    expect(result.synced).toBe(5);
    expect(result.rejected).toEqual([]);
    const successes = calls
      .map((c) => JSON.parse(String(c.init.body)) as { sessions: Array<{ id: string }>; blobs?: { sha256: string }[] })
      .filter((p) => p.sessions.length === 1);
    // singles arrive in original order, none lost or duplicated
    expect(successes.map((p) => p.sessions[0]!.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    // the blob traveled with its session after the split
    const s2Call = successes.find((p) => p.sessions[0]!.id === "s2")!;
    expect((s2Call.blobs ?? []).length).toBe(1);
    // watermark advanced to the end — a resume ships nothing
    const again = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: stubbornFetch, sleepImpl: async () => {} });
    expect(again.synced).toBe(0);
  });

  it("remembers the size the server accepts: later batches pre-split to the learned cap without new failures", async () => {
    // 30 sessions → batches [25, 5]. Server refuses >3 sessions. The first
    // batch discovers the cap by cascading; the second must pre-split
    // silently — every subsequent failure would show up in `failures`.
    for (let i = 0; i < 30; i += 1) {
      transcript(`s${String(i).padStart(2, "0")}`, [userLine(`s${i}`, "x"), assistant(`s${i}`, "claude-opus-4-8")], new Date(Date.UTC(2026, 6, 1, 10, i)));
    }
    const calls: FetchCall[] = [];
    const cappedFetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const body = JSON.parse(String(init!.body)) as { sessions: Array<{ id: string }> };
      if (body.sessions.length > 3) return new Response("too large", { status: 413 });
      return new Response(
        JSON.stringify({ data: { accepted: body.sessions.map((s) => s.id), rejected: [], spanRows: 1, blobsStored: 0, tenantTier: "full" } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: cappedFetch, sleepImpl: async () => {} });
    expect(result.synced).toBe(30);
    // discovery cascade on batch 1 only: 25 → 13 → 7 → 4, then cap=2..3 holds
    const failureSizes = calls
      .map((c) => (JSON.parse(String(c.init.body)) as { sessions: unknown[] }).sessions.length)
      .filter((n) => n > 3);
    expect(failureSizes).toEqual([25, 13, 7, 4]);
  });

  it("splits immediately on 413 without burning the retry budget", async () => {
    for (let i = 0; i < 5; i += 1) {
      transcript(`s${i}`, [userLine(`s${i}`, "x"), assistant(`s${i}`, "claude-opus-4-8")]);
    }
    const calls: FetchCall[] = [];
    const cappedFetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const body = JSON.parse(String(init!.body)) as { sessions: Array<{ id: string }> };
      if (body.sessions.length > 2) return new Response("too large", { status: 413 });
      return new Response(
        JSON.stringify({ data: { accepted: body.sessions.map((s) => s.id), rejected: [], spanRows: 1, blobsStored: 0, tenantTier: "full" } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: cappedFetch, sleepImpl: async () => {} });
    expect(result.synced).toBe(5);
    // one 413 on the 5-session batch, then [3]→413→[2,1] + [2] — exactly two failures total
    const failures = calls.filter((c) => (JSON.parse(String(c.init.body)) as { sessions: unknown[] }).sessions.length > 2);
    expect(failures).toHaveLength(2);
  });

  it("slices a single pathological tool output so the session still syncs, with a marker", async () => {
    const lines: Record<string, unknown>[] = [
      {
        ...assistant("s-patho", "claude-opus-4-8"),
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "cat huge.log" } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        ...userLine("s-patho", "x"),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "y".repeat(5_000_000) }] },
      },
    ];
    transcript("s-patho", lines);
    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(result.synced).toBe(1);
    const bodies = calls.map((c) => String(c.init.body));
    for (const b of bodies) expect(b.length).toBeLessThan(3_600_000);
    expect(bodies.join("")).toContain("[sliced: 5000000 chars exceeded the sync per-call cap]");
  });

  it("a single session over the blob cap still ships, carrying exactly the first 64 blobs", async () => {
    const bigUser: Record<string, unknown> = {
      ...userLine("s-huge", "look"),
      message: {
        role: "user",
        content: Array.from({ length: 70 }, (_, k) => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: Buffer.from(`huge-${k}`).toString("base64") },
        })),
      },
    };
    transcript("s-huge", [bigUser, assistant("s-huge", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(result.synced).toBe(1);
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(String(calls[0]!.init.body)) as { sessions: { id: string }[]; blobs?: unknown[] };
    expect(payload.sessions.map((s) => s.id)).toEqual(["s-huge"]);
    expect((payload.blobs ?? []).length).toBe(64);
  });
});

describe("runSync --dry-run", () => {
  it("prints what would leave and makes zero network calls", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    const spy = vi.spyOn(Socket.prototype, "connect");
    try {
      const result = await runSync({ ...CREDS, dryRun: true, root, home, ...hermetic, quiet: true, env: {} });
      expect(result.dryRun).toBe(true);
      expect(result.synced).toBe(0);
      expect(result.eligible).toBe(1);
      expect(result.output).toContain("DRY RUN");
      expect(result.output).toContain("tier         full");
      // Full tier ships content; the output says so instead of listing strips.
      expect(result.output).toContain("full content ships");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not advance the watermark", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    await runSync({ ...CREDS, dryRun: true, root, home, ...hermetic, quiet: true, env: {} });
    const calls: FetchCall[] = [];
    const real = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(real.synced).toBe(1);
  });

  it("--json emits the exact request payloads", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    const result = await runSync({ ...CREDS, dryRun: true, json: true, root, home, ...hermetic, quiet: true, env: {} });
    const parsed = JSON.parse(result.output) as { batches: Array<{ schemaVersion: number; sessions: Array<{ id: string }> }> };
    expect(parsed.batches).toHaveLength(1);
    expect(parsed.batches[0]!.schemaVersion).toBe(1);
    expect(parsed.batches[0]!.sessions[0]!.id).toBe("s1");
  });

  it("config file is not created by a dry run", async () => {
    transcript("s1", [userLine("s1", "one"), assistant("s1", "claude-opus-4-8")]);
    await runSync({ ...CREDS, dryRun: true, root, home, ...hermetic, quiet: true, env: {} });
    expect(existsSync(cloudConfigPath(home))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// repo scoping
// ---------------------------------------------------------------------------

/** Real git repo with a remote — resolveRepoIdentity spawns git on cwd. */
function makeRepoDir(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ol-sync-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

function transcriptInRepo(id: string, cwd: string): void {
  const user = { ...userLine(id, "work"), cwd };
  const asst = { ...assistant(id, "claude-opus-4-8"), cwd };
  transcript(id, [user, asst]);
}

function writeRepoConfig(repos: object): void {
  mkdirSync(join(home, ".outerlayer"), { recursive: true });
  writeFileSync(cloudConfigPath(home), JSON.stringify({ repos }) + "\n");
}

describe("runSync repo scoping", () => {
  let acmeDir: string;
  let personalDir: string;

  beforeEach(() => {
    acmeDir = makeRepoDir("git@github.com:acme/app.git");
    personalDir = makeRepoDir("git@gitlab.com:personal/secret.git");
  });
  afterEach(() => {
    rmSync(acmeDir, { recursive: true, force: true });
    rmSync(personalDir, { recursive: true, force: true });
  });

  it("exclude keeps the excluded repo's sessions off the wire entirely", async () => {
    transcriptInRepo("s-acme", acmeDir);
    transcriptInRepo("s-personal", personalDir);
    writeRepoConfig({ exclude: ["gitlab.com/personal/*"] });
    const calls: FetchCall[] = [];

    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });

    expect(result.synced).toBe(1);
    const shipped = calls.flatMap((c) => (JSON.parse(String(c.init.body)) as { sessions: Array<{ id: string }> }).sessions.map((x) => x.id));
    expect(shipped).toEqual(["s-acme"]);
    // Negative pin: the excluded repo's identity never appears in any payload.
    for (const c of calls) expect(String(c.init.body)).not.toContain("gitlab.com/personal");
  });

  it("include ships only matching repos and drops no-repo sessions", async () => {
    transcriptInRepo("s-acme", acmeDir);
    transcriptInRepo("s-personal", personalDir);
    transcript("s-norepo", [userLine("s-norepo", "hi"), assistant("s-norepo", "claude-opus-4-8")]); // cwd /home/x/acme: no git
    writeRepoConfig({ include: ["github.com/acme/*"] });
    const calls: FetchCall[] = [];

    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });

    expect(result.synced).toBe(1);
    const shipped = calls.flatMap((c) => (JSON.parse(String(c.init.body)) as { sessions: Array<{ id: string }> }).sessions.map((x) => x.id));
    expect(shipped).toEqual(["s-acme"]);
  });

  it("no repos config ships everything (default unchanged)", async () => {
    transcriptInRepo("s-acme", acmeDir);
    transcriptInRepo("s-personal", personalDir);
    const calls: FetchCall[] = [];

    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });

    expect(result.synced).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// failure reporting
// ---------------------------------------------------------------------------

describe("runSync failure reporting", () => {
  it("surfaces the 429 usage numbers from the gateway payload", async () => {
    transcript("s1", [userLine("s1", "hi"), assistant("s1", "claude-opus-4-8")]);
    const limitedFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "span_limit_exceeded",
            message: "Monthly unit limit exceeded. Upgrade your plan for unlimited units.",
            currentCount: 19_990,
            limit: 20_000,
          },
        }),
        { status: 429 },
      )) as typeof fetch;

    await expect(
      runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: limitedFetch }),
    ).rejects.toThrow(/19,990\/20,000 units used this month/);
  });
});


// ---------------------------------------------------------------------------
// full-content default + always-on secret scrubbing (2026-07-15 decision)
// ---------------------------------------------------------------------------

describe("runSync content defaults and scrubbing", () => {
  it("ships message text by DEFAULT (tier full) — content is the product", async () => {
    transcript("s1", [userLine("s1", "fix the login bug"), assistant("s1", "claude-opus-4-8", "patched the guard")]);
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    const raw = String(calls[0]!.init.body);
    expect(raw).toContain("fix the login bug");
    expect(raw).toContain("patched the guard");
  });

  it("respects a config-file tier when no flag is passed", async () => {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(cloudConfigPath(home), JSON.stringify({ tier: "redacted" }));
    transcript("s1", [userLine("s1", "hush hush"), assistant("s1", "claude-opus-4-8")]);
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    expect(String(calls[0]!.init.body)).not.toContain("hush hush");
  });

  it("scrubs pasted secrets before upload at the FULL tier — and it is not optional", async () => {
    transcript("s1", [
      userLine("s1", "use key sk_live_51AbCdEfGhIjKlMnOpQr and token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA to deploy"),
      assistant("s1", "claude-opus-4-8", "done, used sk_live_51AbCdEfGhIjKlMnOpQr"),
    ]);
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });
    const raw = String(calls[0]!.init.body);
    // The secrets never leave the machine…
    expect(raw).not.toContain("sk_live_51AbCdEfGhIjKlMnOpQr");
    expect(raw).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // …the surrounding prose does, with typed markers in place.
    expect(raw).toContain("[REDACTED:sk-token]");
    expect(raw).toContain("[REDACTED:github-token]");
    expect(raw).toContain("to deploy");
  });
});

// ---------------------------------------------------------------------------
// hook-wrap spool → hook_executed events, merged at sync time
// ---------------------------------------------------------------------------

function appendHookExecRecord(record: unknown): void {
  mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
  writeFileSync(hookExecSpoolPath(home), (existsSync(hookExecSpoolPath(home)) ? readFileSync(hookExecSpoolPath(home), "utf8") : "") + JSON.stringify(record) + "\n");
}

describe("runSync — hook-exec merge", () => {
  it("merges a resolved hook execution into the matching session's events", async () => {
    transcript("s1", [userLine("s1", "fix build"), assistant("s1", "claude-opus-4-8")]);
    appendHookExecRecord({
      rec: "started",
      execId: "e1",
      t: "2026-07-10T10:00:00.000Z",
      sessionId: "s1",
      hookEvent: "PreToolUse",
      toolUseId: "toolu_1",
      toolName: "Bash",
      cmdSha: "x",
      cmd: "echo hi",
      pid: 1,
    });
    appendHookExecRecord({ rec: "finished", execId: "e1", durationMs: 12, exitCode: 0 });

    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch(calls) });

    const payload = JSON.parse(String(calls[0]!.init.body)) as {
      sessions: Array<{ id: string; events: Array<{ type: string; data?: { hookEvent?: string; hooks?: unknown[] } }> }>;
    };
    const session = payload.sessions.find((s) => s.id === "s1")!;
    const hookEvent = session.events.find((e) => e.type === "hook_executed" && e.data?.hookEvent === "PreToolUse");
    expect(hookEvent?.data).toEqual({
      hookEvent: "PreToolUse",
      hooks: [{ command: "echo hi", durationMs: 12, exitCode: 0, status: "ok", toolUseId: "toolu_1" }],
    });
  });

  it("advances the hook-exec watermark only after a successful (non-dry-run) sync", async () => {
    transcript("s1", [userLine("s1", "fix build"), assistant("s1", "claude-opus-4-8")]);
    appendHookExecRecord({
      rec: "started",
      execId: "e1",
      t: "2026-07-10T10:00:00.000Z",
      sessionId: "s1",
      hookEvent: "PreToolUse",
      toolUseId: null,
      toolName: null,
      cmdSha: "x",
      cmd: "echo hi",
      pid: 1,
    });
    appendHookExecRecord({ rec: "finished", execId: "e1", durationMs: 12, exitCode: 0 });

    expect(readHookExecWatermark(home)).toBe(0);
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch([]) });
    expect(readHookExecWatermark(home)).toBeGreaterThan(0);
  });

  it("a dry run leaves the hook-exec watermark untouched — it must make zero local changes", async () => {
    transcript("s1", [userLine("s1", "fix build"), assistant("s1", "claude-opus-4-8")]);
    appendHookExecRecord({
      rec: "started",
      execId: "e1",
      t: "2026-07-10T10:00:00.000Z",
      sessionId: "s1",
      hookEvent: "PreToolUse",
      toolUseId: null,
      toolName: null,
      cmdSha: "x",
      cmd: "echo hi",
      pid: 1,
    });
    appendHookExecRecord({ rec: "finished", execId: "e1", durationMs: 12, exitCode: 0 });

    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, dryRun: true, env: {} });
    expect(readHookExecWatermark(home)).toBe(0);
  });

  it("re-running sync after a successful merge does not re-derive the same event a second time", async () => {
    transcript("s1", [userLine("s1", "fix build"), assistant("s1", "claude-opus-4-8")]);
    appendHookExecRecord({
      rec: "started",
      execId: "e1",
      t: "2026-07-10T10:00:00.000Z",
      sessionId: "s1",
      hookEvent: "PreToolUse",
      toolUseId: null,
      toolName: null,
      cmdSha: "x",
      cmd: "echo hi",
      pid: 1,
    });
    appendHookExecRecord({ rec: "finished", execId: "e1", durationMs: 12, exitCode: 0 });

    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: okFetch([]) });

    // Same transcript re-syncs (forced via --all so the transcript-mtime
    // watermark doesn't itself skip it); the hook-exec watermark must have
    // already moved past the consumed spool lines from the run above.
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, all: true, env: {}, fetchImpl: okFetch(calls) });
    const payload = JSON.parse(String(calls[0]!.init.body)) as {
      sessions: Array<{ id: string; events: Array<{ type: string }> }>;
    };
    const session = payload.sessions.find((s) => s.id === "s1")!;
    expect(session.events.filter((e) => e.type === "hook_executed")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// artifact spool → POST /v1/artifacts, uploaded at sync time
// ---------------------------------------------------------------------------

const ART_BYTES = Buffer.from("png-bytes-of-the-proof-shot");
const ART_SHA = createHash("sha256").update(ART_BYTES).digest("hex");

function spoolArtifact(record: Record<string, unknown>, blobBytes?: Buffer): void {
  mkdirSync(artifactBlobsDir(home), { recursive: true });
  appendFileSync(artifactsSpoolPath(home), JSON.stringify(record) + "\n");
  if (blobBytes) writeFileSync(join(artifactBlobsDir(home), String(record.sha256)), blobBytes);
}

function artifactRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rec: "artifact",
    artifactId: "11111111-2222-4333-8444-555555555555",
    t: new Date().toISOString(),
    sessionId: "s1",
    cwd: "/home/x/acme",
    gitRepo: "github.com/x/acme",
    gitBranch: "main",
    commitSha: "c".repeat(40),
    prNumber: 61,
    filename: "shot.png",
    mediaType: "image/png",
    bytes: ART_BYTES.length,
    sha256: ART_SHA,
    caption: "checkout works end to end",
    criterionId: "AC-082-02",
    ...over,
  };
}

/** okFetch for the session batch endpoint plus an artifact endpoint that
 * answers with the given status. */
function fetchWithArtifacts(calls: FetchCall[], artifactStatus = 200): typeof fetch {
  const ok = okFetch(calls);
  return (async (url: URL | RequestInfo, init?: RequestInit) => {
    if (String(url).endsWith("/v1/artifacts")) {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ data: { artifactId: "art-1", provenance: "session" } }), {
        status: artifactStatus,
      });
    }
    return ok(url, init);
  }) as typeof fetch;
}

/** A transcript whose assistant turn's tool call ran the emitting command —
 * the text `resolveArtifactTurnIndex` locates the turn by. */
function transcriptWithEmitCall(id: string, filename: string): void {
  transcript(id, [
    userLine(id, "prove it works"),
    {
      sessionId: id,
      type: "assistant",
      version: "2.1.193",
      cwd: "/home/x/acme",
      gitBranch: "main",
      timestamp: "2026-07-10T10:00:00.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: `outerlayer emit artifact ${filename} --caption "proof"` },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    },
  ]);
}

describe("runSync — artifact upload", () => {
  // proves AC-082-02 — a spooled artifact whose session is in this run's
  // scan uploads bound to that session with the emitting turn resolved from
  // the tool-call text; success advances the artifact watermark and removes
  // the spooled blob bytes.
  it("uploads with session.sessionId + resolved turnIndex, advances the watermark, deletes the blob", async () => {
    transcriptWithEmitCall("s1", "shot.png");
    const record = artifactRecord();
    spoolArtifact(record, ART_BYTES);

    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: fetchWithArtifacts(calls) });
    expect(result.synced).toBe(1);

    // Sessions ship BEFORE artifacts — the server validates the session id.
    expect(calls.map((c) => c.url)).toEqual([
      "https://gw.outerlayer.test/v1/agents/sync",
      "https://gw.outerlayer.test/v1/artifacts",
    ]);
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CREDS.apiKey}`);
    expect(headers["x-outerlayer-app-id"]).toBe(CREDS.appId);

    const payload = JSON.parse(String(calls[1]!.init.body)) as {
      schemaVersion: number;
      artifact: Record<string, unknown>;
      blob: { data: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.artifact).toEqual({
      clientArtifactId: "11111111-2222-4333-8444-555555555555",
      filename: "shot.png",
      mediaType: "image/png",
      bytes: ART_BYTES.length,
      sha256: ART_SHA,
      caption: "checkout works end to end",
      criterionId: "AC-082-02",
      emittedAt: record.t,
      prNumber: 61,
      gitRepo: "github.com/x/acme",
      gitBranch: "main",
      commitSha: "c".repeat(40),
      session: { sessionId: "s1", turnIndex: 1 },
    });
    expect(payload.blob.data).toBe(ART_BYTES.toString("base64"));

    expect(readArtifactsWatermark(home)).toBe(readFileSync(artifactsSpoolPath(home)).length);
    expect(existsSync(join(artifactBlobsDir(home), ART_SHA))).toBe(false);
  });

  it("a session synced in an EARLIER run still uploads — session id only, no turnIndex", async () => {
    spoolArtifact(artifactRecord({ sessionId: "ghost-session" }), ART_BYTES);
    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: fetchWithArtifacts(calls) });
    expect(result.synced).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["https://gw.outerlayer.test/v1/artifacts"]);
    const payload = JSON.parse(String(calls[0]!.init.body)) as { artifact: { session: unknown } };
    expect(payload.artifact.session).toEqual({ sessionId: "ghost-session" });
    expect(readArtifactsWatermark(home)).toBe(readFileSync(artifactsSpoolPath(home)).length);
  });

  it("dry-run lists the pending artifact, touches no watermark, and makes no artifact POST", async () => {
    transcriptWithEmitCall("s1", "shot.png");
    spoolArtifact(artifactRecord({ t: "2026-08-14T09:00:00.000Z" }), ART_BYTES);

    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, dryRun: true, json: true, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: fetchWithArtifacts(calls) });

    const parsed = JSON.parse(result.output) as { artifacts: unknown };
    expect(parsed.artifacts).toEqual({
      pending: 1,
      records: [{ filename: "shot.png", kind: "screenshot", sessionId: "s1", emittedAt: "2026-08-14T09:00:00.000Z" }],
    });
    expect(calls).toEqual([]);
    expect(existsSync(artifactsWatermarkPath(home))).toBe(false);
    expect(readArtifactsWatermark(home)).toBe(0);
    expect(existsSync(join(artifactBlobsDir(home), ART_SHA))).toBe(true);
  });

  it("dry-run human output includes the pending-artifact rows", async () => {
    transcriptWithEmitCall("s1", "shot.png");
    spoolArtifact(artifactRecord(), ART_BYTES);
    const result = await runSync({ ...CREDS, dryRun: true, root, home, ...hermetic, quiet: true, env: {} });
    expect(result.output).toContain("artifacts    1 pending upload");
    expect(result.output).toContain("screenshot  shot.png");
  });

  it("a failed artifact upload holds the watermark back and leaves the blob in place", async () => {
    transcriptWithEmitCall("s1", "shot.png");
    spoolArtifact(artifactRecord(), ART_BYTES);

    const calls: FetchCall[] = [];
    const result = await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: fetchWithArtifacts(calls, 500) });

    // The sync itself still succeeds — artifacts never fail the session run.
    expect(result.synced).toBe(1);
    expect(readArtifactsWatermark(home)).toBe(0);
    expect(existsSync(join(artifactBlobsDir(home), ART_SHA))).toBe(true);

    // The next sync retries the held record.
    const retryCalls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: fetchWithArtifacts(retryCalls) });
    expect(retryCalls.map((c) => c.url)).toEqual(["https://gw.outerlayer.test/v1/artifacts"]);
    expect(readArtifactsWatermark(home)).toBe(readFileSync(artifactsSpoolPath(home)).length);
    expect(existsSync(join(artifactBlobsDir(home), ART_SHA))).toBe(false);
  });

  it("a record still failing after 14 days is dropped — the watermark advances past it", async () => {
    spoolArtifact(artifactRecord({ t: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString() }), ART_BYTES);
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: fetchWithArtifacts(calls, 500) });
    expect(calls.map((c) => c.url)).toEqual(["https://gw.outerlayer.test/v1/artifacts"]);
    expect(readArtifactsWatermark(home)).toBe(readFileSync(artifactsSpoolPath(home)).length);
  });

  it("a record whose blob file is missing is dropped without any POST", async () => {
    spoolArtifact(artifactRecord());
    const calls: FetchCall[] = [];
    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: fetchWithArtifacts(calls) });
    expect(calls).toEqual([]);
    expect(readArtifactsWatermark(home)).toBe(readFileSync(artifactsSpoolPath(home)).length);
  });

  it("a blob shared by an uploaded and a held record survives for the retry", async () => {
    // Two records, same sha; the artifact endpoint accepts the first and
    // rejects the second — the shared blob must NOT be deleted.
    spoolArtifact(artifactRecord({ artifactId: "11111111-2222-4333-8444-555555555551", sessionId: "ghost-a" }), ART_BYTES);
    spoolArtifact(artifactRecord({ artifactId: "11111111-2222-4333-8444-555555555552", sessionId: "ghost-b" }));
    let artifactPosts = 0;
    const flaky = (async (url: URL | RequestInfo) => {
      if (String(url).endsWith("/v1/artifacts")) {
        artifactPosts += 1;
        return artifactPosts === 1
          ? new Response(JSON.stringify({ data: { artifactId: "a", provenance: "session" } }), { status: 200 })
          : new Response("{}", { status: 500 });
      }
      return new Response(JSON.stringify({ data: { accepted: [], rejected: [], blobsStored: 0 } }), { status: 200 });
    }) as typeof fetch;

    await runSync({ ...CREDS, root, home, ...hermetic, quiet: true, env: {}, fetchImpl: flaky });

    expect(artifactPosts).toBe(2);
    expect(existsSync(join(artifactBlobsDir(home), ART_SHA))).toBe(true);
    // Held back to the SECOND record's offset — past the first line only.
    const firstLineBytes = readFileSync(artifactsSpoolPath(home), "utf8").split("\n")[0]!.length + 1;
    expect(readArtifactsWatermark(home)).toBe(firstLineBytes);
  });
});
