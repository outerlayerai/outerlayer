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
