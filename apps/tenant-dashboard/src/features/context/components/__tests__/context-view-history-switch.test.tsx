// @vitest-environment jsdom
/**
 * The Files | History view switch in the Context tab header: it deep-links
 * through `?view=history`, swaps the tab's main area to the full-width History
 * panel, and stays visible in both views. The History panel itself is mocked to
 * a probe here — its data path is covered in history/__tests__/context-history.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type { ContextTreeResponse } from "../../types";

vi.mock("@/lib/app-shell/app-context", () => ({
  useAppContext: () => ({ app: { id: "app-1", require_pull_request: false } }),
}));

vi.mock("@/auth/hooks/use-app-permissions", () => ({
  useAppPermissions: () => ({ permissions: [], isLoading: false, hasPermission: () => true }),
}));

vi.mock("@/features/context/action-adapters", () => ({
  readRemoteContextFileAction: vi.fn(async () => ({ data: null })),
  resyncContextAction: vi.fn(async () => ({ data: { kind: "synced" } })),
}));

vi.mock("../editor", () => ({
  useUnsavedChangesGuard: () => {},
  ContextEditor: () => <div data-testid="editor-probe" />,
  PublishDialog: () => null,
  CreateFilePopover: () => null,
  DeleteContextDialog: () => null,
}));

// Isolate the switch from the History data path.
vi.mock("../history/context-history", () => ({
  ContextHistory: ({ appId }: { appId: string }) => (
    <div data-testid="history-probe" data-app-id={appId} />
  ),
}));

// The tree/file reads arrive as props from a React Server Component (RSC) and
// are re-read through the read
// actions; mock that server seam over mutable state.
const { ctxState } = vi.hoisted(() => ({
  ctxState: { tree: null as unknown as import("../../types").ContextTreeResponse },
}));
// The read actions gate on context.read → they resolve to the action-kit
// result envelope, which the hooks unwrap.
vi.mock("@/features/context/read-actions", () => ({
  getContextTree: vi.fn(async () => ({ ok: true, data: ctxState.tree })),
  getContextOverview: vi.fn(async () => ({
    ok: true,
    data: {
      range: "30d",
      recentDays: 14,
      lookbackDays: 90,
      degraded: false,
      skills: [],
      mcpServers: [],
      coverage: { sessions: 0, sessionsWithSkill: 0, priorSessions: 0, priorSessionsWithSkill: 0, lookbackSessions: 0 },
      topics: [],
      inventory: { instructionScopes: 0, commands: 0, subagents: 0 },
    },
  })),
  getContextFile: vi.fn(async () => {
    throw new Error("context file not found");
  }),
  getContextSkillDrilldown: vi.fn(async () => ({ ok: true, data: { trend: [], sessions: [], topics: [], lookbackDays: 90 } })),
  getContextMcpDrilldown: vi.fn(async () => ({ ok: true, data: { tools: [], trend: [], sessions: [], lookbackDays: 90, recentDays: 14 } })),
}));

import { ContextView } from "../context-view";
import { resyncContextAction } from "../../action-adapters";

const TREE: ContextTreeResponse = {
  gitConnection: { repository: "acme/app", branch: "main" },
  head: { commitSha: "head-sha", snapshotId: "snap-1", syncedAt: "2026-07-10T00:00:00Z" },
  entries: [{ path: ".outerlayer/AGENTS.md", kind: "instructions", scopePath: "", blobSha: "b1" }],
  excludedCounts: [],
  issues: [],
  mcpServerCounts: [],
};

function seedTree(tree: ContextTreeResponse) {
  ctxState.tree = tree;
}

let currentSelectedPath: string | null = null;
function setSearch(params: Record<string, string>) {
  currentSelectedPath = params.file ?? null;
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(params) as never);
}

const replaceSpy = vi.fn();

function renderView() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ContextView
        appId="app-1"
        initialTree={ctxState.tree}
        initialFile={null}
        initialSelectedPath={currentSelectedPath}
      />
    </SWRConfig>,
  );
}

beforeEach(() => {
  replaceSpy.mockClear();
  currentSelectedPath = null;
  ctxState.tree = null as unknown as ContextTreeResponse;
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

describe("<ContextView> — Files | History view switch", () => {
  it("defaults to the Overview: a bare URL renders it, with the three-way switch present", async () => {
    seedTree(TREE);
    renderView();
    expect(await screen.findByTestId("context-overview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "history" })).toBeInTheDocument();
    expect(screen.queryByTestId("history-probe")).not.toBeInTheDocument();
    expect(screen.queryByRole("tree", { name: "Context files" })).not.toBeInTheDocument();
  });

  it("?view=files renders the Files tree", async () => {
    setSearch({ view: "files" });
    seedTree(TREE);
    renderView();
    expect(await screen.findByRole("tree", { name: "Context files" })).toBeInTheDocument();
    expect(screen.queryByTestId("context-overview")).not.toBeInTheDocument();
  });

  it("?view=history deep-links straight to the History panel (no tree)", async () => {
    setSearch({ view: "history" });
    seedTree(TREE);
    renderView();
    const probe = await screen.findByTestId("history-probe");
    expect(probe.getAttribute("data-app-id")).toBe("app-1");
    expect(screen.queryByRole("tree", { name: "Context files" })).not.toBeInTheDocument();
    // The switch stays in the header in the History view too.
    expect(screen.getByRole("button", { name: "files" })).toBeInTheDocument();
  });

  it("clicking History writes ?view=history via router.replace", async () => {
    seedTree(TREE);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "history" }));
    expect(replaceSpy).toHaveBeenCalledWith("/test-path?view=history", { scroll: false });
  });

  it("clicking Files from History writes ?view=files explicitly (Overview owns the bare URL)", async () => {
    setSearch({ view: "history", file: ".outerlayer/AGENTS.md" });
    seedTree(TREE);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "files" }));
    // `file` is preserved; the view goes explicit — a bare URL with `file=`
    // is a legacy Files link, so Files can't be expressed by dropping the param.
    expect(replaceSpy).toHaveBeenCalledWith(
      "/test-path?view=files&file=.outerlayer%2FAGENTS.md",
      { scroll: false },
    );
  });

  it("History is reachable even when the app has never synced (head is null)", async () => {
    setSearch({ view: "history" });
    seedTree({ ...TREE, head: null, entries: [] });
    renderView();
    expect(await screen.findByTestId("history-probe")).toBeInTheDocument();
    expect(screen.queryByText("Set up context for this repo")).not.toBeInTheDocument();
  });

  it("Files view: the header Resync button triggers a context resync", async () => {
    setSearch({ view: "files" });
    seedTree(TREE);
    vi.mocked(resyncContextAction).mockClear();
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Resync context" }));
    expect(vi.mocked(resyncContextAction)).toHaveBeenCalledWith("app-1");
  });

  it("History view: the same header Resync button triggers a context resync", async () => {
    setSearch({ view: "history" });
    seedTree(TREE);
    vi.mocked(resyncContextAction).mockClear();
    renderView();
    // The button lives in the header, present in the History view too.
    fireEvent.click(await screen.findByRole("button", { name: "Resync context" }));
    expect(vi.mocked(resyncContextAction)).toHaveBeenCalledWith("app-1");
  });
});
