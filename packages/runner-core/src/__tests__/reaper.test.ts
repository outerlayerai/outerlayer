// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { reapOrphans } from "../reaper.js";
import { MemorySink, safeSink } from "../events.js";
import type { SandboxInfo, SandboxProvider } from "../types.js";

function fakeProvider(sandboxes: SandboxInfo[], failIds: Set<string> = new Set()) {
  const destroyed: string[] = [];
  const provider: SandboxProvider = {
    id: "fake",
    prepareEnv: () => Promise.reject(new Error("unused")),
    create: () => Promise.reject(new Error("unused")),
    exec: () => Promise.reject(new Error("unused")),
    putFiles: () => Promise.reject(new Error("unused")),
    getFile: () => Promise.reject(new Error("unused")),
    list: async () => sandboxes,
    destroy: async (s) => {
      if (failIds.has(s.id)) throw new Error(`cannot destroy ${s.id}`);
      destroyed.push(s.id);
    },
  };
  return { provider, destroyed };
}

function sandboxAged(id: string, ageMs: number, now: number): SandboxInfo {
  return {
    id,
    providerId: "fake",
    envKey: "e",
    createdAt: new Date(now - ageMs).toISOString(),
    ageMs,
  };
}

describe("reapOrphans", () => {
  const NOW = Date.parse("2026-07-06T12:00:00.000Z");

  it("destroys only sandboxes strictly older than TTL", async () => {
    const { provider, destroyed } = fakeProvider([
      sandboxAged("old", 61_000, NOW),
      sandboxAged("fresh", 59_000, NOW),
      sandboxAged("boundary", 60_000, NOW),
    ]);
    const report = await reapOrphans(provider, { ttlMs: 60_000, now: () => NOW });
    expect(destroyed).toEqual(["old"]);
    expect(report.destroyed.map((s) => s.id)).toEqual(["old"]);
    expect(report.inspected).toBe(3);
    expect(report.failures).toEqual([]);
  });

  it("a destroy failure is reported and does not abort the sweep", async () => {
    const { provider, destroyed } = fakeProvider(
      [sandboxAged("a", 100_000, NOW), sandboxAged("b", 100_000, NOW), sandboxAged("c", 100_000, NOW)],
      new Set(["b"]),
    );
    const report = await reapOrphans(provider, { ttlMs: 0, now: () => NOW });
    expect(destroyed).toEqual(["a", "c"]);
    expect(report.failures).toEqual([
      { sandbox: expect.objectContaining({ id: "b" }), error: "cannot destroy b" },
    ]);
  });

  it("emits reaper_destroyed events with age metadata", async () => {
    const sink = new MemorySink();
    const { provider } = fakeProvider([sandboxAged("x", 90_000, NOW)]);
    await reapOrphans(provider, { ttlMs: 1_000, now: () => NOW, eventSink: sink });
    const events = sink.ofType("reaper_destroyed");
    expect(events).toEqual([
      expect.objectContaining({
        providerId: "fake",
        sandboxId: "x",
        meta: { ageMs: 90_000 },
      }),
    ]);
  });
});

describe("safeSink", () => {
  it("swallows sink exceptions", () => {
    const throwing = safeSink({
      emit: () => {
        throw new Error("boom");
      },
    });
    expect(() =>
      throwing.emit({ type: "sandbox_created", providerId: "p", ts: "t" }),
    ).not.toThrow();
  });
});
