// @vitest-environment jsdom
/**
 * The Workers landing: a chat-style hero composer that launches one-shot runs
 * (with agent/env/time-limit options) or creates persistent sessions, an
 * entitlement 402 → upgrade prompt, and the sessions + runs history below.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { SWRConfig } from "swr";

import { server } from "@/test-helpers/msw-server";
import { WorkersSection } from "../workers";
import {
  BASE,
  environmentFixture,
  installFetchBaseShim,
  removeFetchBaseShim,
  runFixture,
} from "./workers-ui.helpers";

// The global setup pins `@/hooks/use-boolean` to always-value:false/no-op
// setters. The options panel (base branch, time limit) is driven by that hook,
// so restore the real (useState-backed) implementation or it can never open.
vi.mock("@/hooks/use-boolean", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-boolean")>("@/hooks/use-boolean");
  return actual;
});

const { enqueueSnackbar } = vi.hoisted(() => ({ enqueueSnackbar: vi.fn() }));
vi.mock("@/components/snackbar", () => ({ useSnackbar: () => ({ enqueueSnackbar }) }));
const { mockReplace, navState } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  navState: { params: "" },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/orgs/o/apps/a/env/dev/workers",
  useSearchParams: () => new URLSearchParams(navState.params),
  useParams: () => ({}),
}));
vi.mock("@/context/env-context", () => ({
  useOptionalEnvContext: () => ({ selectedEnv: { id: "env-ctx-1" } }),
}));
const { launchWorker, createEnvironment, cancelWorker, runEnvironmentTurn } = vi.hoisted(() => ({
  launchWorker: vi.fn(),
  createEnvironment: vi.fn(),
  cancelWorker: vi.fn(),
  runEnvironmentTurn: vi.fn(),
}));
vi.mock("../../action-adapters", () => ({ launchWorker, createEnvironment, cancelWorker, runEnvironmentTurn }));

beforeAll(installFetchBaseShim);
afterAll(removeFetchBaseShim);
afterEach(() => {
  enqueueSnackbar.mockClear();
  mockReplace.mockClear();
  launchWorker.mockReset();
  createEnvironment.mockReset();
  navState.params = "";
});

function seedLists({
  runs = [] as Array<Record<string, unknown>>,
  environments = [] as Array<Record<string, unknown>>,
} = {}) {
  server.use(
    http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs`, () => HttpResponse.json({ runs })),
    http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments`, () =>
      HttpResponse.json({ environments }),
    ),
  );
}

function renderSection() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WorkersSection orgName="org-1" appId="app-1" />
    </SWRConfig>,
  );
}

const COMPOSER_PLACEHOLDER =
  "Describe a task, e.g. Add a /version endpoint that returns the package version";

/**
 * MUI's `TextField aria-label` lands on the outer FormControl wrapper, not on
 * the inner `role="combobox"` node itself, so `getByRole('combobox', { name })`
 * can't find it by accessible name. Scope the query to the labelled wrapper.
 */
function getSelectTrigger(label: string): HTMLElement {
  const wrapper = document.querySelector(`[aria-label="${label}"]`);
  if (!wrapper) throw new Error(`No element with aria-label "${label}"`);
  const trigger = wrapper.querySelector('[role="combobox"]');
  if (!trigger) throw new Error(`No combobox inside the "${label}" wrapper`);
  return trigger as HTMLElement;
}

