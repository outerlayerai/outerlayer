// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const RAW_DIR = join(__dirname, "..", "..", "fixtures", "raw");

interface ManifestFile {
  name: string;
  lines: number;
  versions: string[];
  subagent: boolean;
  strata: string[];
  features: Record<string, boolean>;
}
interface Manifest {
  sanitizerVersion: number;
  totalFiles: number;
  files: ManifestFile[];
}

const manifest: Manifest = JSON.parse(readFileSync(join(RAW_DIR, "MANIFEST.json"), "utf8"));
const jsonlFiles = readdirSync(RAW_DIR).filter((f) => f.endsWith(".jsonl"));

function readLines(name: string): string[] {
  return readFileSync(join(RAW_DIR, name), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

describe("sanitized fixture corpus", () => {
  it("manifest and directory agree, corpus is ≥40 sessions + the synthetic", () => {
    expect(manifest.files.map((f) => f.name).sort()).toEqual(jsonlFiles.sort());
    expect(jsonlFiles.length).toBeGreaterThanOrEqual(41);
    expect(jsonlFiles).toContain("synthetic-future-version.jsonl");
  });

  it("stratification quotas hold (recounted from file contents, not trusted from the manifest)", () => {
    const counts = { versions: new Set<string>(), compaction: 0, apiError: 0, prLink: 0, queueOp: 0, sidechain: 0, interrupt: 0, small: 0, large: 0 };
    for (const name of jsonlFiles) {
      if (name === "synthetic-future-version.jsonl") continue;
      const lines = readLines(name);
      if (lines.length <= 60) counts.small++;
      if (lines.length > 600) counts.large++;
      let has = { compaction: false, apiError: false, prLink: false, queueOp: false, sidechain: false, interrupt: false };
      for (const line of lines) {
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof rec.version === "string") counts.versions.add(rec.version);
        if (rec.type === "summary" || rec.isCompactSummary === true || rec.subtype === "compact_boundary") has.compaction = true;
        if (rec.subtype === "api_error") has.apiError = true;
        if (rec.type === "pr-link") has.prLink = true;
        if (rec.type === "queue-operation") has.queueOp = true;
        if (rec.isSidechain === true) has.sidechain = true;
        if (line.includes("[Request interrupted by user")) has.interrupt = true;
      }
      counts.compaction += has.compaction ? 1 : 0;
      counts.apiError += has.apiError ? 1 : 0;
      counts.prLink += has.prLink ? 1 : 0;
      counts.queueOp += has.queueOp ? 1 : 0;
      counts.sidechain += has.sidechain ? 1 : 0;
      counts.interrupt += has.interrupt ? 1 : 0;
    }
    expect(counts.versions.size).toBeGreaterThanOrEqual(6);
    expect(counts.compaction).toBeGreaterThanOrEqual(2);
    expect(counts.apiError).toBeGreaterThanOrEqual(2);
    expect(counts.prLink).toBeGreaterThanOrEqual(2);
    expect(counts.queueOp).toBeGreaterThanOrEqual(2);
    expect(counts.sidechain).toBeGreaterThanOrEqual(2);
    expect(counts.interrupt).toBeGreaterThanOrEqual(2);
    expect(counts.small).toBeGreaterThanOrEqual(6);
    expect(counts.large).toBeGreaterThanOrEqual(4);
  });

  it("subagent-tagged fixtures actually look like subagent transcripts", () => {
    const tagged = manifest.files.filter((f) => f.subagent);
    expect(tagged.length).toBeGreaterThanOrEqual(4);
    for (const f of tagged) {
      const text = readFileSync(join(RAW_DIR, f.name), "utf8");
      expect(
        text.includes('"agentId"') || text.includes('"isSidechain":true'),
        `${f.name} should carry subagent markers`,
      ).toBe(true);
    }
  });

  it("leak scan is clean over the committed corpus", async () => {
    const { scanDir } = await import("../../scripts/leak-scan.mjs");
    expect(scanDir(RAW_DIR)).toEqual([]);
  });

  it("leak scanner catches planted content (a clean scan means nothing if it cannot fail)", async () => {
    const { scanValue, FORBIDDEN_NEEDLES } = await import("../../scripts/sanitize-lib.mjs");
    const planted = {
      type: "user",
      message: { role: "user", content: "please refactor the billing reconciliation job" },
      cwd: "/Users/someone/next-startup",
    };
    const violations = scanValue(planted);
    expect(violations.length).toBeGreaterThanOrEqual(2);
    const paths = violations.map((v: { path: string }) => v.path);
    expect(paths).toContain("$.message.content");
    expect(paths).toContain("$.cwd");
    expect(FORBIDDEN_NEEDLES.test("/Users/somedev/Development")).toBe(true);
    expect(FORBIDDEN_NEEDLES.test("x agentmark x")).toBe(true);
  });

  describe("FORBIDDEN_NEEDLES additive extras", () => {
    // Each case gets a fresh module instance: the needle regex is built once at
    // module load, so a cached copy would carry the previous case's env.
    const loadNeedles = async (extras: string | undefined) => {
      const before = process.env.SANITIZE_EXTRA_NEEDLES;
      if (extras === undefined) delete process.env.SANITIZE_EXTRA_NEEDLES;
      else process.env.SANITIZE_EXTRA_NEEDLES = extras;
      try {
        vi.resetModules();
        const mod = await import("../../scripts/sanitize-lib.mjs");
        return mod.FORBIDDEN_NEEDLES as RegExp;
      } finally {
        if (before === undefined) delete process.env.SANITIZE_EXTRA_NEEDLES;
        else process.env.SANITIZE_EXTRA_NEEDLES = before;
      }
    };

    it("commits no personal identifiers, so the floor alone cannot leak a targeting list", async () => {
      const needles = await loadNeedles(undefined);
      // The catch-all still covers any real home path, which is how the
      // username the floor no longer names stays caught.
      expect(needles.test("/Users/somedev/Development")).toBe(true);
      expect(needles.test("x agentmark x")).toBe(true);
      // A bare personal token outside a path is what the local extras cover.
      expect(needles.test("somedev")).toBe(false);
      expect(needles.test("dev@example.com")).toBe(false);
    });

    it("appends env-supplied needles without weakening the committed floor", async () => {
      const needles = await loadNeedles("somedev,dev@example.com");
      expect(needles.test("somedev")).toBe(true);
      expect(needles.test("Author: SomeDev")).toBe(true); // case-insensitive
      expect(needles.test("dev@example.com")).toBe(true);
      // Floor entries survive the append.
      expect(needles.test("x agentmark x")).toBe(true);
      expect(needles.test("/Users/other/x")).toBe(true);
      // Sanitizer output is still exempt, and unrelated text still passes.
      expect(needles.test("/Users/x")).toBe(false);
      expect(needles.test("please refactor the billing job")).toBe(false);
    });

    it("treats extras as literals and drops blanks, so neither can match everything", async () => {
      const needles = await loadNeedles("a.c, ,,  ");
      // `.` escaped: matches the literal, not any single character.
      expect(needles.test("a.c")).toBe(true);
      expect(needles.test("abc")).toBe(false);
      // A blank alternative would match the empty string and flag every value.
      expect(needles.test("unrelated text")).toBe(false);
      expect(needles.test("")).toBe(false);
    });
  });

  it("synthetic future-version fixture: unknown types, future version, truncated tail", () => {
    const lines = readFileSync(join(RAW_DIR, "synthetic-future-version.jsonl"), "utf8").split("\n");
    const parsed = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null);
    const types = new Set(parsed.map((r) => r.type));
    expect(types).toContain("hologram-checkpoint");
    expect(types).toContain("quantum-sync");
    expect(parsed.some((r) => r.version === "9.9.9")).toBe(true);
    // final line is a truncated JSON object (live-write race fixture)
    const last = lines.filter((l) => l.trim().length > 0).at(-1)!;
    expect(() => JSON.parse(last)).toThrow();
    expect(last.startsWith("{")).toBe(true);
  });

  it("every fixture keeps usage/timestamp realism: ≥60% of assistant lines carry usage with integer token counts", () => {
    let assistant = 0;
    let withUsage = 0;
    for (const name of jsonlFiles) {
      if (name === "synthetic-future-version.jsonl") continue;
      for (const line of readLines(name)) {
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type !== "assistant") continue;
        assistant++;
        const msg = rec.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, unknown> | undefined;
        if (usage && Number.isInteger(usage.input_tokens) && Number.isInteger(usage.output_tokens)) {
          withUsage++;
        }
      }
    }
    expect(assistant).toBeGreaterThan(100);
    expect(withUsage / assistant).toBeGreaterThan(0.6);
  });
});
