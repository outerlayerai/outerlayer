// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Capture tiers, ordered least → most permissive.
 *
 * - `metrics`  — counts, costs, timings, tool names, statuses. No content,
 *                no identifiers of the code being worked on.
 * - `redacted` — + structure identifiers (cwd, repo, branch, file paths,
 *                normalized error signatures, event data). No message text,
 *                no tool inputs/outputs.
 * - `full`     — everything, including message text and tool I/O.
 */
export const CAPTURE_TIERS = ["metrics", "redacted", "full"] as const;
export type CaptureTier = (typeof CAPTURE_TIERS)[number];

const TIER_RANK: Record<CaptureTier, number> = { metrics: 0, redacted: 1, full: 2 };

/** True when `a` is at least as permissive as `b`. */
export function tierAtLeast(a: CaptureTier, b: CaptureTier): boolean {
  return TIER_RANK[a] >= TIER_RANK[b];
}

/**
 * THE single source of truth mapping schema fields to the minimum capture
 * tier at which they may be present. Consumed by:
 *  - `downconvertSession` (this package) — local enforcement,
 *  - server-side write enforcement — the tenant's configured tier is
 *    applied at ingest regardless of what the client sent.
 *
 * Path syntax: dot-separated, `[]` = every array element. Any field NOT
 * listed here is `metrics` (always allowed). A listed path bans the field —
 * and everything nested under it — below its tier.
 *
 * Design rule: `vendor` passthrough is `full`-only because unknown
 * data cannot be tier-classified; the most conservative bound applies.
 */
export const FIELD_TIERS: Readonly<Record<string, Exclude<CaptureTier, "metrics">>> = {
  "actor.email": "redacted",
  "env.cwd": "redacted",
  "env.gitRepo": "redacted",
  "env.gitBranch": "redacted",
  "env.commitSha": "redacted",
  "outcome": "redacted",
  // `hook_executed`/`hook_blocked` event data (commands, durations, counts,
  // the triggering tool_use id). A command identifies which hook ran — closer
  // to a tool NAME than to its output — so it stays here at `redacted`
  // alongside timing; a `metrics`-tier session loses all of it, including
  // hook timing, since durations aren't separable from the command string
  // without a narrower carve-out (see the entry below for the one field that
  // gets one).
  "events[].data": "redacted",
  // Hook stderr/error text (`SessionEvent.errorText`) is process OUTPUT, not
  // an identifier — the same classification as tool output
  // (`turns[].toolCalls[].output`, `full` below) — so it rides its own field,
  // separate from `data`, and is gated at `full`. `data.errorCount` (how
  // many, not what) stays under the entry above at `redacted`: failure is
  // visible at `redacted`, only the raw body needs `full`.
  "events[].errorText": "full",
  "warnings[].detail": "redacted",
  "turns[].toolCalls[].file": "redacted",
  "turns[].toolCalls[].errorSignature": "redacted",
  "title": "full",
  "vendor": "full",
  "turns[].text": "full",
  "turns[].thinking": "full",
  "turns[].images": "full",
  "turns[].vendor": "full",
  "turns[].toolCalls[].input": "full",
  "turns[].toolCalls[].output": "full",
} as const;

/** Field paths banned below `full` (content-bearing). */
export function contentBearingPaths(): string[] {
  return Object.entries(FIELD_TIERS)
    .filter(([, tier]) => tier === "full")
    .map(([path]) => path);
}

/** All paths a session at `tier` must NOT contain. */
export function bannedPathsForTier(tier: CaptureTier): string[] {
  return Object.entries(FIELD_TIERS)
    .filter(([, minTier]) => !tierAtLeast(tier, minTier))
    .map(([path]) => path);
}

type JsonRecord = Record<string, unknown>;

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Delete `segments` (already split, `[]` = descend arrays) under `node`. */
function deletePath(node: unknown, segments: string[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (head === "[]") {
    if (Array.isArray(node)) for (const item of node) deletePath(item, rest);
    return;
  }
  if (!isRecord(node)) return;
  if (rest.length === 0) {
    delete node[head];
    return;
  }
  deletePath(node[head], rest);
}

function splitPath(path: string): string[] {
  // "turns[].toolCalls[].input" → ["turns", "[]", "toolCalls", "[]", "input"]
  return path
    .split(".")
    .flatMap((seg) => (seg.endsWith("[]") ? [seg.slice(0, -2), "[]"] : [seg]));
}

/**
 * Down-convert a session (as a plain JSON object) to `targetTier`: strips every
 * field whose minimum tier exceeds the target and stamps `captureTier`.
 *
 * Pure — returns a structured clone; never up-converts (asking for a tier at
 * or above the session's recorded tier returns a clone with only the banned
 * fields for the *target* removed, which is a no-op for well-formed input).
 */
export function downconvertSession<T extends JsonRecord>(session: T, targetTier: CaptureTier): T {
  const clone = structuredClone(session) as JsonRecord;
  for (const path of bannedPathsForTier(targetTier)) {
    deletePath(clone, splitPath(path));
  }
  clone.captureTier = targetTier;
  return clone as T;
}

/**
 * Collect the paths present in `session` that are banned at `tier`
 * (empty array = compliant). Used by tests and by the cloud write-side audit.
 */
export function tierViolations(session: JsonRecord, tier: CaptureTier): string[] {
  const violations: string[] = [];
  const check = (node: unknown, segments: string[], display: string): void => {
    const [head, ...rest] = segments;
    if (head === undefined) {
      if (node !== undefined) violations.push(display);
      return;
    }
    if (head === "[]") {
      if (Array.isArray(node)) node.forEach((item, i) => check(item, rest, `${display}[${i}]`));
      return;
    }
    if (!isRecord(node)) return;
    check(node[head], rest, display ? `${display}.${head}` : head);
  };
  for (const path of bannedPathsForTier(tier)) {
    check(session, splitPath(path), "");
  }
  return violations;
}
