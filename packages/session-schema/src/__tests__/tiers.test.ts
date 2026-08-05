// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { parseAgentSession } from "../schema.js";
import {
  bannedPathsForTier,
  contentBearingPaths,
  downconvertSession,
  tierAtLeast,
  tierViolations,
} from "../tiers.js";
import { canonicalStringify } from "../canonical.js";
import { minimalSession, richSession, SECRET } from "./helpers.js";

describe("tier ordering", () => {
  it("orders metrics < redacted < full", () => {
    expect(tierAtLeast("full", "metrics")).toBe(true);
    expect(tierAtLeast("full", "redacted")).toBe(true);
    expect(tierAtLeast("redacted", "metrics")).toBe(true);
    expect(tierAtLeast("metrics", "redacted")).toBe(false);
    expect(tierAtLeast("redacted", "full")).toBe(false);
    expect(tierAtLeast("metrics", "metrics")).toBe(true);
  });

  it("bannedPathsForTier is exact per tier", () => {
    expect(bannedPathsForTier("full")).toEqual([]);
    expect(bannedPathsForTier("redacted").sort()).toEqual(
      ["title", "turns[].text", "turns[].thinking", "turns[].images", "turns[].toolCalls[].input", "turns[].toolCalls[].output", "turns[].vendor", "vendor", "events[].errorText"].sort(),
    );
    expect(bannedPathsForTier("metrics").sort()).toEqual(
      [
        "actor.email",
        "env.cwd",
        "env.gitRepo",
        "env.gitBranch",
        "env.commitSha",
        "outcome",
        "events[].data",
        "events[].errorText",
        "warnings[].detail",
        "turns[].toolCalls[].file",
        "turns[].toolCalls[].errorSignature",
        "title",
        "turns[].text",
        "turns[].thinking",
        "turns[].images",
        "turns[].toolCalls[].input",
        "turns[].toolCalls[].output",
        "turns[].vendor",
        "vendor",
      ].sort(),
    );
  });

  it("contentBearingPaths is exactly the full-only set", () => {
    expect(contentBearingPaths().sort()).toEqual(bannedPathsForTier("redacted").sort());
  });
});

describe("downconvertSession", () => {
  it("metrics down-conversion leaves ZERO content-bearing bytes", () => {
    const metrics = downconvertSession(richSession(), "metrics");
    expect(canonicalStringify(metrics)).not.toContain(SECRET);
    expect(tierViolations(metrics, "metrics")).toEqual([]);
    expect(metrics.captureTier).toBe("metrics");
    // still a valid session afterwards
    expect(() => parseAgentSession(metrics)).not.toThrow();
    // and the metrics facts survived
    expect(metrics.totals.costUsd).toBe(0.0421);
    expect(metrics.turns[1]!.usage).toEqual({ in: 12, out: 340, cacheRead: 5000, cacheCreate: 900 });
    expect(metrics.turns[1]!.toolCalls[0]!.status).toBe("error");
    expect(metrics.turns[1]!.toolCalls[0]!.name).toBe("Edit");
  });

  it("redacted keeps structure identifiers but strips content", () => {
    const redacted = downconvertSession(richSession(), "redacted");
    // kept at redacted
    expect(redacted.env.cwd).toBe(`/home/${SECRET}/project`);
    expect(redacted.turns[1]!.toolCalls[0]!.file).toBe(`src/${SECRET}.ts`);
    expect(redacted.turns[1]!.toolCalls[0]!.errorSignature).toContain("String to replace");
    expect(redacted.outcome?.prNumber).toBe(77);
    expect(redacted.warnings[0]!.detail).toBe(`line type ${SECRET}`);
    // stripped at redacted
    expect(redacted.title).toBeUndefined();
    expect(redacted.vendor).toBeUndefined();
    expect(redacted.turns[0]!.text).toBeUndefined();
    expect(redacted.turns[1]!.vendor).toBeUndefined();
    expect(redacted.turns[1]!.toolCalls[0]!.input).toBeUndefined();
    expect(redacted.turns[1]!.toolCalls[0]!.output).toBeUndefined();
    expect(tierViolations(redacted, "redacted")).toEqual([]);
    expect(() => parseAgentSession(redacted)).not.toThrow();
  });

  it("is pure (input untouched) and idempotent", () => {
    const input = richSession();
    const before = canonicalStringify(input);
    const once = downconvertSession(input, "metrics");
    const twice = downconvertSession(once, "metrics");
    expect(canonicalStringify(input)).toBe(before);
    expect(canonicalStringify(twice)).toBe(canonicalStringify(once));
  });

  it("cannot up-convert: full target on a metrics session adds nothing", () => {
    const metrics = downconvertSession(richSession(), "metrics");
    const reFull = downconvertSession(metrics, "full");
    expect(canonicalStringify({ ...reFull, captureTier: "metrics" })).toBe(
      canonicalStringify(metrics),
    );
  });
});

