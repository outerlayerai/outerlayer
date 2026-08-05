/**
 * Trend-series shaping shared by the skill and MCP drill-down panels.
 *
 * A drill-down read returns only days with activity; a sparkline over that
 * sparse series would hide inactivity — a skill that fired hard 60 days ago
 * and went silent would draw as a healthy line. The series is therefore
 * zero-filled across the whole lookback window up to today, so the silent
 * tail is visible.
 */

/**
 * Daily counts zero-filled over the `lookbackDays` window ending at `today`
 * (a `YYYY-MM-DD` string, so callers/tests control "now" and the result is
 * timezone-stable). Trend days outside the window are dropped. Shared by the
 * skill and MCP drill-downs — anything with a `{day, value}` series.
 */
export function buildTrendSeries(
  trend: ReadonlyArray<{ day: string; value: number }>,
  lookbackDays: number,
  today: string,
): number[] {
  const byDay = new Map(trend.map((p) => [p.day, p.value]));
  const end = Date.parse(`${today}T00:00:00Z`);
  const series: number[] = [];
  for (let i = lookbackDays - 1; i >= 0; i -= 1) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    series.push(byDay.get(day) ?? 0);
  }
  return series;
}
