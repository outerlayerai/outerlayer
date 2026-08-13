import { describe, it, expect } from "vitest";
import {
  buildChecklistSteps,
  checklistProgress,
  interpretChecklistCounts,
  type ChecklistStatus,
} from "./checklist";

const LINKS = { repo: "/r", apiKeys: "/k", traces: "/t", members: "/m" };
const NONE: ChecklistStatus = {
  hasApiKey: false,
  hasTrace: false,
  hasTeammate: false,
  hasGitConnection: false,
  hasRepoLinked: false,
};
const ALL: ChecklistStatus = {
  hasApiKey: true,
  hasTrace: true,
  hasTeammate: true,
  hasGitConnection: true,
  hasRepoLinked: true,
};

/** Zeroed signal input — spread and override per case. */
const NO_COUNTS = {
  traceTotal: 0,
  apiKeyCount: 0,
  memberCount: 0,
  gitProvider: null,
  gitInstallationId: null,
  gitBranchCount: 0,
};

describe("buildChecklistSteps", () => {
  // proves AC-064-08
  it("always marks 'create app' done (endowed progress) even with no other progress", () => {
    const steps = buildChecklistSteps(NONE, LINKS);
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ["app", true],
      ["repo", false],
      ["apiKey", false],
      ["trace", false],
      ["teammate", false],
    ]);
  });

  it("maps each status flag to the matching step and attaches its deep-link", () => {
    const steps = buildChecklistSteps(
      { ...NONE, hasApiKey: true, hasTeammate: true, hasRepoLinked: true },
      LINKS,
    );
    expect(steps.find((s) => s.id === "repo")).toEqual({ id: "repo", done: true, href: "/r" });
    expect(steps.find((s) => s.id === "apiKey")).toEqual({ id: "apiKey", done: true, href: "/k" });
    expect(steps.find((s) => s.id === "trace")).toEqual({ id: "trace", done: false, href: "/t" });
    expect(steps.find((s) => s.id === "teammate")).toEqual({ id: "teammate", done: true, href: "/m" });
  });

  it("the repo step tracks hasRepoLinked, not hasGitConnection (OAuth alone is not done)", () => {
    const steps = buildChecklistSteps(
      { ...NONE, hasGitConnection: true, hasRepoLinked: false },
      LINKS,
    );
    expect(steps.find((s) => s.id === "repo")).toEqual({ id: "repo", done: false, href: "/r" });
  });

  it("gives the app step no CTA link (nothing to do)", () => {
    const first = buildChecklistSteps(NONE, LINKS)[0];
    expect(first?.id).toBe("app");
    expect(first?.href).toBeUndefined();
  });
});

describe("interpretChecklistCounts", () => {
  it("treats all-zero counts as nothing done", () => {
    expect(interpretChecklistCounts(NO_COUNTS)).toEqual(NONE);
  });

  it("flips key and trace true at the first one", () => {
    expect(
      interpretChecklistCounts({ ...NO_COUNTS, traceTotal: 1, apiKeyCount: 1, memberCount: 1 }),
    ).toEqual({ ...NONE, hasApiKey: true, hasTrace: true });
  });

  // proves AC-064-09
  it("a single member is the creator, not a teammate (boundary at 2)", () => {
    expect(
      interpretChecklistCounts({ ...NO_COUNTS, memberCount: 1 }).hasTeammate,
    ).toBe(false);
    expect(
      interpretChecklistCounts({ ...NO_COUNTS, memberCount: 2 }).hasTeammate,
    ).toBe(true);
  });

  it("a GitHub connection requires an installation_id; a bare row is not connected", () => {
    expect(
      interpretChecklistCounts({ ...NO_COUNTS, gitProvider: "github" }),
    ).toEqual(NONE);
    expect(
      interpretChecklistCounts({
        ...NO_COUNTS,
        gitProvider: "github",
        gitInstallationId: "inst-1",
      }),
    ).toEqual({ ...NONE, hasGitConnection: true });
  });

  // proves AC-064-10
  it("hasRepoLinked needs BOTH a connection and a branch — a stale branch row alone never satisfies the gate", () => {
    // Branch row left behind, no live connection: NOT linked.
    expect(
      interpretChecklistCounts({ ...NO_COUNTS, gitBranchCount: 1 }),
    ).toEqual(NONE);
    // Connection but no branch picked yet: connected, not linked.
    expect(
      interpretChecklistCounts({
        ...NO_COUNTS,
        gitProvider: "github",
        gitInstallationId: "inst-1",
      }).hasRepoLinked,
    ).toBe(false);
    // Both: linked.
    expect(
      interpretChecklistCounts({
        ...NO_COUNTS,
        gitProvider: "github",
        gitInstallationId: "inst-1",
        gitBranchCount: 1,
      }),
    ).toEqual({ ...NONE, hasGitConnection: true, hasRepoLinked: true });
  });
});

describe("checklistProgress", () => {
  it("counts a fresh app as 1 of 5 (20%), not zero", () => {
    expect(checklistProgress(buildChecklistSteps(NONE, LINKS))).toEqual({
      done: 1,
      total: 5,
      percent: 20,
      complete: false,
    });
  });

  it("reports complete only when every step is done", () => {
    const all = buildChecklistSteps(ALL, LINKS);
    expect(checklistProgress(all)).toEqual({ done: 5, total: 5, percent: 100, complete: true });
  });

  it("rounds the percentage (4 of 5 → 80%)", () => {
    const four = buildChecklistSteps({ ...ALL, hasTeammate: false }, LINKS);
    expect(checklistProgress(four).percent).toBe(80);
  });
});
