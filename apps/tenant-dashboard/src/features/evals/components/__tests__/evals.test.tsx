// @vitest-environment jsdom
/**
 * Component test for the Evals section shell + run history. `appId`,
 * `repoLabel`, and `environmentId` arrive as props — the benchmarks React Server Component (RSC)
 * resolves them server-side — so the section itself reads no app or env
 * provider. Run history arrives as the `initialRuns` prop the same way, so
 * completed runs render immediately rather than reverting to the empty
 * state while a fetch resolves.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("@mui/x-data-grid", () => ({}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgName: "org-1" }),
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { EvalsSection } from "../evals";
import { buildCardFromCells, planTrialCells, resolveCell, type EvalRunRequest } from "../fake-runner";
import type { EvalRunSummary } from "../real-runner";

/** A full, valid stored ReportCard (same recipe as eval-card.test.tsx). */
function storedCard() {
  const request: EvalRunRequest = {
    repoLabel: "acme/payments",
    taskIds: Array.from({ length: 20 }, (_v, i) => `task-${i}`),
    configs: [
      { id: "opus-4.8", launcher: "claude-code", model: "claude-opus-4-8" },
      { id: "glm-5.2", launcher: "claude-code", model: "glm-5.2" },
    ],
    trialsPerTask: 1,
    budgetUsd: 90,
    scenario: "clear",
  };
  const cells = planTrialCells(request).map((c) => resolveCell(request, c));
  return buildCardFromCells(request, cells);
}

// The history-list summary never carries `card` — the list projection
// excludes it (see `service.ts`'s `LIST_COLUMNS`) — matching what the RSC
// actually seeds.
const SUCCEEDED_RUN: EvalRunSummary = {
  id: "run-1",
  status: "succeeded",
  repo_label: "acme/payments",
  request: {
    configs: [{ id: "opus-4.8" }, { id: "glm-5.2" }],
    taskCount: 20,
    trialsPerTask: 1,
  },
  cost_usd: 0.14,
  error: null,
  created_at: "2026-07-13T19:14:40.000Z",
};

const FAILED_RUN: EvalRunSummary = {
  id: "run-2",
  status: "failed",
  repo_label: "acme/payments",
  request: {
    configs: [{ id: "opus-4.8" }, { id: "glm-5.2" }],
    taskCount: 20,
    trialsPerTask: 1,
  },
  card: null,
  cost_usd: 0,
  error: "eval worker gateway URL not configured",
  created_at: "2026-07-13T18:49:49.000Z",
};

function renderSection(initialRuns: EvalRunSummary[] = []) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <EvalsSection appId="app-1" repoLabel="acme/payments" initialRuns={initialRuns} />
    </ThemeProvider>,
  );
}

describe("EvalsSection", () => {
  it("titles the page and puts both view controls and the launch action in the header", () => {
    renderSection([]);
    const header = screen.getByTestId("page-header");
    expect(within(header).getByRole("heading", { level: 4 })).toHaveTextContent("Benchmarks");
    expect(header).toHaveTextContent(/execution-verified tasks/);

    // The view toggle and the launch button are page-level actions, not
    // content: they stay reachable whichever view is on screen.
    const actions = within(screen.getByTestId("page-header-actions"));
    expect(actions.getByTestId("view-card")).toBeInTheDocument();
    expect(actions.getByTestId("view-landscape")).toBeInTheDocument();
    expect(actions.getByTestId("new-eval")).toBeInTheDocument();
  });

  it("renders the empty state when the app has no persisted runs", () => {
    renderSection([]);
    expect(screen.getByTestId("evals-page")).toBeInTheDocument();
    const empty = screen.getByTestId("evals-empty");
    // The general card treatment — the dashed outline is reserved for
    // create-your-first-X slots, and a benchmark is launched, not created here.
    expect(empty).toHaveAttribute("data-variant", "card");
    expect(within(empty).getByRole("heading", { level: 6 })).toHaveTextContent("No benchmarks yet");
    expect(empty).toHaveTextContent(/minimum detectable difference/);
  });

  it("renders seeded run history instead of the empty state", () => {
    renderSection([SUCCEEDED_RUN, FAILED_RUN]);
    expect(screen.getByTestId("eval-history")).toBeInTheDocument();
    expect(screen.queryByTestId("evals-empty")).not.toBeInTheDocument();

    // Succeeded row: comparison, cost. The row itself carries no card (the
    // list projection excludes it), so no verdict pill renders from the row
    // alone — opening the run is a separate, on-demand fetch (below).
    const succeeded = screen.getByTestId("eval-run-run-1");
    expect(succeeded).toHaveTextContent("opus-4.8 vs glm-5.2");
    expect(succeeded).toHaveTextContent("20 × 1");
    expect(succeeded).toHaveTextContent("$0.14");
    expect(screen.queryByTestId("run-verdict-run-1")).not.toBeInTheDocument();

    // Failed row: status + the backend's error, no verdict pill.
    const failed = screen.getByTestId("eval-run-run-2");
    expect(failed).toHaveTextContent("failed");
    expect(failed).toHaveTextContent("eval worker gateway URL not configured");
    expect(screen.queryByTestId("run-verdict-run-2")).not.toBeInTheDocument();
  });

  it("opens a past run's Report Card via an on-demand detail fetch, and navigates back to history", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        run: { id: "run-1", status: "succeeded", card: storedCard(), cost_usd: 0.14, error: null },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSection([SUCCEEDED_RUN]);

    await user.click(screen.getByTestId("eval-run-run-1"));
    // The fetched card renders with its integrity guarantees intact.
    expect(await screen.findByTestId("verdict-chip")).toHaveTextContent("Clear result");
    expect(screen.getByTestId("mde-line")).toHaveTextContent(/can detect differences ≥ \d+pp/);
    expect(fetchMock).toHaveBeenCalledWith("/api/orgs/org-1/apps/app-1/evals/runs/run-1?appId=app-1");

    await user.click(screen.getByRole("button", { name: /back to benchmarks/i }));
    expect(screen.getByTestId("eval-history")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("does not open a card for failed runs — no detail fetch runs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSection([FAILED_RUN]);

    await user.click(screen.getByTestId("eval-run-run-2"));
    expect(screen.queryByTestId("verdict-chip")).not.toBeInTheDocument();
    expect(screen.getByTestId("eval-history")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("opens the run wizard from the header action, pre-scoped to the repo", async () => {
    const user = userEvent.setup();
    renderSection([]);
    expect(screen.queryByTestId("eval-wizard")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("new-eval"));
    expect(screen.getByTestId("eval-wizard")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-repo")).toHaveTextContent("acme/payments");
  });

  it("toggles between the head-to-head and landscape views", async () => {
    const user = userEvent.setup();
    renderSection([]);
    expect(screen.getByTestId("evals-empty")).toBeInTheDocument();
    await user.click(screen.getByTestId("view-landscape"));
    // the card-flow empty state is replaced by the landscape view
    expect(screen.queryByTestId("evals-empty")).not.toBeInTheDocument();
  });
});
