/**
 * Skill adoption for the context tree — the usage overlay on top of the
 * mirrored `.outerlayer/skills/` inventory. The tree is the installed list;
 * this fills in whether each skill actually fires in sessions.
 *
 * The whole point is the `never` verdict: a skill the repo ships that no
 * session activates is context debt sitting one click from where you'd
 * delete it. Activation counts come from ClickHouse (skill_activated events),
 * keyed by skill NAME only — the event doesn't carry which scope's copy fired,
 * so in a monorepo two same-named skills share one activation figure.
 */

/** Per-skill activation counts — the skill-adoption overlay rows. */
export interface SkillActivation {
  skillName: string;
  /** Activations inside the recent window (the "is it live" signal). */
  recentActivations: number;
  /** Activations across the whole lookback window. */
  totalActivations: number;
  /** Distinct sessions that activated the skill in the lookback window. */
  totalSessions: number;
  lastActivatedAt: string | null;
}

type SkillAdoptionStatus = "active" | "quiet" | "never";

export interface SkillAdoptionInfo {
  status: SkillAdoptionStatus;
  recentActivations: number;
  totalActivations: number;
  lastActivatedAt: string | null;
}

/**
 * Adoption status for one installed skill given its activation row.
 * `undefined` = the skill dir exists in the mirror but nothing activated it in
 * the lookback window → `never`. A present row with zero recent activations is
 * `quiet` (fired earlier in the window, gone silent); any recent → `active`.
 */
export function skillAdoptionInfo(
  activation: SkillActivation | undefined,
): SkillAdoptionInfo {
  if (!activation) {
    return { status: "never", recentActivations: 0, totalActivations: 0, lastActivatedAt: null };
  }
  return {
    status: activation.recentActivations > 0 ? "active" : "quiet",
    recentActivations: activation.recentActivations,
    totalActivations: activation.totalActivations,
    lastActivatedAt: activation.lastActivatedAt,
  };
}

/** Index activation rows by skill name for O(1) lookup while building the tree. */
export function indexSkillActivations(
  skills: readonly SkillActivation[],
): Map<string, SkillActivation> {
  return new Map(skills.map((s) => [s.skillName, s]));
}
