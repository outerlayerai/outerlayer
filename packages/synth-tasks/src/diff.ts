// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Unified-diff utilities specific to the inversion:
 *
 * - `invertUnifiedDiff` turns an injection diff (original → buggy) into its
 *   revert (buggy → original). The revert IS the task's `gold_patch`: applied
 *   to the injected `base_commit`, it restores the passing code.
 * - `noopTestPatch` builds the SENTINEL `test_patch`. The task schema requires a
 *   non-empty, parseable unified diff, so a literally-empty `test_patch` is
 *   NOT expressible — the sentinel is the honest, minimal stand-in: it creates
 *   one throwaway marker file, touches no test and no source, and changes no
 *   test outcome (the fail_to_pass tests already exist at base_commit).
 * - `changedLineCount` is what bounds how much an injection may change.
 *
 * Application is always `git apply` inside a sandbox; these functions never
 * mutate anything on disk.
 */

/** Marker content kept under 12 chars so the gate's leak grep never treats it as a
 * distinctive marker (see `leakMarkers` in @outerlayer/task-format). */
const SENTINEL_MARKER = "synthetic";

function invertHunkHeader(header: string): string {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
  if (!match) return header;
  const [, oldStart, oldLen, newStart, newLen, trailer] = match;
  const left = newLen !== undefined ? `${newStart},${newLen}` : `${newStart}`;
  const right = oldLen !== undefined ? `${oldStart},${oldLen}` : `${oldStart}`;
  return `@@ -${left} +${right} @@${trailer ?? ""}`;
}

/**
 * Invert a unified diff: swap the `---`/`+++` file paths, swap each hunk
 * header's old/new ranges, and flip every `+`/`-` body line. Within each
 * contiguous change block the flipped removals are emitted before the
 * additions, so the result is in canonical hunk order (removals first) and
 * applies cleanly with `git apply`. Context and "\ No newline" lines pass
 * through untouched. A `--- `/`+++ ` pair is only treated as a file header
 * when the two lines are adjacent, so `-`/`+` content lines that happen to
 * start with `--`/`++` are never mistaken for headers.
 */
export function invertUnifiedDiff(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  // Pending flipped lines for the current change block: an original `+` becomes
  // a removal, an original `-` becomes an addition. Removals flush first.
  let removals: string[] = [];
  let additions: string[] = [];
  const flush = () => {
    out.push(...removals, ...additions);
    removals = [];
    additions = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (line.startsWith("--- ") && next !== undefined && next.startsWith("+++ ")) {
      flush();
      out.push(`--- ${next.slice(4)}`);
      out.push(`+++ ${line.slice(4)}`);
      index += 1; // consumed the paired +++ line
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      out.push(invertHunkHeader(line));
      continue;
    }
    if (line.startsWith("+")) {
      removals.push(`-${line.slice(1)}`);
      continue;
    }
    if (line.startsWith("-")) {
      additions.push(`+${line.slice(1)}`);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * The sentinel no-op `test_patch`: a minimal new-file diff for a throwaway
 * marker. It satisfies the task schema (non-empty, parseable), never overlaps the
 * source-only `gold_patch`, and — because the fail_to_pass tests already exist
 * at `base_commit` — does not change any test outcome in the gate.
 */
export function noopTestPatch(taskId: string): string {
  const path = `.outerlayer/synthetic/${taskId}.noop`;
  return [
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,1 @@",
    `+${SENTINEL_MARKER}`,
  ].join("\n");
}

/** Count `+`/`-` body lines (excluding `+++`/`---` file headers). */
export function changedLineCount(patch: string): number {
  let count = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) count += 1;
  }
  return count;
}
