// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { DetectionSession, DetectionToolCall } from "./types.js";

export const isEdit = (c: DetectionToolCall): boolean => c.isEdit === true || c.isEdit === 1;
export const isError = (c: DetectionToolCall): boolean => c.status === "error";

/** All tool calls across a session, flattened in order. */
export function toolCalls(s: DetectionSession): DetectionToolCall[] {
  return s.turns.flatMap((t) => t.toolCalls);
}

export function cacheReadRatio(s: DetectionSession): number | null {
  const denom = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheCreation;
  return denom > 0 ? s.tokens.cacheRead / denom : null;
}

export function shortProject(p: string | null | undefined): string {
  if (!p) return "(unknown)";
  return p.includes("/") ? p.split("/").filter(Boolean).slice(-2).join("/") : p;
}

/** Linear-interpolated percentile of a numeric array (0..1). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Approximate blended $/token for a model, from a session's measured
 * cost/tokens — lets a detector price a *span* of a session (e.g. tokens
 * burned in a retry loop) without re-deriving model prices. Null when the
 * session has no cost or no tokens. */
export function costPerToken(s: DetectionSession): number | null {
  const totalTokens = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
  if (!s.costUsd || totalTokens === 0) return null;
  return s.costUsd / totalTokens;
}
