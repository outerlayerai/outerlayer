// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentSession } from "../schema.js";
import { canonicalStringify } from "../canonical.js";
import { downconvertSession } from "../tiers.js";

const CANONICAL_DIR = join(__dirname, "..", "..", "fixtures", "canonical");
const files = readdirSync(CANONICAL_DIR).filter((f) => f.endsWith(".json"));

describe("canonical fixture goldens", () => {
  it("corpus is present", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)("%s: committed bytes are canonical and byte-stable through validate→serialize→re-validate", (name) => {
    const raw = readFileSync(join(CANONICAL_DIR, name), "utf8");
    const value = JSON.parse(raw);

    // committed form IS the canonical form
    expect(canonicalStringify(value, 2) + "\n").toBe(raw);

    // validate → serialize → re-validate → serialize: byte-stable
    const once = parseAgentSession(value);
    const onceBytes = canonicalStringify(once, 2) + "\n";
    const twice = parseAgentSession(JSON.parse(onceBytes));
    expect(canonicalStringify(twice, 2) + "\n").toBe(onceBytes);

    // and validation must not have altered the committed content
    expect(onceBytes).toBe(raw);
  });

  it("downconverted-redacted golden equals live down-conversion of the full golden", () => {
    const full = parseAgentSession(
      JSON.parse(readFileSync(join(CANONICAL_DIR, "full.json"), "utf8")),
    );
    const golden = readFileSync(join(CANONICAL_DIR, "downconverted-redacted.json"), "utf8");
    expect(canonicalStringify(downconvertSession(full, "redacted"), 2) + "\n").toBe(golden);
  });

  it("downconverted-metrics golden equals live down-conversion of the full golden", () => {
    const full = parseAgentSession(
      JSON.parse(readFileSync(join(CANONICAL_DIR, "full.json"), "utf8")),
    );
    const golden = readFileSync(join(CANONICAL_DIR, "downconverted-metrics.json"), "utf8");
    expect(canonicalStringify(downconvertSession(full, "metrics"), 2) + "\n").toBe(golden);
  });
});
