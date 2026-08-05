// @vitest-environment jsdom
/**
 * The trial matrix must never be left live with nothing that can resolve it.
 *
 * Two independent things decide the run's fate: the dispatch branch in
 * `startRun` and the animation effect that walks the fake matrix to `done`.
 * Only the fake path has a resolver, so every input state that reaches
 * `running` through it must also reach that effect. An input state that
 * dispatches into `running` but is filtered out of the animation leaves the
 * page spinning forever with no card, no error, and no timeout.
 *
 * A wired runner needs both the app id and the org slug (the run-status poll
 * route derives its tenant from the slug). `useParams` makes the slug
 * optional, so the missing-slug state is reachable — and quietly running the
 * seeded demo there would present invented numbers as a real benchmark.
 *
 * Seams mocked: `real-runner` (the backend client), `next/navigation` (URL),
 * `@/components/snackbar` (toast transport).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";

const enqueueSnackbar = vi.fn();

let params: { orgName?: string } = {};
let realRunnerEnabled = true;

vi.mock("@mui/x-data-grid", () => ({}));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/snackbar", () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

const runRealEval = vi.fn();
const refreshRunHistory = vi.fn();
const loadRunDetail = vi.fn();
vi.mock("../real-runner", () => ({
  isRealRunnerEnabled: () => realRunnerEnabled,
  runRealEval: (...args: unknown[]) => runRealEval(...args),
  refreshRunHistory: (...args: unknown[]) => refreshRunHistory(...args),
  loadRunDetail: (...args: unknown[]) => loadRunDetail(...args),
}));

import { EvalsSection } from "../evals";
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

const MISSING_CONTEXT_CAUSE =
  "this page is missing the app or organization it belongs to. Reload the page and try again.";
const MISSING_CONTEXT = `Couldn't start the benchmark: ${MISSING_CONTEXT_CAUSE}`;

function renderSection(props: { appId?: string; initialRuns?: EvalRunSummary[] } = {}) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <EvalsSection
        appId={"appId" in props ? props.appId : "app-1"}
        repoLabel="acme/payments"
        environmentId="env-1"
        initialRuns={props.initialRuns ?? []}
        runsError={null}
      />
    </ThemeProvider>,
  );
}

/** Trials the matrix has taken off the queue, read off the progress readout.
 *  Sampled rather than asserted against a fixed number: the animation ticks on
 *  a real 120ms interval that no assertion can be synchronous with. */
function resolvedTrials(): number {
  const readout = screen.getByTestId("eval-progress").textContent ?? "";
  const match = /Running — (\d+)\/(\d+) trials/.exec(readout);
  if (!match) throw new Error(`no progress readout found in: ${readout}`);
  return Number(match[1]);
}

/** Drive the wizard end-to-end on its defaults and dispatch the run. */
async function launchRun(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("new-eval"));
  await user.click(screen.getByTestId("wizard-next"));
  await user.click(screen.getByTestId("wizard-next"));
  await user.click(screen.getByTestId("wizard-next"));
  await user.click(screen.getByTestId("wizard-run"));
}

describe("EvalsSection — dispatch guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    params = { orgName: "org-1" };
    realRunnerEnabled = true;
    refreshRunHistory.mockResolvedValue([]);
  });

  it("refuses a wired dispatch with no org slug instead of leaving the matrix live", async () => {
    params = {};
    const user = userEvent.setup();
    renderSection();

    await launchRun(user);

    expect(await screen.findByTestId("eval-run-error")).toHaveTextContent(MISSING_CONTEXT);
    // Nothing was dispatched, so nothing can complete the run...
    expect(runRealEval).not.toHaveBeenCalled();
    // ...and the section must therefore be back at idle, not showing a matrix
    // that no code path will ever finish.
    expect(screen.queryByTestId("eval-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("evals-empty")).toBeInTheDocument();
    // The missing slug belongs to the page, not to this attempt, so there is
    // no second attempt to offer — only Dismiss.
    expect(screen.queryByTestId("eval-run-retry")).not.toBeInTheDocument();
    expect(screen.getByTestId("eval-run-error-dismiss")).toBeInTheDocument();
  });

  it("refuses a wired dispatch with no app id instead of leaving the matrix live", async () => {
    const user = userEvent.setup();
    renderSection({ appId: undefined });

    await launchRun(user);

    expect(await screen.findByTestId("eval-run-error")).toHaveTextContent(MISSING_CONTEXT);
    expect(runRealEval).not.toHaveBeenCalled();
    expect(screen.queryByTestId("eval-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("evals-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("eval-run-retry")).not.toBeInTheDocument();
    expect(screen.getByTestId("eval-run-error-dismiss")).toBeInTheDocument();
  });

  it("keeps resolving the seeded matrix when no runner is wired", async () => {
    realRunnerEnabled = false;
    const user = userEvent.setup();
    renderSection();

    await launchRun(user);
    // Wizard defaults: 84 tasks × 2 configs × 3 trials.
    expect(screen.getByTestId("eval-progress")).toHaveTextContent(/Running — \d+\/504 trials/);
    const before = resolvedTrials();
    expect(before).toBeLessThan(504);

    // The animation is the only thing that moves this count, so a matrix whose
    // count never rises has no way out of `running`. Asserted as an increase
    // from whatever was on screen rather than against a fixed number: the tick
    // count by the time any assertion runs is a race, and pinning it makes the
    // test flaky, which is how a guard against a stuck matrix gets deleted.
    await vi.waitFor(() => expect(resolvedTrials()).toBeGreaterThan(before), { timeout: 5_000 });
    // Cells come off the queue a full tick at a time, never in fragments.
    expect((resolvedTrials() - before) % 6).toBe(0);
    expect(screen.queryByTestId("eval-run-error")).not.toBeInTheDocument();
  });

  it("toasts when a succeeded run cannot be addressed, rather than absorbing the click", async () => {
    params = {};
    const user = userEvent.setup();
    renderSection({ initialRuns: [SUCCEEDED_RUN] });

    await user.click(screen.getByTestId("eval-run-run-1"));

    await vi.waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith(`Couldn't open that run: ${MISSING_CONTEXT_CAUSE}`, {
        variant: "error",
      }),
    );
    // There is no URL to read the detail from, so the fetch must not be tried.
    expect(loadRunDetail).not.toHaveBeenCalled();
    expect(screen.getByTestId("eval-history")).toBeInTheDocument();
    expect(screen.queryByTestId("verdict-chip")).not.toBeInTheDocument();
  });

  it("toasts when a succeeded run carries no Report Card, rather than absorbing the click", async () => {
    loadRunDetail.mockResolvedValue({
      id: "run-1",
      status: "succeeded",
      card: null,
      cost_usd: 0.14,
      error: null,
    });
    const user = userEvent.setup();
    renderSection({ initialRuns: [SUCCEEDED_RUN] });

    await user.click(screen.getByTestId("eval-run-run-1"));

    await vi.waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith(
        "That run finished without a Report Card, so there's nothing to open.",
        { variant: "error" },
      ),
    );
    // The click resolved to feedback, not to a card view built from nothing.
    expect(screen.getByTestId("eval-history")).toBeInTheDocument();
    expect(screen.queryByTestId("verdict-chip")).not.toBeInTheDocument();
  });
});
