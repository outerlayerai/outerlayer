// @vitest-environment jsdom
/**
 * The one-shot run detail as a chat thread: user bubble → agent activity →
 * outcome (PR card / branch card / no-changes / failure), Stop only while
 * live, and the cancel POST.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { SWRConfig } from "swr";

import { server } from "@/test-helpers/msw-server";
import { WorkerRunDetail } from "../worker-run-detail";
import {
  BASE,
  installFetchBaseShim,
  removeFetchBaseShim,
  runFixture,
} from "./workers-ui.helpers";

vi.mock("@/components/snackbar", () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));
const { cancelWorker } = vi.hoisted(() => ({ cancelWorker: vi.fn() }));
vi.mock("../../action-adapters", () => ({ cancelWorker }));

beforeAll(installFetchBaseShim);
afterAll(removeFetchBaseShim);
afterEach(() => cancelWorker.mockReset());

function seedRunRoute(run: Record<string, unknown>, events: Array<Record<string, unknown>> = []) {
  server.use(
    http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/run-1`, () => HttpResponse.json({ run, events })),
  );
}

function renderDetail(onBack = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WorkerRunDetail orgName="org-1" appId="app-1" runId="run-1" onBack={onBack} />
    </SWRConfig>,
  );
}

describe("WorkerRunDetail", () => {
  it("reports a failed run load instead of an endless placeholder", async () => {
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/run-1`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderDetail();

    const card = await screen.findByTestId("worker-run-error");
    expect(card).toHaveAttribute("role", "alert");
    expect(screen.getByRole("heading", { name: "Couldn't load this run" })).toBeInTheDocument();
    expect(card).toHaveTextContent("The server responded with 500.");
    // A failed load has no transcript to stand in for, and no Stop to offer.
    expect(screen.queryByTestId("worker-run-skeleton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("stands a placeholder in while the run loads, never a spinner", async () => {
    server.use(
      http.get(
        `${BASE}/api/orgs/org-1/apps/app-1/workers/runs/run-1`,
        () => new Promise(() => {}),
      ),
    );
    renderDetail();

    const skeleton = await screen.findByTestId("worker-run-skeleton");
    expect(skeleton).toHaveTextContent("Loading");
    expect(screen.queryByRole("progressbar")).toBeNull();
    // The header renders immediately — it owns the way back out.
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.queryByTestId("worker-run-skeleton-header")).toBeNull();
  });

  it("renders the exchange: agent name, prompt bubble, transcript, PR card, meta line", async () => {
    seedRunRoute(runFixture({ pr_url: "https://github.com/o/r/pull/7", pr_number: 7 }), [
      { seq: 0, event_type: "agent-message", payload: { text: "On it." }, created_at: "t" },
      { seq: 1, event_type: "file-change", payload: { path: "src/version.ts" }, created_at: "t" },
    ]);
    renderDetail();

    await waitFor(() => expect(screen.getByText("Add a /version endpoint")).toBeInTheDocument());
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("On it.")).toBeInTheDocument();
    expect(screen.getByText("Edited src/version.ts")).toBeInTheDocument();

    const prLink = screen.getByRole("link", { name: /View pull request #7/ });
    expect(prLink).toHaveAttribute("href", "https://github.com/o/r/pull/7");
    expect(screen.getByText("Pull request ready")).toBeInTheDocument();
    expect(screen.getByText(/claude-code · base main · \$0\.0231 · 4 turns · 1m 1s/)).toBeInTheDocument();
    // Terminal run: no Stop button, no typing dots.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByTestId("thinking-dots")).toBeNull();
  });

  it("shows the branch card when changes landed without a PR", async () => {
    seedRunRoute(runFixture());
    renderDetail();
    await waitFor(() => expect(screen.getByText("Changes pushed")).toBeInTheDocument());
    expect(screen.getByText("outerlayer/worker/version")).toBeInTheDocument();
  });

  it("shows the no-changes note", async () => {
    seedRunRoute(runFixture({ outcome: "no_changes", branch_name: null }));
    renderDetail();
    await waitFor(() =>
      expect(screen.getByText("The agent finished without making changes.")).toBeInTheDocument(),
    );
  });

  it("shows the failure with its code", async () => {
    seedRunRoute(runFixture({ status: "failed", outcome: null, failure_code: "clone_failed", error_message: "auth denied" }));
    renderDetail();
    await waitFor(() => expect(screen.getByText("clone_failed: auth denied")).toBeInTheDocument());
  });

  it("offers Stop while live and calls the cancel action", async () => {
    cancelWorker.mockResolvedValue({ cancelled: true, status: "cancelled" });
    seedRunRoute(runFixture({ status: "running", outcome: null, branch_name: null }));
    renderDetail();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());
    expect(screen.getByTestId("thinking-dots")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancelWorker).toHaveBeenCalledWith({ appId: "app-1", runId: "run-1" }));
  });

  it("navigates back", async () => {
    const onBack = vi.fn();
    seedRunRoute(runFixture());
    renderDetail(onBack);
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
