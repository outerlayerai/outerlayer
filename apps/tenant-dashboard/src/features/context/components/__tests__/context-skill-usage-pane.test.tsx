// @vitest-environment jsdom
/**
 * Render tests for the skill detail pane (Files | Usage tabs). The drill-down
 * loads through the context read action (server seam) → vi.mock; the real SWR
 * hook runs and unwraps the result envelope. Navigation identity (org/app
 * params) is mocked; the env context is absent, so session links must fall back
 * to the default env name — the same posture the sessions page takes.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { SkillDetailPane } from "../context-skill-usage-pane";
import type { SkillActivation } from "../context-skill-adoption";

// The drill-down read action, over mutable state so each test picks its payload
// (or a failed envelope) and the hook's `unwrap` produces the matching state.
const { drillState } = vi.hoisted(() => ({
  drillState: {
    detail: null as unknown as import("@/features/context/types").SkillDrilldownResponse,
    fail: false,
  },
}));
vi.mock("@/features/context/read-actions", () => ({
  getContextSkillDrilldown: vi.fn(async () =>
    drillState.fail
      ? { ok: false, error: { message: "drill-down unavailable" } }
      : { ok: true, data: drillState.detail },
  ),
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
const chTimestamp = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");

const ACTIVATION: SkillActivation = {
  skillName: "writing",
  recentActivations: 8,
  totalActivations: 12,
  totalSessions: 6,
  lastActivatedAt: chTimestamp(2 * HOUR),
};

const DETAIL = {
  trend: [{ day: new Date().toISOString().slice(0, 10), activations: 3, sessions: 2 }],
  sessions: [
    { traceId: "tr-1", title: "Fix the flaky test", activations: 2, lastActivatedAt: "2026-07-19 09:00:00" },
    { traceId: "tr-2abcdef12345678", title: null, activations: 1, lastActivatedAt: "2026-07-18 08:00:00" },
  ],
  topics: [{ topicId: "topic-9", name: "CI debugging", sessions: 2 }],
  lookbackDays: 90,
};

const renderPane = (over?: {
  activation?: SkillActivation | undefined;
  overlayLoaded?: boolean;
  onSelectFile?: (path: string) => void;
}) =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <SkillDetailPane
        skillName="writing"
        dirPath=".outerlayer/skills/writing"
        files={[
          { path: ".outerlayer/skills/writing/SKILL.md", name: "SKILL.md" },
          { path: ".outerlayer/skills/writing/references/style.md", name: "references/style.md" },
        ]}
        activation={"activation" in (over ?? {}) ? over!.activation : ACTIVATION}
        overlayLoaded={over?.overlayLoaded ?? true}
        recentDays={14}
        lookbackDays={90}
        onSelectFile={over?.onSelectFile ?? (() => {})}
      />
    </SWRConfig>,
  );

describe("SkillDetailPane", () => {
  beforeEach(() => {
    cleanup();
    drillState.detail = DETAIL;
    drillState.fail = false;
  });

  it("defaults to the Usage tab with the overlay-fed stat headline", async () => {
    renderPane();
    // Stats render immediately from the overlay row, before the drill-down lands.
    expect(screen.getByTestId("skill-usage-recent")).toHaveTextContent("8");
    expect(screen.getByTestId("skill-usage-total")).toHaveTextContent("12");
    expect(screen.getByTestId("skill-usage-sessions")).toHaveTextContent("6");
    expect(screen.getByTestId("skill-usage-last-used")).toHaveTextContent("2h ago");
    await waitFor(() => expect(screen.getByTestId("adoption-sparkline")).toBeInTheDocument());
  });

  it("links each activating session to the session page under the default env", async () => {
    renderPane();
    await waitFor(() => expect(screen.getAllByRole("link").length).toBeGreaterThan(0));
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/orgs/acme/apps/web/env/dev/agents/sessions/tr-1",
      "/orgs/acme/apps/web/env/dev/agents/sessions/tr-2abcdef12345678",
    ]);
    // Titled session shows its title; the untitled one falls back to a
    // truncated trace id rather than an empty link.
    expect(links[0]).toHaveTextContent("Fix the flaky test");
    expect(links[1]).toHaveTextContent("tr-2abcdef12");
    expect(screen.getByTestId("skill-usage-topic")).toHaveTextContent("CI debugging · 2");
  });

  it("a never-activated skill shows red 'never' and zeroed stats, not fabricated data", async () => {
    drillState.detail = { trend: [], sessions: [], topics: [], lookbackDays: 90 };
    renderPane({ activation: undefined });
    expect(screen.getByTestId("skill-usage-recent")).toHaveTextContent("0");
    expect(screen.getByTestId("skill-usage-last-used")).toHaveTextContent("never");
    await waitFor(() => expect(screen.getByTestId("adoption-sparkline-flat")).toBeInTheDocument());
    expect(screen.getByText("No activating sessions recorded in the last 90 days.")).toBeInTheDocument();
  });

  it("an unloaded overlay renders unknown stats as em dashes, never zeros or 'never'", () => {
    renderPane({ activation: undefined, overlayLoaded: false });
    expect(screen.getByTestId("skill-usage-recent")).toHaveTextContent("—");
    expect(screen.getByTestId("skill-usage-last-used")).toHaveTextContent("—");
    expect(screen.queryByText("never")).toBeNull();
  });

  it("a failed drill-down fetch degrades to the unavailable note, keeping the stats", async () => {
    drillState.fail = true;
    renderPane();
    await waitFor(() => expect(screen.getByText("Activation detail unavailable.")).toBeInTheDocument());
    expect(screen.getByTestId("skill-usage-recent")).toHaveTextContent("8");
  });

  it("the Files tab lists the skill's files and reports the selected path", () => {
    const onSelectFile = vi.fn();
    renderPane({ onSelectFile });
    fireEvent.click(screen.getByTestId("skill-tab-files"));
    fireEvent.click(screen.getByText("references/style.md"));
    expect(onSelectFile).toHaveBeenCalledWith(".outerlayer/skills/writing/references/style.md");
  });
});
