// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays in
 * order, no whitespace variance. Two structurally equal sessions serialize
 * byte-identically — the property the golden tests and the incremental
 * parser's idempotence tests are built on.
 */
export function canonicalStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortKeysDeep(value), null, space);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) {
      const v = rec[key];
      if (v !== undefined) out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}
