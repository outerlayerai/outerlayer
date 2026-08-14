/**
 * readPrEmittedResults: the PR's emitted validator results, reduced to the
 * latest per name — a CI re-run supersedes its earlier report — scoped to
 * exactly one (tenant, repository, pr) anchor.
 */
import { describe, it, expect } from "vitest";

import { seedEmittedResultMswRows } from "@/test-helpers/msw-handlers";
import { readPrEmittedResults } from "../emitted-read";

const ANCHOR = { tenantId: "tenant-1", repository: "acme/app", prNumber: 812 };

function row(over: Partial<Parameters<typeof seedEmittedResultMswRows>[0][number]> = {}) {
  return {
    tenant_id: "tenant-1",
    repository: "acme/app",
    pr_number: 812,
    name: "smoke.pass",
    result: "pass",
    link: "https://ci.example/runs/1",
    provenance: "ci",
    ...over,
  };
}

describe("readPrEmittedResults", () => {
  it("returns the latest result per name with its link and provenance", async () => {
    seedEmittedResultMswRows([
      row({ id: "a", emitted_at: "2026-08-01T10:00:00.000Z", result: "fail", link: "https://ci.example/runs/1" }),
      row({ id: "b", emitted_at: "2026-08-01T11:00:00.000Z", result: "pass", link: "https://ci.example/runs/2" }),
      row({
        id: "c",
        name: "migration.executed",
        emitted_at: "2026-08-01T09:00:00.000Z",
        provenance: "local",
        link: "https://ci.example/runs/3",
      }),
    ]);
    const results = await readPrEmittedResults(ANCHOR);
    expect([...results.entries()].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
      [
        "migration.executed",
        {
          name: "migration.executed",
          result: "pass",
          link: "https://ci.example/runs/3",
          provenance: "local",
        },
      ],
      [
        "smoke.pass",
        { name: "smoke.pass", result: "pass", link: "https://ci.example/runs/2", provenance: "ci" },
      ],
    ]);
  });

  it("breaks an emitted_at tie by id so re-reads pick the same winner", async () => {
    seedEmittedResultMswRows([
      row({ id: "a", emitted_at: "2026-08-01T10:00:00.000Z", result: "fail" }),
      row({ id: "b", emitted_at: "2026-08-01T10:00:00.000Z", result: "pass" }),
    ]);
    const results = await readPrEmittedResults(ANCHOR);
    expect(results.get("smoke.pass")!.result).toBe("pass");
  });

  // proves AC-085-12
  it("reads only the named PR's anchor — other PRs and repos contribute nothing", async () => {
    seedEmittedResultMswRows([
      row({ id: "a" }),
      row({ id: "b", pr_number: 999, result: "fail" }),
      row({ id: "c", repository: "acme/other", result: "fail" }),
      row({ id: "d", tenant_id: "tenant-2", result: "fail" }),
    ]);
    const results = await readPrEmittedResults(ANCHOR);
    expect(results.size).toBe(1);
    expect(results.get("smoke.pass")!.result).toBe("pass");
  });

  it("returns an empty map when nothing was emitted", async () => {
    seedEmittedResultMswRows([]);
    expect((await readPrEmittedResults(ANCHOR)).size).toBe(0);
  });
});