describe("WorkersSection — one-shot launch", () => {
  it("calls the launch action with agent, env context, and default time cap, then opens the run thread", async () => {
    seedLists();
    launchWorker.mockResolvedValue({ runId: "run-1", status: "provisioning", dispatch: "local" });
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/run-1`, () =>
        HttpResponse.json({ run: runFixture({ status: "running", outcome: null }), events: [] }),
      ),
    );
    renderSection();

    await userEvent.type(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), "Fix the login bug");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(launchWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: "app-1",
          agent: "claude-code",
          model: "sonnet",
          taskPrompt: "Fix the login bug",
          environmentId: "env-ctx-1",
          wallClockCapS: 1800,
        }),
      ),
    );
    // Navigated to the run's deep link — the same URL the /v1 API hands out.
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith("/orgs/o/apps/a/env/dev/workers?run=run-1", {
        scroll: false,
      }),
    );
  });

  it("renders the run thread from a ?run= deep link", async () => {
    navState.params = "run=run-1";
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/run-1`, () =>
        HttpResponse.json({ run: runFixture({ status: "running", outcome: null }), events: [] }),
      ),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText("Add a /version endpoint")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("passes a picked image with the launch: chip before send, base64 in the action input", async () => {
    seedLists();
    launchWorker.mockResolvedValue({ runId: "run-1", status: "provisioning", dispatch: "local" });
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/run-1`, () =>
        HttpResponse.json({ run: runFixture({ status: "running", outcome: null }), events: [] }),
      ),
    );
    renderSection();

    await userEvent.type(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), "Match the mock");
    const image = new File(["fake-png-bytes"], "mock.png", { type: "image/png" });
    await userEvent.upload(screen.getByTestId("worker-attachment-input"), image);

    // The selection is visible before sending.
    await waitFor(() => expect(screen.getByText("mock.png · 14 B")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(launchWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          taskPrompt: "Match the mock",
          attachments: [
            {
              name: "mock.png",
              mime: "image/png",
              content: Buffer.from("fake-png-bytes").toString("base64"),
            },
          ],
        }),
      ),
    );
  });

  it("shows the upgrade prompt on an entitlement denial", async () => {
    seedLists();
    launchWorker.mockResolvedValue({
      entitlement: {
        featureKey: "workers_enabled",
        featureDisplayName: "Cloud Workers",
        requiredTierDisplayName: "Team",
        isSelfServe: true,
        upgradeUrl: "/billing",
      },
    });
    renderSection();

    await userEvent.type(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), "task");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByText(/Upgrade your plan to unlock Cloud Workers/)).toBeInTheDocument(),
    );
    // Still on the landing view — the draft is preserved for after the upgrade.
    expect(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER)).toHaveValue("task");
  });

  it("snackbars the server error message when the launch fails", async () => {
    seedLists();
    launchWorker.mockResolvedValue({ error: "app has no git connection" });
    renderSection();
    await userEvent.type(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), "task");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith("app has no git connection", { variant: "error" }),
    );
  });

  it("switching agent resets the model to the new agent's default and drops the model picker when it has none", async () => {
    seedLists();
    launchWorker.mockResolvedValue({ runId: "run-1", status: "provisioning", dispatch: "local" });
    renderSection();

    await userEvent.click(getSelectTrigger("Agent"));
    await userEvent.click(await screen.findByRole("option", { name: "Codex CLI (experimental)" }));

    // Codex has no dashboard-side model picker, so its select disappears.
    expect(document.querySelector('[aria-label="Model"]')).toBeNull();

    await userEvent.type(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), "Fix the login bug");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex", model: undefined })),
    );
  });

  it("picking a non-default model sends that model, not the agent default", async () => {
    seedLists();
    launchWorker.mockResolvedValue({ runId: "run-1", status: "provisioning", dispatch: "local" });
    renderSection();

    await userEvent.click(getSelectTrigger("Model"));
    await userEvent.click(await screen.findByRole("option", { name: "Opus" }));

    await userEvent.type(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), "Fix the login bug");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(launchWorker).toHaveBeenCalledWith(
        expect.objectContaining({ agent: "claude-code", model: "opus" }),
      ),
    );
  });

  it("sends the typed base branch and the selected time limit from the options panel", async () => {
    seedLists();
    launchWorker.mockResolvedValue({ runId: "run-1", status: "provisioning", dispatch: "local" });
    renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Options" }));
    await userEvent.type(screen.getByLabelText("Base branch"), "feature/login-fix");
    await userEvent.click(screen.getByRole("combobox", { name: "Time limit" }));
    await userEvent.click(await screen.findByRole("option", { name: "15 minutes" }));

    await userEvent.type(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), "Fix the login bug");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(launchWorker).toHaveBeenCalledWith(
        expect.objectContaining({ baseBranch: "feature/login-fix", wallClockCapS: 900 }),
      ),
    );
  });

  it("warns via the snackbar when a selection exceeds the attachment cap, without adding the excess to the queue", async () => {
    seedLists();
    renderSection();

    // The picker's `accept` attribute already filters unsupported mime types
    // at the OS dialog, so the reachable rejection path here is the count cap
    // (MAX_WORKER_ATTACHMENTS = 4): a 5-file selection rejects the 5th.
    const files = Array.from(
      { length: 5 },
      (_, i) => new File([`img-${i}`], `img-${i}.png`, { type: "image/png" }),
    );
    await userEvent.upload(screen.getByTestId("worker-attachment-input"), files);

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith("You can attach at most 4 files.", { variant: "warning" }),
    );
    await waitFor(() => expect(screen.getAllByText(/^img-\d\.png ·/)).toHaveLength(4));
    expect(screen.queryByText("img-4.png · 5 B")).toBeNull();
  });
});

describe("WorkersSection — persistent session", () => {
  it("creates an environment instead of a run when the toggle is on, then opens the thread", async () => {
    seedLists();
    createEnvironment.mockResolvedValue({ environmentId: "env-1", runId: "t0", status: "active" });
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments/env-1`, () =>
        HttpResponse.json({
          environment: environmentFixture(),
          turns: [runFixture({ id: "t0", status: "running", outcome: null, task_prompt: "Start the session" })],
        }),
      ),
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/t0`, () =>
        HttpResponse.json({
          run: runFixture({ id: "t0", status: "running", outcome: null, task_prompt: "Start the session" }),
          events: [],
        }),
      ),
    );
    renderSection();

    await userEvent.click(screen.getByRole("switch"));
    await userEvent.type(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER), "Start the session");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(createEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ appId: "app-1", agent: "claude-code", model: "sonnet", taskPrompt: "Start the session" }),
      ),
    );
    // Navigated to the session's deep link.
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith("/orgs/o/apps/a/env/dev/workers?session=env-1", {
        scroll: false,
      }),
    );
  });

  it("renders the session thread from a ?session= deep link", async () => {
    navState.params = "session=env-1";
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments/env-1`, () =>
        HttpResponse.json({
          environment: environmentFixture(),
          turns: [runFixture({ id: "t0", status: "running", outcome: null, task_prompt: "Start the session" })],
        }),
      ),
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/t0`, () =>
        HttpResponse.json({
          run: runFixture({ id: "t0", status: "running", outcome: null, task_prompt: "Start the session" }),
          events: [],
        }),
      ),
    );
    renderSection();
    await waitFor(() =>
      expect(screen.getByPlaceholderText("The agent is working…")).toBeInTheDocument(),
    );
    expect(screen.getByText("Start the session")).toBeInTheDocument();
  });
});

describe("WorkersSection — history", () => {
  /** A list endpoint that never settles, so the loading branch stays observable. */
  function seedNeverResolving() {
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs`, () => new Promise(() => {})),
      http.get(
        `${BASE}/api/orgs/org-1/apps/app-1/workers/environments`,
        () => new Promise(() => {}),
      ),
    );
  }

  function seedListFailures({ runs = 500, environments = 500 }: { runs?: number; environments?: number } = {}) {
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs`, () =>
        HttpResponse.json({ error: "boom" }, { status: runs }),
      ),
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments`, () =>
        HttpResponse.json({ error: "boom" }, { status: environments }),
      ),
    );
  }

  it("lists sessions and runs below the composer", async () => {
    seedLists({
      runs: [runFixture({ task_prompt: "old run" })],
      environments: [environmentFixture()],
    });
    renderSection();

    await waitFor(() => expect(screen.getByText("old run")).toBeInTheDocument());
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("outerlayer/worker/env-abc12345")).toBeInTheDocument();
    expect(screen.getByText("claude-code · local")).toBeInTheDocument();
  });

  it("stands a table-shaped placeholder in while the lists load, never a spinner", async () => {
    seedNeverResolving();
    renderSection();

    const skeleton = await screen.findByTestId("workers-history-skeleton");
    // Shaped like the runs table it precedes, so first paint does not reflow
    // once the rows land.
    expect(skeleton).toHaveAttribute("data-variant", "table-page");
    expect(screen.getByTestId("workers-history-skeleton-head-row")).toBeInTheDocument();
    expect(screen.getAllByTestId("workers-history-skeleton-row").length).toBeGreaterThan(1);
    // Announced while it stands in rather than a silent blank.
    expect(skeleton).toHaveTextContent("Loading");
    expect(screen.queryByRole("progressbar")).toBeNull();
    // The composer's heading is real and already above it; a second placeholder
    // header would promise a title that never arrives. Neither list has a filter
    // bar or a pager, so neither is reserved.
    expect(screen.queryByTestId("workers-history-skeleton-header")).toBeNull();
    expect(screen.queryByTestId("workers-history-skeleton-filter-bar")).toBeNull();
    expect(screen.queryByTestId("workers-history-skeleton-pager")).toBeNull();
    // The composer stays usable — the placeholder replaces the history only.
    expect(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER)).toBeInTheDocument();
  });

  it("reports a total load failure as a failure, not as an account with no work in it", async () => {
    seedListFailures();
    renderSection();

    const card = await screen.findByTestId("workers-history-error");
    expect(card).toHaveAttribute("role", "alert");
    expect(screen.getByRole("heading", { name: "Couldn't load your workers" })).toBeInTheDocument();
    // The empty state must not stand in for a failure — that would tell the
    // user their runs are gone.
    expect(screen.queryByTestId("workers-history-empty")).toBeNull();
    expect(screen.queryByTestId("workers-runs-empty")).toBeNull();
    expect(screen.queryByTestId("workers-sessions-empty")).toBeNull();
    // The reason reads as a sentence rather than a bare status code.
    expect(card).toHaveTextContent("The server responded with 500.");
  });

  it("retrying a failed load refetches and renders the rows", async () => {
    let attempt = 0;
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs`, () => {
        attempt += 1;
        return attempt === 1
          ? HttpResponse.json({ error: "boom" }, { status: 500 })
          : HttpResponse.json({ runs: [runFixture({ task_prompt: "recovered run" })] });
      }),
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments`, () => {
        return attempt === 1
          ? HttpResponse.json({ error: "boom" }, { status: 500 })
          : HttpResponse.json({ environments: [] });
      }),
    );
    renderSection();

    await screen.findByTestId("workers-history-error");
    await userEvent.click(screen.getByTestId("workers-history-error-retry"));

    // Retry reaches the fetcher rather than being decorative.
    await waitFor(() => expect(screen.getByText("recovered run")).toBeInTheDocument());
    expect(screen.queryByTestId("workers-history-error")).toBeNull();
  });

  it("one list failing leaves the other's rows on screen", async () => {
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments`, () =>
        HttpResponse.json({ environments: [environmentFixture()] }),
      ),
    );
    renderSection();

    // The runs failure is scoped to its own section; the sessions it knows
    // nothing about still render.
    expect(await screen.findByTestId("workers-runs-error")).toBeInTheDocument();
    expect(screen.getByText("outerlayer/worker/env-abc12345")).toBeInTheDocument();
    expect(screen.queryByTestId("workers-sessions-error")).toBeNull();
    expect(screen.queryByTestId("workers-history-error")).toBeNull();
  });

  it("a failed list whose sibling is legitimately empty still reports the failure", async () => {
    // The narrow gap between the two states: nothing loaded, so the page looks
    // like a cold start, but one list did not come back empty — it failed. The
    // empty card here would tell a user with runs that they have none.
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments`, () =>
        HttpResponse.json({ environments: [] }),
      ),
    );
    renderSection();

    expect(await screen.findByTestId("workers-runs-error")).toBeInTheDocument();
    expect(screen.queryByTestId("workers-history-empty")).toBeNull();
    expect(screen.queryByTestId("workers-runs-empty")).toBeNull();
    // The sessions list genuinely is empty, and says so.
    expect(screen.getByTestId("workers-sessions-empty")).toBeInTheDocument();
  });

  it("says the surface is empty instead of omitting it, with one card rather than two", async () => {
    seedLists();
    renderSection();

    const empty = await screen.findByTestId("workers-history-empty");
    expect(screen.getByRole("heading", { name: "No runs or sessions yet" })).toBeInTheDocument();
    // A create-your-first-X prompt: the dashed outline reads as a slot waiting
    // to be filled, and the composer above is the way out of it.
    expect(empty).toHaveAttribute("data-variant", "dashed");
    // Cold start says it once — not one card per silent section.
    expect(screen.queryByTestId("workers-runs-empty")).toBeNull();
    expect(screen.queryByTestId("workers-sessions-empty")).toBeNull();
    expect(screen.queryByTestId("workers-history-error")).toBeNull();
  });

  it("keeps an empty section visible and labelled when only the other one has rows", async () => {
    seedLists({ runs: [runFixture({ task_prompt: "only run" })] });
    renderSection();

    await waitFor(() => expect(screen.getByText("only run")).toBeInTheDocument());
    // A silently omitted section is not an empty state: Sessions says so.
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByTestId("workers-sessions-empty")).toHaveTextContent("No persistent sessions");
    expect(screen.queryByTestId("workers-history-empty")).toBeNull();
    expect(screen.queryByTestId("workers-runs-empty")).toBeNull();
  });
});
