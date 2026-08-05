// @vitest-environment jsdom
/**
 * Every failure path in the Benchmarks section reaches the user.
 *
 * Four failures live in this component, and each is invisible unless it is
 * deliberately rendered. A dispatch that throws returns the phase to idle and
 * takes the matrix down with it, which is indistinguishable from never having
 * launched. A history refresh that throws leaves a completed run missing from
 * the list. A run-detail fetch that throws makes the click do nothing at all.
 * And a failed server-side history read yields an empty list, which the
 * cold-start card would state as the fact that no benchmark has ever run.
 *
 * The dispatch error also has to outlive the view toggle: the wizard launches
 * from Landscape too, so an error rendered only inside the card flow is state
 * nobody sees.
 *
 * Reaching the user is necessary but not sufficient — the alert also has to be
 * honest about the way out. A Retry belongs on a failure another attempt could
 * clear, and nowhere else: on a permission or routing refusal it can only
 * reproduce the same refusal.
 *
 * Seams mocked: `real-runner` (the backend client), `next/navigation` (URL),
 * `@/components/snackbar` (toast transport).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";

const enqueueSnackbar = vi.fn();
const refresh = vi.fn();

vi.mock("@mui/x-data-grid", () => ({}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgName: "org-1" }),
  useRouter: () => ({ refresh }),
}));
vi.mock("@/components/snackbar", () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

const runRealEval = vi.fn();
const refreshRunHistory = vi.fn();
const loadRunDetail = vi.fn();
vi.mock("../real-runner", () => ({
  isRealRunnerEnabled: () => true,
  runRealEval: (...args: unknown[]) => runRealEval(...args),
  refreshRunHistory: (...args: unknown[]) => refreshRunHistory(...args),
  loadRunDetail: (...args: unknown[]) => loadRunDetail(...args),
}));

import { EvalsSection } from "../evals";
import { EvalRunError } from "../run-error";
import type { EvalRunSummary } from "../real-runner";

const SUCCEEDED_RUN: EvalRunSummary = {
  id: "run-1",
  status: "succeeded",
  repo_label: "acme/payments",
  request: { configs: [{ id: "opus-4.8" }, { id: "glm-5.2" }], taskCount: 20, trialsPerTask: 1 },
  cost_usd: 0.14,
  error: null,
  created_at: "2026-07-13T19:14:40.000Z",
};

function renderSection(props: { initialRuns?: EvalRunSummary[]; runsError?: string | null } = {}) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <EvalsSection
        appId="app-1"
        repoLabel="acme/payments"
        environmentId="env-1"
        initialRuns={props.initialRuns ?? []}
        runsError={props.runsError ?? null}
      />
    </ThemeProvider>,
  );
}

/** Drive the wizard end-to-end on its defaults and dispatch the run. */
async function launchRun(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("new-eval"));
  await user.click(screen.getByTestId("wizard-next"));
  await user.click(screen.getByTestId("wizard-next"));
  await user.click(screen.getByTestId("wizard-next"));
  await user.click(screen.getByTestId("wizard-run"));
}

