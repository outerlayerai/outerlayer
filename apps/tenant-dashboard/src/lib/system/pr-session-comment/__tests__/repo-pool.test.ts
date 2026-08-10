/**
 * `refreshEachByRepo`'s whole job is per-repository serialization under a
 * shared concurrency cap — these tests prove the lane KEY, which is the part
 * a well-intentioned edit is most likely to quietly break.
 */
import { describe, it, expect } from "vitest";
import { refreshEachByRepo } from "../repo-pool";

/** Runs `targets` through `refreshEachByRepo`, tracking the maximum number
 * of `run` calls in flight at once — the observable signature of two
 * targets sharing (or not sharing) a lane. */
async function trackConcurrency(targets: { tenantId: string; repository: string }[]) {
  let active = 0;
  let maxActive = 0;
  await refreshEachByRepo(targets, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  return maxActive;
}

describe("refreshEachByRepo result alignment", () => {
  it("aligns every result to its target BY INDEX, across repos and within one repo's serial run", async () => {
    const targets = [
      { tenantId: "tenant-1", repository: "acme/api", prNumber: 1 },
      { tenantId: "tenant-1", repository: "acme/web", prNumber: 2 },
      { tenantId: "tenant-1", repository: "acme/api", prNumber: 3 },
    ];

    const results = await refreshEachByRepo(targets, async (t) => `result-${t.prNumber}`);

    expect(results).toEqual(["result-1", "result-2", "result-3"]);
  });

  it("returns exactly one result per target, even for a large target list", async () => {
    const targets = Array.from({ length: 25 }, (_, i) => ({
      tenantId: "tenant-1",
      repository: `acme/repo-${i % 5}`,
      prNumber: i,
    }));

    const results = await refreshEachByRepo(targets, async (t) => t.prNumber);

    expect(results).toHaveLength(25);
    expect(results).toEqual(targets.map((t) => t.prNumber));
  });
});

describe("refreshEachByRepo concurrency cap", () => {
  it("never runs more lanes than the concurrency cap, even with many more repos than the cap", async () => {
    const targets = Array.from({ length: 10 }, (_, i) => ({
      tenantId: "tenant-1",
      repository: `acme/repo-${i}`, // 10 distinct repos → 10 candidate lanes
    }));
    let active = 0;
    let maxActive = 0;

    await refreshEachByRepo(
      targets,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
      3, // explicit cap, well below the 10 available lanes
    );

    expect(maxActive).toBe(3);
  });

  it("runs at most as many lanes as there are repos when the cap exceeds the repo count", async () => {
    const targets = [
      { tenantId: "tenant-1", repository: "acme/api" },
      { tenantId: "tenant-1", repository: "acme/web" },
    ];
    let active = 0;
    let maxActive = 0;

    await refreshEachByRepo(
      targets,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
      10, // cap far above the 2 available lanes
    );

    expect(maxActive).toBe(2);
  });
});

describe("refreshEachByRepo repository keying", () => {
  it("serializes two spellings of the same repo into one lane", async () => {
    const maxActive = await trackConcurrency([
      { tenantId: "tenant-1", repository: "acme/api" },
      { tenantId: "tenant-1", repository: "https://github.com/Acme/API.git" },
    ]);
    expect(maxActive).toBe(1);
  });

  it("runs distinct repositories in separate, concurrent lanes", async () => {
    const maxActive = await trackConcurrency([
      { tenantId: "tenant-1", repository: "acme/api" },
      { tenantId: "tenant-1", repository: "acme/web" },
    ]);
    expect(maxActive).toBe(2);
  });

  it("keeps two tenants' identically-spelled repos in separate lanes", async () => {
    const maxActive = await trackConcurrency([
      { tenantId: "tenant-1", repository: "acme/api" },
      { tenantId: "tenant-2", repository: "acme/api" },
    ]);
    expect(maxActive).toBe(2);
  });
});
