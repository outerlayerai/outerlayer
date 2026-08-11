// @vitest-environment jsdom
/**
 * The Context Overview — the surface's default landing view. Rendered through
 * the full <ContextView> shell so the URL contract (bare-URL default,
 * `file=` back-compat, `range`/`skill`/`server` params) is proven at the
 * seam the browser actually exercises. The read actions are the mocked
 * server seam; the real SWR hooks and view model run.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type {
  ContextOverviewResponse,
  ContextTreeResponse,
  OverviewSkillRow,
} from "../../types";

vi.mock("@outerlayer/locales", async () => {
  const { realLocalesModule } = await import("@/test-helpers/real-i18n");
  return realLocalesModule();
});

// The global @/theme mock omits bgBlur; the range chip's CustomPopover arrow
// calls it. Re-add it as a no-op style helper so the real popover renders.
vi.mock("@/theme", () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => children,
  ThemeProvider: ({ children }: { children?: React.ReactNode }) => children,
  bgBlur: () => ({}),
}));

vi.mock("@/lib/app-shell/app-context", () => ({
  useAppContext: () => ({ app: { id: "app-1", require_pull_request: false } }),
}));

vi.mock("@/auth/hooks/use-app-permissions", () => ({
  useAppPermissions: () => ({ permissions: [], isLoading: false, hasPermission: () => true }),
}));

vi.mock("@/features/context/action-adapters", () => ({
  readRemoteContextFileAction: vi.fn(async () => ({ data: null })),
  resyncContextAction: vi.fn(async () => ({ data: { kind: "synced" } })),
  commitContextChangesAction: vi.fn(),
  checkPendingPullRequestsAction: vi.fn(async () => ({ data: { decided: [] } })),
}));

vi.mock("../editor", () => ({
  useUnsavedChangesGuard: () => {},
  ContextEditor: (props: { file: { path: string } }) => (
    <div data-testid="editor-probe" data-path={props.file.path} />
  ),
  PublishDialog: () => null,
  CreateFilePopover: () => null,
  DeleteContextDialog: () => null,
}));

const { ctxState } = vi.hoisted(() => ({
  ctxState: {
    tree: null as unknown as import("../../types").ContextTreeResponse,
    overview: null as unknown as import("../../types").ContextOverviewResponse,
  },
}));

vi.mock("@/features/context/read-actions", () => ({
  getContextTree: vi.fn(async () => ({ ok: true, data: ctxState.tree })),
  getContextFile: vi.fn(async () => {
    throw new Error("context file not found");
  }),
  getContextOverview: vi.fn(async ({ range }: { appId: string; range: string }) => ({
    ok: true,
    data: { ...ctxState.overview, range },
  })),
  getContextSkillDrilldown: vi.fn(async () => ({
    ok: true,
    data: {
      trend: [{ day: "2026-08-09", activations: 4, sessions: 2 }],
      sessions: [
        { traceId: "trace-1", title: "Backfill tenant ids", activations: 3, lastActivatedAt: "2026-08-09 10:00:00" },
      ],
      topics: [{ topicId: "topic-1", name: "Migrations", sessions: 5 }],
      lookbackDays: 90,
    },
  })),
  getContextMcpDrilldown: vi.fn(async () => ({
    ok: true,
    data: { tools: [], trend: [], sessions: [], lookbackDays: 90, recentDays: 14 },
  })),
}));

import { ContextView } from "../context-view";
import { getContextOverview } from "../../read-actions";

const TREE: ContextTreeResponse = {
  gitConnection: { repository: "acme/app", branch: "main" },
  head: { commitSha: "head-sha", snapshotId: "snap-1", syncedAt: "2026-07-10T00:00:00Z" },
  entries: [
    { path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" },
    { path: ".outerlayer/skills/alpha/SKILL.md", kind: "skill", scopePath: "", skillName: "alpha", blobSha: "b2" },
    { path: ".outerlayer/skills/dormant/SKILL.md", kind: "skill", scopePath: "", skillName: "dormant", blobSha: "b3" },
  ],
  excludedCounts: [],
  issues: [],
  mcpServerCounts: [{ path: ".outerlayer/mcp.json", count: 1, servers: ["github"] }],
};

function skillRow(overrides: Partial<OverviewSkillRow> & { skillName: string }): OverviewSkillRow {
  return {
    scopePath: "",
    inRepo: true,
    activations: 0,
    priorActivations: 0,
    sessions: 0,
    recentActivations: 0,
    lookbackActivations: 0,
    lastActivatedAt: null,
    trend: [],
    issues: [],
    ...overrides,
  };
}

/** A healthy two-skill overview: one active, one never-used, one MCP server. */
function makeOverview(): ContextOverviewResponse {
  return {
    range: "30d",
    recentDays: 14,
    lookbackDays: 90,
    degraded: false,
    skills: [
      skillRow({
        skillName: "alpha",
        activations: 40,
        priorActivations: 20,
        sessions: 10,
        recentActivations: 5,
        lookbackActivations: 60,
        lastActivatedAt: "2026-08-09 10:00:00",
        trend: [{ day: "2026-08-09", activations: 4 }],
      }),
      skillRow({ skillName: "dormant" }),
    ],
    mcpServers: [
      {
        serverName: "github",
        configPath: ".outerlayer/mcp.json",
        inRepo: true,
        calls: 120,
        priorCalls: 100,
        sessions: 30,
        recentCalls: 12,
        lookbackCalls: 300,
        toolsUsed: 6,
        lastUsedAt: "2026-08-09 09:00:00",
      },
    ],
    coverage: {
      sessions: 50,
      sessionsWithSkill: 34,
      priorSessions: 40,
      priorSessionsWithSkill: 22,
      lookbackSessions: 120,
    },
    topics: [{ topicId: "topic-1", name: "Migrations", sessions: 12 }],
    inventory: { instructionScopes: 1, commands: 2, subagents: 0 },
  };
}

