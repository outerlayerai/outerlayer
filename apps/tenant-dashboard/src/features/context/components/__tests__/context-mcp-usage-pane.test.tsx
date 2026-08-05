// @vitest-environment jsdom
/**
 * Render tests for the mcp.json detail tabs (Content | Usage). Both adoption
 * reads load through context read actions (server seam) → vi.mock; the real SWR
 * hooks run. Covers the server table (never-used rows first), the per-server
 * expansion (tools + sessions, with "N tools used" never claiming a defined
 * count), and the outside-repo note for usage-only servers.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { McpDetailTabs } from "../context-mcp-usage-pane";

// The overlay + per-server drill-down read actions, over mutable state so the
// real hooks resolve their SWR keys from the same source across the expansion.
const { mcpState } = vi.hoisted(() => ({
  mcpState: {
    overlay: null as unknown as import("@/features/context/types").McpAdoptionResponse,
    detailByServer: {} as Record<string, import("@/features/context/types").McpDrilldownResponse>,
  },
}));
vi.mock("@/features/context/read-actions", () => ({
  getContextMcpAdoption: vi.fn(async () => ({ ok: true, data: mcpState.overlay })),
  getContextMcpDrilldown: vi.fn(async ({ server }: { server: string }) => ({
    ok: true,
    data:
      mcpState.detailByServer[server] ??
      { tools: [], trend: [], sessions: [], lookbackDays: 90, recentDays: 14 },
  })),
}));

vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

vi.mock("@/lib/app-shell/app-context", () => ({
  useAppContext: () => ({ app: { id: "app-1", require_pull_request: false } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgName: "acme", appName: "web" }),
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const chTimestamp = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");

// Installed roster: playwright (active) + dead-tools (never). "old-crm" has
// usage but is NOT installed here → outside-repo note.
const OVERLAY = {
  servers: [
    { serverName: "playwright", recentCalls: 40, totalCalls: 120, totalSessions: 15, lastUsedAt: chTimestamp(3 * HOUR) },
    { serverName: "old-crm", recentCalls: 0, totalCalls: 3, totalSessions: 2, lastUsedAt: chTimestamp(70 * DAY) },
  ],
  recentDays: 14,
  lookbackDays: 90,
};

const DETAIL = {
  tools: [
    { tool: "browser_click", recentCalls: 30, totalCalls: 90, sessions: 12, lastUsedAt: "2026-07-19 09:00:00" },
    { tool: "browser_drag", recentCalls: 0, totalCalls: 2, sessions: 1, lastUsedAt: "2026-06-01 09:00:00" },
  ],
  trend: [],
  sessions: [
    { traceId: "tr-1", title: "Fix flaky e2e", calls: 6, lastUsedAt: "2026-07-19 09:00:00" },
  ],
  lookbackDays: 90,
  recentDays: 14,
};

const renderTabs = (servers = ["playwright", "dead-tools"]) =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <McpDetailTabs servers={servers}>
        <div data-testid="content-probe">the editor</div>
      </McpDetailTabs>
    </SWRConfig>,
  );

const openUsage = () => fireEvent.click(screen.getByTestId("mcp-tab-usage"));

describe("McpDetailTabs", () => {
  beforeEach(() => {
    cleanup();
    mcpState.overlay = OVERLAY;
    mcpState.detailByServer = { playwright: DETAIL };
  });

  it("defaults to the Content tab (the editor pane rides through unchanged)", () => {
    renderTabs();
    expect(screen.getByTestId("content-probe")).toHaveTextContent("the editor");
    expect(screen.queryByTestId("mcp-usage-pane")).toBeNull();
  });

  it("the Usage tab tables the servers — never-used first — with calls, sessions, and last used", async () => {
    renderTabs();
    openUsage();
    await waitFor(() => expect(screen.getByTestId("mcp-usage-pane")).toBeInTheDocument());

    // Row order: the never-used server leads (it costs context every session).
    const rows = screen.getAllByTestId(/^mcp-server-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "mcp-server-row-dead-tools",
      "mcp-server-row-playwright",
    ]);
    expect(screen.getByTestId("mcp-last-used-never-dead-tools")).toHaveTextContent("never");
    expect(screen.getByTestId("mcp-last-used-playwright")).toHaveTextContent("3h ago");
    // Exact call/session figures from the overlay row.
    expect(screen.getByTestId("mcp-server-row-playwright")).toHaveTextContent("playwright3h ago12015");
    expect(screen.getByTestId("mcp-server-row-dead-tools")).toHaveTextContent("dead-toolsnever00");
    // Usage-only servers are flagged outside the repo, not merged into the table.
    expect(screen.getByText("Also used, configured outside this repo: old-crm")).toBeInTheDocument();
  });

  it("expanding a server shows its called tools ('N tools used', never a defined count) and sessions", async () => {
    renderTabs();
    openUsage();
    await waitFor(() => expect(screen.getByTestId("mcp-server-row-playwright")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("mcp-server-row-playwright"));
    await waitFor(() => expect(screen.getByTestId("mcp-server-detail-playwright")).toBeInTheDocument());

    const tools = screen.getAllByTestId("mcp-tool-row");
    expect(tools.map((el) => el.textContent)).toEqual(["browser_click", "browser_drag"]);
    // Only CALLED tools are countable — definitions live server-side, so the
    // copy must never claim to know how many tools exist.
    expect(screen.getByText("2 tools used · 1 gone quiet")).toBeInTheDocument();
    expect(screen.queryByText(/of \d+ tools/)).toBeNull();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/orgs/acme/apps/web/env/dev/agents/sessions/tr-1",
    );
  });

  it("expanding a never-used server shows the honest empty note, not fabricated data", async () => {
    renderTabs();
    openUsage();
    await waitFor(() => expect(screen.getByTestId("mcp-server-row-dead-tools")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("mcp-server-row-dead-tools"));
    await waitFor(() =>
      expect(screen.getByText("No tool calls recorded in the last 90 days.")).toBeInTheDocument(),
    );
  });
});
