/**
 * Repo path length caps for a NEWLY created context file, and the check both
 * the create surfaces and the server save boundary run against them.
 *
 * Lives outside both `src/features/` and `src/lib/system/`: the client create
 * UI (`features/context/components/context-create.ts`) and the system-tier
 * save service (`lib/system/context-save/save-service.ts`) both need it, and
 * a `"use client"` module cannot import `lib/system/**` while `lib/system/**`
 * cannot import `features/**` — this is the one home both tiers can reach
 * without a bridge.
 */

/** Per-segment name cap — one path component (matches the skill-name max). */
export const SEGMENT_MAX_LEN = 64;
/** Full repo path cap — git checkout breaks past 255 bytes; stay well under. */
export const PATH_MAX_LEN = 180;

/**
 * True when a full repo path violates a length cap for a NEW file — any segment
 * over 64 chars or a total over 180. Shared by the client create surfaces and the
 * server save boundary so both reject the same over-long created paths (a >255
 * byte path breaks checkout on clone); edits to pre-existing long paths are never
 * length-checked.
 */
export function pathExceedsLengthLimits(path: string): boolean {
  if (path.length > PATH_MAX_LEN) return true;
  return path.split("/").some((seg) => seg.length > SEGMENT_MAX_LEN);
}