describe("tierViolations", () => {
  it("pinpoints each offending path with array indices", () => {
    expect(tierViolations(richSession(), "metrics").sort()).toEqual(
      [
        "actor.email",
        "env.cwd",
        "env.gitRepo",
        "env.gitBranch",
        "outcome",
        "events[0].data",
        "events[1].data",
        "warnings[0].detail",
        "turns[0].text",
        "turns[1].text",
        "turns[1].vendor",
        "turns[1].toolCalls[0].file",
        "turns[1].toolCalls[0].errorSignature",
        "turns[1].toolCalls[0].input",
        "turns[1].toolCalls[0].output",
        "turns[1].toolCalls[1].input",
        "title",
        "vendor",
      ].sort(),
    );
  });

  it("returns [] for a clean minimal session at every tier", () => {
    for (const tier of ["metrics", "redacted", "full"] as const) {
      expect(tierViolations(minimalSession(), tier)).toEqual([]);
    }
  });
});

describe("randomized down-conversion property", () => {
  // mulberry32 — deterministic, seed committed.
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("100 random sessions: no SECRET survives metrics conversion, result always valid", () => {
    const rand = rng(1057);
    const int = (n: number) => Math.floor(rand() * n);
    for (let i = 0; i < 100; i++) {
      const s = richSession();
      // vary array shapes: 0–3 turns, 0–3 tool calls each, 0–2 events/warnings
      s.turns = Array.from({ length: int(4) }, (_, ti) => ({
        index: ti,
        role: ti % 2 === 0 ? ("user" as const) : ("assistant" as const),
        toolCalls: Array.from({ length: int(4) }, () => ({
          name: "Bash",
          status: "ok" as const,
          isEdit: false,
          ...(rand() < 0.5 ? { input: { cmd: SECRET } } : {}),
          ...(rand() < 0.5 ? { output: SECRET } : {}),
          ...(rand() < 0.5 ? { file: `${SECRET}.ts` } : {}),
        })),
        ...(rand() < 0.5 ? { text: SECRET } : {}),
        ...(rand() < 0.3 ? { vendor: { deep: { nested: [SECRET] } } } : {}),
      }));
      s.events = Array.from({ length: int(3) }, (_, ei) => ({
        type: "compaction",
        seq: ei,
        ...(rand() < 0.7 ? { data: { note: SECRET } } : {}),
      }));
      s.warnings = Array.from({ length: int(3) }, () => ({
        code: "unknown_line_type",
        count: 1,
        ...(rand() < 0.7 ? { detail: SECRET } : {}),
      }));
      if (rand() < 0.5) delete (s as Record<string, unknown>).outcome;

      const metrics = downconvertSession(s, "metrics");
      expect(canonicalStringify(metrics)).not.toContain(SECRET);
      expect(tierViolations(metrics, "metrics")).toEqual([]);
      expect(() => parseAgentSession(metrics)).not.toThrow();
    }
  });
});