let currentParams: Record<string, string> = {};
function setSearch(params: Record<string, string>) {
  currentParams = params;
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(params) as never);
}

const replaceSpy = vi.fn();

function renderView(overview: ContextOverviewResponse | null = null) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ContextView
        appId="app-1"
        initialTree={ctxState.tree}
        initialFile={null}
        initialSelectedPath={currentParams.file ?? null}
        initialOverview={overview}
      />
    </SWRConfig>,
  );
}

beforeEach(() => {
  replaceSpy.mockClear();
  vi.mocked(getContextOverview).mockClear();
  ctxState.tree = TREE;
  ctxState.overview = makeOverview();
  vi.mocked(useParams).mockReturnValue({ orgName: "org-1", appName: "app-one" } as never);
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: replaceSpy,
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  } as never);
  setSearch({});
});

describe("<ContextView> — Overview landing and rollup", () => {
  // AC-058-01
  it("a bare URL lands on the Overview: status counts, coverage, and activations at zero clicks", async () => {
    renderView(makeOverview());
    expect(await screen.findByTestId("context-overview")).toBeInTheDocument();

    const tiles = screen.getByTestId("overview-stat-row");
    // Skills: 2 in repo, split 1 active · 0 quiet · 1 never.
    expect(tiles).toHaveTextContent("1 active · 0 quiet · 1 never");
    // Coverage: 34 of 50 sessions → 68%, with a percentage-point delta
    // against the prior window (55% → +13pp).
    expect(tiles).toHaveTextContent("68%");
    expect(tiles).toHaveTextContent("▲ +13.0pp");
    // Activations: 40 vs prior 20 → +100%.
    expect(tiles).toHaveTextContent("40");
    expect(tiles).toHaveTextContent("▲ +100.0%");
    // Both tables render without any interaction.
    expect(within(screen.getByTestId("overview-table-skill")).getByText("alpha")).toBeInTheDocument();
    expect(within(screen.getByTestId("overview-table-mcp")).getByText("github")).toBeInTheDocument();
  });

  // AC-058-02
  it("changing the range writes ?range= and re-reads the window through the action", async () => {
    renderView(makeOverview());
    await screen.findByTestId("context-overview");

    fireEvent.click(screen.getByTestId("overview-range-chip"));
    fireEvent.click(screen.getByTestId("overview-range-7d"));
    expect(replaceSpy).toHaveBeenCalledWith("/test-path?range=7d", { scroll: false });

    // The URL param drives the fetch key: rendering at range=7d re-reads
    // that window (the seed carries only the landing range).
    setSearch({ range: "7d" });
    renderView(makeOverview());
    await waitFor(() =>
      expect(vi.mocked(getContextOverview)).toHaveBeenCalledWith({ appId: "app-1", range: "7d" }),
    );
  });

  // AC-058-03
  it("more than 8 skills → top 8 with an inline expander, and no pagination control", async () => {
    const overview = makeOverview();
    overview.skills = Array.from({ length: 11 }, (_, i) =>
      skillRow({
        skillName: `skill-${String(i).padStart(2, "0")}`,
        activations: 100 - i,
        lookbackActivations: 100,
        recentActivations: 1,
        lastActivatedAt: "2026-08-09 10:00:00",
      }),
    );
    renderView(overview);
    const table = await screen.findByTestId("overview-table-skill");

    expect(within(table).getByText("skill-00")).toBeInTheDocument();
    expect(within(table).getByText("skill-07")).toBeInTheDocument();
    expect(within(table).queryByText("skill-08")).toBeNull();

    fireEvent.click(screen.getByTestId("overview-skill-expander"));
    expect(within(table).getByText("skill-10")).toBeInTheDocument();
    // No pager anywhere — a rollup is never paginated.
    expect(screen.queryByRole("button", { name: /next page/i })).toBeNull();
  });
});

