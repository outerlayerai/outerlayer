/**
 * `getScoreCoverage` owns the admin client + ClickHouse seam construction
 * (the data-access-boundary gate requires `getAdminDataClient()` stay inside
 * `src/lib/system/**`) and delegates to `computeScoreCoverage` (tested in
 * coverage.test.ts). Pins only the skip-when-unconfigured branch and the
 * pass-through to computeScoreCoverage.
 */
import { describe, it, expect, vi } from "vitest";

const mockSweepChQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/pr-session-reconciler/ch-query", () => ({
  sweepChQuery: mockSweepChQuery,
}));

const mockComputeScoreCoverage = vi.hoisted(() => vi.fn());
vi.mock("../coverage", () => ({
  computeScoreCoverage: mockComputeScoreCoverage,
}));

import { getScoreCoverage } from "../service";

describe("getScoreCoverage", () => {
  it("skips when ClickHouse isn't configured", async () => {
    mockSweepChQuery.mockReturnValue(null);

    const result = await getScoreCoverage();

    expect(result).toEqual({ skipped: true });
    expect(mockComputeScoreCoverage).not.toHaveBeenCalled();
  });

  it("delegates to computeScoreCoverage with the admin client and chQuery when configured", async () => {
    const chQuery = vi.fn();
    mockSweepChQuery.mockReturnValue(chQuery);
    mockComputeScoreCoverage.mockResolvedValue({
      confirmedLinks: 1,
      covered: 1,
      missing: 0,
      missingSamples: [],
      truncated: false,
    });

    const result = await getScoreCoverage({ appId: "app-1" });

    expect(mockComputeScoreCoverage).toHaveBeenCalledWith(expect.anything(), chQuery, {
      appId: "app-1",
    });
    expect(result).toEqual({
      skipped: false,
      confirmedLinks: 1,
      covered: 1,
      missing: 0,
      missingSamples: [],
      truncated: false,
    });
  });
});
