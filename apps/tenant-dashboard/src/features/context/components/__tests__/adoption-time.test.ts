/**
 * Tests: relative-time bucketing for the last-used annotations. The unit
 * boundaries (59m→1h, 23h→1d) are the behavior — a wrong floor/ceil reads a
 * fresh skill as stale or vice versa.
 */
import { parseAdoptionTimestamp, relativeTimeParts } from "../adoption-time";

const NOW = Date.parse("2026-07-21T12:00:00Z");
const at = (iso: string) => iso.replace("T", " ").replace("Z", "");

describe("parseAdoptionTimestamp", () => {
  it("parses ClickHouse strings as UTC and rejects garbage", () => {
    expect(parseAdoptionTimestamp("2026-07-21 12:00:00")).toBe(NOW);
    expect(parseAdoptionTimestamp(null)).toBeNull();
    expect(parseAdoptionTimestamp("not a date")).toBeNull();
  });
});

describe("relativeTimeParts", () => {
  it("buckets each unit with exact boundary behavior", () => {
    // Sub-minute (and future clock-skew) → "now".
    expect(relativeTimeParts(at("2026-07-21T11:59:30Z"), NOW)).toEqual({ unit: "now", count: 0 });
    expect(relativeTimeParts(at("2026-07-21T12:05:00Z"), NOW)).toEqual({ unit: "now", count: 0 });
    // Minutes up to 59; the 60th minute tips into hours.
    expect(relativeTimeParts(at("2026-07-21T11:55:00Z"), NOW)).toEqual({ unit: "minutes", count: 5 });
    expect(relativeTimeParts(at("2026-07-21T11:01:00Z"), NOW)).toEqual({ unit: "minutes", count: 59 });
    expect(relativeTimeParts(at("2026-07-21T11:00:00Z"), NOW)).toEqual({ unit: "hours", count: 1 });
    // Hours up to 23; the 24th tips into days.
    expect(relativeTimeParts(at("2026-07-20T13:00:00Z"), NOW)).toEqual({ unit: "hours", count: 23 });
    expect(relativeTimeParts(at("2026-07-20T12:00:00Z"), NOW)).toEqual({ unit: "days", count: 1 });
    expect(relativeTimeParts(at("2026-06-06T12:00:00Z"), NOW)).toEqual({ unit: "days", count: 45 });
  });

  it("returns null for absent or unparseable timestamps (render nothing, not a fake time)", () => {
    expect(relativeTimeParts(null, NOW)).toBeNull();
    expect(relativeTimeParts("garbage", NOW)).toBeNull();
  });
});
