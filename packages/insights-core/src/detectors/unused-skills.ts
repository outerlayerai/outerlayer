// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Finding } from "../types.js";

/**
 * Unused-skills — a repo-level hygiene finding, NOT a session detector. It
 * joins two facts no single session carries: which skills the repo installs
 * (its `skills/<name>/` directories) and which ones any session actually
 * activated in the window. A skill that ships but never fires is context the
 * agent loads on every run and never pays off — either its description doesn't
 * match how the work is phrased, or it shouldn't be installed.
 *
 * It lives outside the `Detector` registry because detectors are pure over
 * sessions; this is pure over (installed inventory, activated set). The caller
 * supplies both — the inventory from the context mirror, the activated set
 * from the same window the dashboard's adoption overlay uses, so the two
 * surfaces never disagree about what "unused" means.
 */

/** Cap the skills named in the summary; the rest fold into "+N more". */
const DEFAULT_MAX_LISTED = 6;

/**
 * Extract skill directory names from mirror tree paths. A skill lives at
 * `<scope>/skills/<name>/…`; we take the segment immediately after a `skills`
 * segment. Deduped, sorted, and blank-safe. Two same-named skills in different
 * scopes collapse to one name — adoption is keyed by name (the activation
 * event carries only the name), so the join stays consistent.
 */
export function skillNamesFromPaths(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const segs = path.split("/");
    const idx = segs.indexOf("skills");
    const name = idx >= 0 ? segs[idx + 1] : undefined;
    if (name) names.add(name);
  }
  return [...names].sort();
}

export interface UnusedSkillsInput {
  /** Skill names the repo installs (from the context mirror). */
  installedSkills: readonly string[];
  /** Skill names activated at least once in the window. */
  activatedSkillNames: ReadonlySet<string>;
  /** The activation window, in days — named in the copy so it's honest. */
  lookbackDays: number;
  /** Max skills named before the "+N more" fold. */
  maxListed?: number;
}

/**
 * The unused-skills finding, or null when every installed skill fired at least
 * once (nothing to report). `costUsd`/`timeMin` are null — the waste here is
 * maintenance and context bloat, not a billable figure, and inventing a dollar
 * number would be dishonest. `sessionIds` is empty: the finding is about the
 * repo, not any session.
 */
export function unusedSkillsFinding(input: UnusedSkillsInput): Finding | null {
  const maxListed = input.maxListed ?? DEFAULT_MAX_LISTED;
  const unused = input.installedSkills
    .filter((name) => !input.activatedSkillNames.has(name))
    .sort();
  if (unused.length === 0) return null;

  const shown = unused.slice(0, maxListed);
  const rest = unused.length - shown.length;
  const list = shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
  const noun = unused.length === 1 ? "skill" : "skills";

  return {
    detectorId: "unused-skill",
    severity: "warn",
    sessionIds: [],
    summary: `${unused.length} installed ${noun} never activated in ${input.lookbackDays} days: ${list}`,
    evidence: [],
    costUsd: null,
    timeMin: null,
    suggestion:
      "Remove or revise these skills — an installed skill the agent never triggers is context maintained but never applied. If a skill should be firing, its description likely doesn't match how the work is phrased.",
  };
}
