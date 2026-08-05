/**
 * Pure logic for the getting-started checklist. Kept free of React so the
 * endowed-progress rule (step 1 is always complete) and the progress maths can
 * be unit-tested directly.
 */

export type ChecklistStatus = {
  hasApiKey: boolean;
  hasTrace: boolean;
  hasTeammate: boolean;
  /** GitHub App installed. */
  hasGitConnection: boolean;
  /** A repository/branch is actually linked — the onboarding v2 gate. */
  hasRepoLinked: boolean;
};

/**
 * What the setup surfaces (panel gate + soft banner) need beyond the boolean
 * checklist: which provider is connected (drives copy + the link-repo CTA).
 */
export type OnboardingSetupState = ChecklistStatus & {
  provider: string | null;
};

export type ChecklistStepId = "app" | "repo" | "apiKey" | "trace" | "teammate";

/**
 * Turn the raw counts the checklist endpoint gathers into the boolean status.
 * Pure (and unit-tested) so the boundary conditions are pinned: a key/trace
 * count true at >= 1, but a *teammate* only at >= 2 members — the creator is
 * always a member, so a count of 1 is not a teammate.
 *
 * Git semantics mirror `templates/layout.tsx`: a GitHub connection is real
 * once it has an `installation_id`. A linked repo requires BOTH a live
 * connection and a `git_branch` row — a stale branch row left behind by an
 * unlinked connection must not satisfy the gate.
 */
export function interpretChecklistCounts(input: {
  traceTotal: number;
  apiKeyCount: number;
  memberCount: number;
  gitProvider: string | null;
  gitInstallationId: string | null;
  gitBranchCount: number;
}): ChecklistStatus {
  const hasGitConnection = Boolean(input.gitInstallationId);
  return {
    hasApiKey: input.apiKeyCount > 0,
    hasTrace: input.traceTotal > 0,
    hasTeammate: input.memberCount > 1,
    hasGitConnection,
    hasRepoLinked: hasGitConnection && input.gitBranchCount > 0,
  };
}

type ChecklistStep = {
  id: ChecklistStepId;
  done: boolean;
  /** Deep-link for the step's CTA. Omitted for steps with no action (app). */
  href?: string;
};

type ChecklistLinks = {
  repo: string;
  apiKeys: string;
  traces: string;
  members: string;
};

/**
 * Build the ordered checklist. "Create your first app" is always complete —
 * you can only reach this UI from inside an app — which seeds the endowed
 * progress effect (a checklist that starts at 1/5 converts better than 0/5).
 * "Link your repo" sits directly after it: it is the soft gate of onboarding
 * v2, so it leads the remaining steps in the same order the setup card uses.
 */
export function buildChecklistSteps(
  status: ChecklistStatus,
  links: ChecklistLinks,
): ChecklistStep[] {
  return [
    { id: "app", done: true },
    { id: "repo", done: status.hasRepoLinked, href: links.repo },
    { id: "apiKey", done: status.hasApiKey, href: links.apiKeys },
    { id: "trace", done: status.hasTrace, href: links.traces },
    { id: "teammate", done: status.hasTeammate, href: links.members },
  ];
}

type ChecklistProgress = {
  done: number;
  total: number;
  percent: number;
  complete: boolean;
};

export function checklistProgress(steps: ChecklistStep[]): ChecklistProgress {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    complete: done === total,
  };
}
