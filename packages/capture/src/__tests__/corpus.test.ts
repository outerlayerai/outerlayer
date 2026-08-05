// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAgentSession, canonicalStringify } from "@outerlayer/session-schema";
import { parseTranscript } from "../adapters/claude-code/parse.js";

// The sanitized fixture corpus is this parser's realistic golden input —
// the exact bytes a customer's transcripts look like, minus content.
const FIXTURES_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "session-schema",
  "fixtures",
  "raw",
);
const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".jsonl"));

describe("parser over the sanitized fixture corpus", () => {
  it("corpus is present", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
  });

  it.each(files)("%s parses without throw → schema-valid, byte-stable", (name) => {
    const content = readFileSync(join(FIXTURES_DIR, name), "utf8");
    const { session } = parseTranscript(content, { fallbackId: name.replace(/\.jsonl$/, "") });
    if (!session) return; // a fixture may legitimately have zero mapped lines
    // schema-valid
    expect(() => parseAgentSession(session)).not.toThrow();
    // byte-stable: validate → serialize → re-validate → serialize
    const once = canonicalStringify(parseAgentSession(session));
    const twice = canonicalStringify(parseAgentSession(JSON.parse(once)));
    expect(twice).toBe(once);
  });

  it("the synthetic future-version fixture parses best-effort with drift warnings", () => {
    const content = readFileSync(join(FIXTURES_DIR, "synthetic-future-version.jsonl"), "utf8");
    const { session, warnings } = parseTranscript(content);
    expect(session).not.toBeNull();
    expect(warnings.version_newer_than_supported).toBeGreaterThanOrEqual(1);
    // unknown block types (neural_shard) and line types (hologram-checkpoint)
    // never threw; the truncated tail is tolerated
    expect(warnings.truncated_final_line ?? warnings.malformed_line).toBeGreaterThanOrEqual(1);
  });

  it("aggregate: whole corpus parses, warnings are bounded and typed", () => {
    let parsed = 0;
    const warnCodes = new Set<string>();
    for (const name of files) {
      const { session, warnings } = parseTranscript(readFileSync(join(FIXTURES_DIR, name), "utf8"));
      if (session) parsed += 1;
      for (const code of Object.keys(warnings)) warnCodes.add(code);
    }
    expect(parsed).toBeGreaterThanOrEqual(40);
    // every warning code is from the documented registry
    for (const code of warnCodes) {
      expect([
        "unknown_line_type",
        "malformed_line",
        "truncated_final_line",
        "version_newer_than_supported",
        "ambiguous_timezone",
        "unknown_model_cost",
      ]).toContain(code);
    }
  });
});