describe("<ContextView> — Overview status integrity", () => {
  // AC-058-04
  it("a zero-activation repo skill shows `never` and lands in needs-attention with a file link", async () => {
    renderView(makeOverview());
    const table = await screen.findByTestId("overview-table-skill");

    const dormantRow = within(table).getByTestId("overview-skill-row-dormant");
    expect(within(dormantRow).getByTestId("overview-status-never")).toBeInTheDocument();

    const rail = screen.getByTestId("overview-attention-rail");
    expect(within(rail).getByText("dormant")).toBeInTheDocument();
    fireEvent.click(within(rail).getByTestId("overview-attention-open-dormant"));
    expect(replaceSpy).toHaveBeenCalledWith(
      "/test-path?view=files&file=.outerlayer%2Fskills%2Fdormant%2FSKILL.md",
      { scroll: false },
    );
  });

  // AC-058-05
  it("zero sessions in the lookback → no never verdicts, no prior data, first-run banner", async () => {
    const overview = makeOverview();
    overview.skills = [skillRow({ skillName: "alpha" }), skillRow({ skillName: "dormant" })];
    overview.mcpServers = [];
    overview.coverage = {
      sessions: 0,
      sessionsWithSkill: 0,
      priorSessions: 0,
      priorSessionsWithSkill: 0,
      lookbackSessions: 0,
    };
    overview.topics = [];
    renderView(overview);

    expect(await screen.findByTestId("overview-first-run-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-status-never")).toBeNull();
    expect(screen.queryByTestId("overview-last-used-never")).toBeNull();
    expect(screen.getAllByText("▪ no prior data").length).toBeGreaterThan(0);
    // The attention rail carries no dead-weight verdicts — zero reads as young.
    expect(screen.getByText("Nothing needs attention.")).toBeInTheDocument();
  });

  // AC-058-06
  it("usage for a skill no longer in the repo is marked removed and excluded from the counts", async () => {
    const overview = makeOverview();
    overview.skills.push(
      skillRow({
        skillName: "ghost",
        scopePath: null,
        inRepo: false,
        activations: 7,
        lookbackActivations: 9,
        recentActivations: 1,
        lastActivatedAt: "2026-08-08 10:00:00",
      }),
    );
    renderView(overview);
    const table = await screen.findByTestId("overview-table-skill");

    const ghostRow = within(table).getByTestId("overview-skill-row-ghost");
    expect(within(ghostRow).getByTestId("overview-removed-chip")).toBeInTheDocument();
    // The tile caption still counts only the two in-repo skills.
    expect(screen.getByTestId("overview-stat-row")).toHaveTextContent("1 active · 0 quiet · 1 never");
  });

  // AC-058-07
  it("an empty prior window renders `no prior data`, never a fabricated percentage", async () => {
    const overview = makeOverview();
    overview.skills = [
      skillRow({
        skillName: "alpha",
        activations: 40,
        priorActivations: 0,
        recentActivations: 5,
        lookbackActivations: 60,
        lastActivatedAt: "2026-08-09 10:00:00",
      }),
      skillRow({ skillName: "dormant" }),
    ];
    renderView(overview);
    const tiles = await screen.findByTestId("overview-stat-row");
    expect(tiles).toHaveTextContent("▪ no prior data");
    expect(tiles).not.toHaveTextContent("+100.0%");
  });
});