// Every case here drives the four-step wizard with `userEvent`, which is
// genuinely slow work rather than a hang; under a parallel suite run that
// exceeds the default per-test budget, so the budget is stated explicitly.
describe("EvalsSection — failure feedback", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshRunHistory.mockResolvedValue([]);
  });

  it("surfaces a dispatch failure inline and re-dispatches the same request on Retry", async () => {
    runRealEval.mockRejectedValue(new Error("No model key for glm-5.2 in this environment."));
    const user = userEvent.setup();
    renderSection();

    await launchRun(user);

    const alert = await screen.findByTestId("eval-run-error");
    expect(alert).toHaveTextContent("No model key for glm-5.2 in this environment.");

    const expectedRequest = expect.objectContaining({
      repoLabel: "acme/payments",
      trialsPerTask: 3,
      budgetUsd: 90,
      configs: [
        expect.objectContaining({ id: "opus-4.8" }),
        expect.objectContaining({ id: "glm-5.2" }),
      ],
    });
    expect(runRealEval).toHaveBeenCalledWith("app-1", "org-1", "env-1", expectedRequest);

    await user.click(screen.getByTestId("eval-run-retry"));
    expect(runRealEval).toHaveBeenCalledTimes(2);
    expect(runRealEval).toHaveBeenLastCalledWith("app-1", "org-1", "env-1", expectedRequest);
  });

  it("keeps the dispatch error visible in the Landscape view, where the wizard is equally reachable", async () => {
    runRealEval.mockRejectedValue(new Error("No model key for glm-5.2 in this environment."));
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByTestId("view-landscape"));
    await launchRun(user);

    expect(await screen.findByTestId("eval-run-error")).toHaveTextContent(
      "No model key for glm-5.2 in this environment.",
    );
    // Still on Landscape — the error rides above the toggle, it does not
    // switch the view out from under the user.
    expect(screen.queryByTestId("evals-empty")).not.toBeInTheDocument();
  });

  it("dismisses the dispatch error on request", async () => {
    runRealEval.mockRejectedValue(new Error("dispatch rejected"));
    const user = userEvent.setup();
    renderSection();

    await launchRun(user);
    await screen.findByTestId("eval-run-error");

    await user.click(screen.getByTestId("eval-run-error-dismiss"));
    expect(screen.queryByTestId("eval-run-error")).not.toBeInTheDocument();
  });

  it("clears a stale dispatch error when a past run's card is opened", async () => {
    runRealEval.mockRejectedValue(new Error("dispatch rejected"));
    // The post-run refresh re-seeds the history, so the row stays clickable.
    refreshRunHistory.mockResolvedValue([SUCCEEDED_RUN]);
    loadRunDetail.mockResolvedValue({ id: "run-1", status: "succeeded", card: null, cost_usd: 0.14, error: null });
    const user = userEvent.setup();
    renderSection({ initialRuns: [SUCCEEDED_RUN] });

    await launchRun(user);
    await screen.findByTestId("eval-run-error");

    await user.click(screen.getByTestId("eval-run-run-1"));

    // The failed dispatch has nothing to say about the run just opened.
    expect(screen.queryByTestId("eval-run-error")).not.toBeInTheDocument();
  });

  it("toasts when the post-run history refresh fails", async () => {
    runRealEval.mockRejectedValue(new Error("dispatch rejected"));
    refreshRunHistory.mockRejectedValue(new Error("Run history unavailable."));
    const user = userEvent.setup();
    renderSection();

    await launchRun(user);

    await screen.findByTestId("eval-run-error");
    expect(enqueueSnackbar).toHaveBeenCalledWith("Run history unavailable.", { variant: "error" });
  });

  it("toasts when opening a past run's Report Card fails, keeping the history on screen", async () => {
    loadRunDetail.mockRejectedValue(new Error("Run detail failed (503)."));
    const user = userEvent.setup();
    renderSection({ initialRuns: [SUCCEEDED_RUN] });

    await user.click(screen.getByTestId("eval-run-run-1"));

    await vi.waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith("Run detail failed (503).", { variant: "error" }),
    );
    expect(loadRunDetail).toHaveBeenCalledWith("app-1", "org-1", "run-1");
    expect(screen.getByTestId("eval-history")).toBeInTheDocument();
  });

  it("renders a failed history read as an error, never as the cold-start empty state", async () => {
    const user = userEvent.setup();
    renderSection({ initialRuns: [], runsError: "ClickHouse is unavailable." });

    const card = screen.getByTestId("evals-runs-error");
    expect(card).toHaveTextContent("Couldn't load run history");
    expect(card).toHaveTextContent("ClickHouse is unavailable.");
    // The bug class: an unknown history presented as a factual "you have never
    // run a benchmark".
    expect(screen.queryByTestId("evals-empty")).not.toBeInTheDocument();
    expect(screen.queryByText(/no benchmarks yet/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry now/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry for a failure another attempt would be refused identically", async () => {
    runRealEval.mockRejectedValue(
      new EvalRunError("You don't have permission to read this benchmark run.", {
        kind: "poll_failed",
        retryable: false,
        status: 403,
      }),
    );
    const user = userEvent.setup();
    renderSection();

    await launchRun(user);

    const alert = await screen.findByTestId("eval-run-error");
    expect(alert).toHaveTextContent("You don't have permission to read this benchmark run.");
    // The bug class: a Retry that can only reproduce the same refusal, dressed
    // up as a way out of it.
    expect(screen.queryByTestId("eval-run-retry")).not.toBeInTheDocument();
    // Dismiss survives — the user still needs a way to clear the alert.
    expect(screen.getByTestId("eval-run-error-dismiss")).toBeInTheDocument();
  });

  it("reports a run that outlasted the poll in its own words, and does offer a retry", async () => {
    runRealEval.mockRejectedValue(
      new EvalRunError("The eval run timed out.", { kind: "timed_out", retryable: true }),
    );
    const user = userEvent.setup();
    renderSection();

    await launchRun(user);

    const alert = await screen.findByTestId("eval-run-error");
    // A run still executing when the client stopped waiting is not the same
    // event as a status read the server refused, and does not borrow its copy.
    expect(alert).toHaveTextContent("The eval run timed out.");
    expect(alert).not.toHaveTextContent(/permission|no longer available/i);
    // Waiting really might have been enough, so here the retry is honest.
    expect(screen.getByTestId("eval-run-retry")).toBeInTheDocument();
  });

  it("keeps the cold-start empty state when the history read succeeded and is genuinely empty", () => {
    renderSection({ initialRuns: [], runsError: null });

    expect(screen.getByTestId("evals-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("evals-runs-error")).not.toBeInTheDocument();
  });
});
