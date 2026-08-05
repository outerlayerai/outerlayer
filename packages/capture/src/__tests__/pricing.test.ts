// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { resolvePrice, costOfUsage, isPriceKnown } from "../pricing.js";

describe("resolvePrice", () => {
  it("resolves the founder's real models exactly, cache-aware", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"]) {
      const { price, via } = resolvePrice(id);
      expect(price, id).not.toBeNull();
      expect(price!.in).toBeGreaterThan(0);
      expect(price!.out).toBeGreaterThan(0);
      expect(price!.cacheRead, `${id} cacheRead`).toBeGreaterThan(0);
      expect(via).toBe("exact");
    }
  });

  it("normalizes an unpriced provider-prefixed id down to a priced base", () => {
    // a made-up region prefix on a real base is not itself a table key, so it
    // must normalize (strip the prefix) to the base price
    const base = resolvePrice("claude-opus-4-8").price!;
    const prefixed = resolvePrice("acmeproxy/claude-opus-4-8");
    expect(prefixed.price).not.toBeNull();
    expect(prefixed.via).toBe("normalized");
    expect(prefixed.price!.in).toBe(base.in);
  });

  it("prices a future non-date variant against its base via boundary-prefix", () => {
    // a suffix the date-normalizer won't strip → falls through to prefix match
    const { price, via } = resolvePrice("claude-opus-4-8-experimental");
    expect(price).not.toBeNull();
    expect(via).toBe("prefix");
    expect(price!.in).toBe(resolvePrice("claude-opus-4-8").price!.in);
  });

  it("returns null for a genuinely unknown model (never guessed)", () => {
    expect(resolvePrice("totally-made-up-xyz").price).toBeNull();
    expect(resolvePrice("").price).toBeNull();
    expect(isPriceKnown("totally-made-up-xyz")).toBe(false);
  });

  it("prices codex's gpt-5.4 from the registry (the model the vendored snapshot missed)", () => {
    const { price } = resolvePrice("gpt-5.4");
    expect(price).not.toBeNull();
    expect(price!.in).toBeGreaterThan(0);
    expect(price!.out).toBeGreaterThan(0);
    expect(price!.cacheRead).toBeGreaterThan(0);
  });
});

describe("costOfUsage", () => {
  it("is cache-aware: cache-read is ~10x cheaper than fresh input, not collapsed", () => {
    const freshHeavy = costOfUsage("claude-opus-4-8", { in: 10000, out: 0, cacheRead: 0, cacheCreate: 0 })!;
    const cacheHeavy = costOfUsage("claude-opus-4-8", { in: 0, out: 0, cacheRead: 10000, cacheCreate: 0 })!;
    expect(cacheHeavy).toBeLessThan(freshHeavy);
    expect(cacheHeavy).toBeCloseTo(freshHeavy / 10, 6); // opus cacheRead = 0.1x input
  });

  it("sums the four token classes at their own prices", () => {
    const p = resolvePrice("claude-opus-4-8").price!;
    const usage = { in: 3, out: 5, cacheRead: 7, cacheCreate: 11 };
    const expected = 3 * p.in + 5 * p.out + 7 * (p.cacheRead ?? 0) + 11 * (p.cacheCreate ?? 0);
    expect(costOfUsage("claude-opus-4-8", usage)).toBeCloseTo(expected, 12);
  });

  it("returns null (not 0) for unknown models", () => {
    expect(costOfUsage("nope-model", { in: 1, out: 1, cacheRead: 0, cacheCreate: 0 })).toBeNull();
  });
});
