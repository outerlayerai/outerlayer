/**
 * Tests: trend-series shaping for the skill drill-down sparkline. The honesty
 * property under test: days without activity render as zeros, so a skill that
 * went silent shows a silent tail instead of a line interpolated across the
 * gap.
 */
import { buildTrendSeries } from "../context-skill-drilldown";

describe("buildTrendSeries", () => {
  it("zero-fills the full window ending today, in day order", () => {
    const series = buildTrendSeries(
      [
        { day: "2026-07-18", value: 3 },
        { day: "2026-07-20", value: 1 },
      ],
      5,
      "2026-07-20",
    );
    // 2026-07-16 … 2026-07-20 — the gap days are zeros, not interpolated.
    expect(series).toEqual([0, 0, 3, 0, 1]);
  });

  it("drops trend days outside the window instead of shifting the axis", () => {
    const series = buildTrendSeries(
      [
        { day: "2026-07-01", value: 9 },
        { day: "2026-07-20", value: 2 },
      ],
      3,
      "2026-07-20",
    );
    expect(series).toEqual([0, 0, 2]);
  });

  it("an empty trend is all zeros across the window", () => {
    expect(buildTrendSeries([], 4, "2026-07-20")).toEqual([0, 0, 0, 0]);
  });
});
