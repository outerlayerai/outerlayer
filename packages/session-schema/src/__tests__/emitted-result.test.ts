// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import {
  EMITTED_RESULT_MAX_LINK_LENGTH,
  EMITTED_RESULT_PROVENANCES,
  EMITTED_RESULTS,
  EmittedNameSchema,
} from "../emitted-result.js";

describe("EmittedNameSchema", () => {
  it("accepts declaration-shaped names: lowercase slug with dots, up to 64 characters", () => {
    expect(EmittedNameSchema.safeParse("smoke.pass").success).toBe(true);
    expect(EmittedNameSchema.safeParse("migration.executed").success).toBe(true);
    expect(EmittedNameSchema.safeParse("e2e_smoke-01").success).toBe(true);
    expect(EmittedNameSchema.safeParse("a").success).toBe(true);
    expect(EmittedNameSchema.safeParse(`a${"b".repeat(63)}`).success).toBe(true);
  });

  it("rejects anything renderable as markup, spaces, wrong case, or a non-letter start", () => {
    expect(EmittedNameSchema.safeParse("").success).toBe(false);
    expect(EmittedNameSchema.safeParse("Smoke.Pass").success).toBe(false);
    expect(EmittedNameSchema.safeParse("smoke pass").success).toBe(false);
    expect(EmittedNameSchema.safeParse("1smoke").success).toBe(false);
    expect(EmittedNameSchema.safeParse(".pass").success).toBe(false);
    expect(EmittedNameSchema.safeParse("-lead").success).toBe(false);
    expect(EmittedNameSchema.safeParse("<img>").success).toBe(false);
    expect(EmittedNameSchema.safeParse("[x](y)").success).toBe(false);
    expect(EmittedNameSchema.safeParse("a|b").success).toBe(false);
  });

  it("rejects a name past 64 characters", () => {
    expect(EmittedNameSchema.safeParse(`a${"b".repeat(64)}`).success).toBe(false);
  });
});

describe("emitted-result shared constants", () => {
  it("pins the outcome and provenance tuples both ends validate against", () => {
    expect(EMITTED_RESULTS).toEqual(["pass", "fail"]);
    expect(EMITTED_RESULT_PROVENANCES).toEqual(["ci", "local"]);
  });

  it("pins the proof-link length bound shared by CLI validation and gateway schema", () => {
    expect(EMITTED_RESULT_MAX_LINK_LENGTH).toBe(500);
  });
});
