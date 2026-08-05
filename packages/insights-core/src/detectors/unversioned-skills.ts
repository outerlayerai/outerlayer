// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Finding } from "../types.js";

/**
 * Unversioned-skills — the mirror image of unused-skills. Where that flags
 * installed context nothing uses, this flags heavily-used context the repo
 * DOESN'T install: skills a team leans on that live only in a developer's
 * personal `~/.claude/skills/` or a plugin, never versioned or shared. That's
 * invisible context — it breaks for any teammate who lacks it, ships no
 * review, and drifts per machine. The fix is to promote it into the repo.
 *
 * "Used but not installed" is fully knowable (every activation is captured
 * regardless of source), so unlike unused-skills this needs no complete
 * inventory of the outside world — just the repo's, to subtract.
 */

/** A skill activated in the window, with the counts the promote signal ranks by. */
export interface ActivatedSkillUse {
  skillName: string;
  totalActivations: number;
  totalSessions: number;
}

/** Sessions a skill must appear in before it counts as team reliance, not a one-off. */
const DEFAULT_MIN_SESSIONS = 5;
/** Cap the named list; the rest fold into "+N more". */
const DEFAULT_MAX_LISTED = 5;

export interface UnversionedSkillsInput {
  /** Skill names the repo installs (the set we subtract). */
  installedSkills: readonly string[];
  /** Skills activated in the window, with counts. */
  activatedSkills: readonly ActivatedSkillUse[];
  /** The activation window, in days — named in the copy so it's honest. */
  lookbackDays: number;
  /** Session floor below which reliance is too thin to flag. */
  minSessions?: number;
  /** Max skills named before the "+N more" fold. */
  maxListed?: number;
}

/**
 * The unversioned-skills finding, or null when nothing outside the repo clears
 * the reliance floor. Ranked by sessions (breadth of reliance) then name.
 * `costUsd`/`timeMin` null and `sessionIds` empty — a repo-level opportunity,
 * not a billable waste or a session.
 */
export function unversionedSkillsFinding(input: UnversionedSkillsInput): Finding | null {
  const installed = new Set(input.installedSkills);
  const minSessions = input.minSessions ?? DEFAULT_MIN_SESSIONS;
  const maxListed = input.maxListed ?? DEFAULT_MAX_LISTED;

  const candidates = input.activatedSkills
    .filter((s) => !installed.has(s.skillName) && s.totalSessions >= minSessions)
    .sort((a, b) => b.totalSessions - a.totalSessions || a.skillName.localeCompare(b.skillName));
  if (candidates.length === 0) return null;

  const shown = candidates.slice(0, maxListed);
  const rest = candidates.length - shown.length;
  const list =
    shown
      .map((s) => `${s.skillName} (${s.totalSessions} session${s.totalSessions === 1 ? "" : "s"})`)
      .join(", ") + (rest > 0 ? `, +${rest} more` : "");
  const noun = candidates.length === 1 ? "skill" : "skills";

  return {
    detectorId: "unversioned-skill",
    severity: "warn",
    sessionIds: [],
    summary: `${candidates.length} ${noun} your sessions rely on ${candidates.length === 1 ? "isn't" : "aren't"} in the repo: ${list}`,
    evidence: [],
    costUsd: null,
    timeMin: null,
    suggestion:
      "Add these to the repo's skills so every session — and every teammate — gets them, versioned and reviewed. A heavily-used skill living only in a developer's ~/.claude or a plugin is context that silently breaks for anyone who lacks it.",
  };
}
