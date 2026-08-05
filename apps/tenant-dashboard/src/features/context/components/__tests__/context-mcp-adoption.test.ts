/**
 * Tests: pure MCP-adoption logic — per-server status thresholds and the
 * per-file roll-up. The honesty property under test: an unloaded overlay
 * yields NO summary (unknown ≠ never), and a loaded-but-empty usage map
 * marks installed servers "never".
 */
import {
  indexMcpUsage,
  mcpServerStatus,
  summarizeMcpAdoption,
  type McpServerUsage,
} from "../context-mcp-adoption";

const usage = (over: Partial<McpServerUsage>): McpServerUsage => ({
  serverName: "s",
  recentCalls: 0,
  totalCalls: 0,
  totalSessions: 0,
  lastUsedAt: null,
  ...over,
});

describe("mcpServerStatus", () => {
  it("splits never / quiet / active on the same thresholds as skills", () => {
    expect(mcpServerStatus(undefined)).toBe("never");
    expect(mcpServerStatus(usage({ totalCalls: 0 }))).toBe("never");
    expect(mcpServerStatus(usage({ totalCalls: 5, recentCalls: 0 }))).toBe("quiet");
    expect(mcpServerStatus(usage({ totalCalls: 5, recentCalls: 1 }))).toBe("active");
  });
});

describe("summarizeMcpAdoption", () => {
  const rows = indexMcpUsage([
    usage({ serverName: "live", recentCalls: 12, totalCalls: 40, lastUsedAt: "2026-07-19 09:00:00" }),
    usage({ serverName: "sleepy", recentCalls: 0, totalCalls: 3, lastUsedAt: "2026-05-02 08:00:00" }),
  ]);

  it("returns undefined while the overlay has not loaded (unknown ≠ never)", () => {
    expect(summarizeMcpAdoption(["live", "dead"], undefined)).toBeUndefined();
  });

  it("returns undefined for a file with no servers", () => {
    expect(summarizeMcpAdoption([], rows)).toBeUndefined();
  });

  it("counts never/quiet, sums active recent calls, and carries the most recent use", () => {
    expect(summarizeMcpAdoption(["live", "sleepy", "dead"], rows)).toEqual({
      total: 3,
      never: 1,
      quiet: 1,
      recentCalls: 12,
      lastUsedAt: "2026-07-19 09:00:00",
    });
  });

  it("all-active file reports zero never/quiet and the summed recent calls", () => {
    const all = indexMcpUsage([
      usage({ serverName: "a", recentCalls: 2, totalCalls: 2, lastUsedAt: "2026-07-10 12:00:00" }),
      usage({ serverName: "b", recentCalls: 3, totalCalls: 9, lastUsedAt: "2026-07-18 06:30:00" }),
    ]);
    expect(summarizeMcpAdoption(["a", "b"], all)).toEqual({
      total: 2,
      never: 0,
      quiet: 0,
      recentCalls: 5,
      lastUsedAt: "2026-07-18 06:30:00",
    });
  });

  it("an all-never file has no last-used time (nothing was ever called)", () => {
    expect(summarizeMcpAdoption(["dead", "deader"], indexMcpUsage([]))).toEqual({
      total: 2,
      never: 2,
      quiet: 0,
      recentCalls: 0,
      lastUsedAt: null,
    });
  });
});