describe("<ContextView> — Overview detail drawer", () => {
  // AC-058-08
  it("clicking a skill row writes ?skill= and the drawer shows figures, trend, sessions, topics over still-interactive tables", async () => {
    renderView(makeOverview());
    const table = await screen.findByTestId("overview-table-skill");
    fireEvent.click(within(table).getByTestId("overview-skill-row-alpha"));
    expect(replaceSpy).toHaveBeenCalledWith("/test-path?skill=alpha", { scroll: false });

    // The URL param is the drawer's state — rendering with it open proves the
    // drawer body without navigating away from the Overview. Everything below
    // scopes to THIS render's container: the first render stays mounted, and
    // its drawer-less table must not be the one proving interactivity.
    setSearch({ skill: "alpha" });
    const opened = within(renderView(makeOverview()).container);
    const drawer = await opened.findByTestId("overview-detail-panel");
    expect(within(drawer).getByTestId("overview-panel-range")).toHaveTextContent("40");
    expect(await within(drawer).findByText("Backfill tenant ids")).toBeInTheDocument();
    expect(within(drawer).getByText("Migrations · 5")).toBeInTheDocument();
    expect(within(drawer).getByTestId("adoption-sparkline")).toBeInTheDocument();

    // Scrim-free: no modal backdrop exists, and the table BENEATH THE OPEN
    // DRAWER stays interactive — clicking another row swaps the selection
    // param in place.
    expect(document.querySelector(".MuiBackdrop-root")).toBeNull();
    replaceSpy.mockClear();
    fireEvent.click(
      within(opened.getByTestId("overview-table-skill")).getByTestId("overview-skill-row-dormant"),
    );
    expect(replaceSpy).toHaveBeenCalledWith("/test-path?skill=dormant", { scroll: false });
  });

  // AC-058-09
  it("a deep link with view=overview&skill= opens with the drawer already open and the row highlighted", async () => {
    setSearch({ view: "overview", skill: "alpha" });
    renderView(makeOverview());

    expect(await screen.findByTestId("overview-detail-panel")).toBeInTheDocument();
    const row = screen.getByTestId("overview-skill-row-alpha");
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  // AC-058-10
  it("closing the drawer removes the param and preserves range, sort, and expansion state", async () => {
    const overview = makeOverview();
    overview.skills = Array.from({ length: 10 }, (_, i) =>
      skillRow({
        skillName: `skill-${String(i).padStart(2, "0")}`,
        activations: 100 - i,
        lookbackActivations: 100,
        recentActivations: 1,
        lastActivatedAt: "2026-08-09 10:00:00",
      }),
    );
    ctxState.overview = overview;
    setSearch({ range: "7d", skill: "skill-00" });
    renderView(null);
    await screen.findByTestId("overview-detail-panel");

    // Expand past the top-8 and flip the sort to name-ascending — local table
    // state the close must not reset.
    fireEvent.click(screen.getByTestId("overview-skill-expander"));
    expect(screen.getByText("skill-09")).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("overview-table-skill")).getByText("Skill"));
    const namesSorted = () =>
      within(screen.getByTestId("overview-table-skill"))
        .getAllByTestId(/overview-skill-row-/)
        .map((row) => row.getAttribute("data-testid"));
    expect(namesSorted()[0]).toBe("overview-skill-row-skill-00");

    fireEvent.click(screen.getByTestId("overview-detail-close"));
    expect(replaceSpy).toHaveBeenCalledWith("/test-path?range=7d", { scroll: false });
    // The expansion AND the sort survive the close (range rides in the URL).
    expect(screen.getByText("skill-09")).toBeInTheDocument();
    expect(namesSorted()).toEqual(
      Array.from({ length: 10 }, (_, i) => `overview-skill-row-skill-${String(i).padStart(2, "0")}`),
    );
  });
});

describe("<ContextView> — Overview compatibility and degradation", () => {
  // AC-058-11
  it("a legacy link with file= and no view still opens the Files view with that file selected", async () => {
    setSearch({ file: ".outerlayer/AGENTS.md" });
    renderView(null);

    expect(await screen.findByRole("tree", { name: "Context files" })).toBeInTheDocument();
    expect(screen.queryByTestId("context-overview")).toBeNull();
    // The selected row carries the selection state in the tree.
    const row = screen.getByText("AGENTS.md").closest('[role="treeitem"]');
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  // AC-058-12
  it("a degraded analytics read keeps inventory rows visible with em-dash usage and a retry", async () => {
    const overview = makeOverview();
    overview.degraded = true;
    overview.coverage = null;
    overview.topics = [];
    overview.skills = overview.skills.map((row) => ({
      ...row,
      activations: 0,
      priorActivations: 0,
      sessions: 0,
      recentActivations: 0,
      lookbackActivations: 0,
      lastActivatedAt: null,
      trend: [],
    }));
    renderView(overview);

    const table = await screen.findByTestId("overview-table-skill");
    // The inventory renders — the page never blanks…
    expect(within(table).getByText("alpha")).toBeInTheDocument();
    // …with usage as unknown ("—"), never zero, and no verdicts.
    expect(within(within(table).getByTestId("overview-skill-row-alpha")).getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("overview-status-never")).toBeNull();
    const banner = screen.getByTestId("overview-degraded-banner");
    expect(within(banner).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
