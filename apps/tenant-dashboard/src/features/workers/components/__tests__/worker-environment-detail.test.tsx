// @vitest-environment jsdom
/**
 * The persistent environment as a chat thread: every turn renders as a
 * user-message + agent-activity exchange in order, the composer continues the
 * session (POST /turns), 409 warns instead of erroring, and a destroyed
 * environment ends the conversation.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { SWRConfig } from "swr";

import { server } from "@/test-helpers/msw-server";
import { WorkerEnvironmentDetail } from "../worker-environment-detail";
import {
  BASE,
  environmentFixture,
  installFetchBaseShim,
  removeFetchBaseShim,
  runFixture,
} from "./workers-ui.helpers";

const { enqueueSnackbar } = vi.hoisted(() => ({ enqueueSnackbar: vi.fn() }));
vi.mock("@/components/snackbar", () => ({ useSnackbar: () => ({ enqueueSnackbar }) }));
const { runEnvironmentTurn } = vi.hoisted(() => ({ runEnvironmentTurn: vi.fn() }));
vi.mock("../../action-adapters", () => ({ runEnvironmentTurn }));

beforeAll(installFetchBaseShim);
afterAll(removeFetchBaseShim);
afterEach(() => {
  enqueueSnackbar.mockClear();
  runEnvironmentTurn.mockReset();
});

const TURNS = [
  runFixture({ id: "t0", task_prompt: "Create colors.ts with 3 colors" }),
  runFixture({ id: "t1", task_prompt: "Add a 4th color to that array" }),
];

function seedThread({
  environment = environmentFixture(),
  turns = TURNS,
}: { environment?: Record<string, unknown>; turns?: Array<Record<string, unknown>> } = {}) {
  server.use(
    http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments/env-1`, () =>
      HttpResponse.json({ environment, turns }),
    ),
    http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/runs/:runId`, ({ params }) =>
      HttpResponse.json({
        run: turns.find((t) => t.id === params.runId) ?? turns[0],
        events: [
          {
            seq: 0,
            event_type: "agent-message",
            payload: { text: `worked on ${String(params.runId)}` },
            created_at: "t",
          },
        ],
      }),
    ),
  );
}

function renderThread(onBack = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WorkerEnvironmentDetail orgName="org-1" appId="app-1" envId="env-1" onBack={onBack} />
    </SWRConfig>,
  );
}

describe("WorkerEnvironmentDetail", () => {
  it("renders the whole thread in turn order with the session header", async () => {
    seedThread();
    renderThread();

    await waitFor(() => expect(screen.getByText("Create colors.ts with 3 colors")).toBeInTheDocument());
    expect(screen.getByText("Add a 4th color to that array")).toBeInTheDocument();
    expect(screen.getByText("worked on t0")).toBeInTheDocument();
    expect(screen.getByText("worked on t1")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("outerlayer/worker/env-abc12345")).toBeInTheDocument();

    // Prompts appear before their agent output, and turn 0 before turn 1.
    const order = [
      "Create colors.ts with 3 colors",
      "worked on t0",
      "Add a 4th color to that array",
      "worked on t1",
    ].map((text) => screen.getByText(text));
    for (let i = 1; i < order.length; i++) {
      const follows = Boolean(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(follows).toBe(true);
    }
  });

  it("continues the session: sends the follow-up and clears the composer", async () => {
    seedThread();
    runEnvironmentTurn.mockResolvedValue({ runId: "t2", turnIndex: 2 });
    renderThread();
    const input = await screen.findByPlaceholderText("Reply to keep working in this session");
    await userEvent.type(input, "now add tests{Enter}");
    await waitFor(() =>
      expect(runEnvironmentTurn).toHaveBeenCalledWith(
        expect.objectContaining({ appId: "app-1", envId: "env-1", taskPrompt: "now add tests" }),
      ),
    );
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("warns when the turn is already running and keeps the draft", async () => {
    seedThread();
    runEnvironmentTurn.mockResolvedValue({ busy: true, error: "busy" });
    renderThread();
    const input = await screen.findByPlaceholderText("Reply to keep working in this session");
    await userEvent.type(input, "another task{Enter}");
    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith("This session is already running a turn.", {
        variant: "warning",
      }),
    );
    expect((input as HTMLTextAreaElement).value).toBe("another task");
  });

  it("disables the composer while a turn is running", async () => {
    seedThread({
      environment: environmentFixture({ current_run_id: "t1" }),
      turns: [TURNS[0]!, runFixture({ id: "t1", task_prompt: "Add a 4th color", status: "running", outcome: null })],
    });
    renderThread();
    await screen.findByPlaceholderText("The agent is working…");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByTestId("thinking-dots")).toBeInTheDocument();
  });

  it("ends the conversation for a destroyed environment", async () => {
    seedThread({ environment: environmentFixture({ status: "destroyed" }) });
    renderThread();
    // A terminal session is an empty state, not a failure: nothing went wrong,
    // there is nothing more this thread can do.
    const ended = await screen.findByTestId("worker-session-ended");
    expect(screen.getByRole("heading", { name: "This session has ended" })).toBeInTheDocument();
    expect(ended).toHaveTextContent(/start a new session/i);
    // The two cards look alike, so the distinction has to be asserted: an ended
    // session is not a fault, so it claims no alert role and offers no retry —
    // there is nothing to retry toward.
    expect(ended).not.toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("worker-session-ended-retry")).toBeNull();
    expect(screen.queryByTestId("worker-session-error")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("reports a failed session load and withholds the composer", async () => {
    server.use(
      http.get(`${BASE}/api/orgs/org-1/apps/app-1/workers/environments/env-1`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderThread();

    const card = await screen.findByTestId("worker-session-error");
    expect(card).toHaveAttribute("role", "alert");
    expect(card).toHaveTextContent("The server responded with 500.");
    // Replying would post a turn against a session whose state never loaded.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    // A failure is not an ended session and not an empty thread.
    expect(screen.queryByTestId("worker-session-ended")).toBeNull();
  });

  it("shows a failed turn's error inline", async () => {
    seedThread({
      turns: [runFixture({ id: "t0", status: "failed", outcome: null, failure_code: "agent_error", error_message: "boom" })],
    });
    renderThread();
    await waitFor(() => expect(screen.getByText("agent_error: boom")).toBeInTheDocument());
  });
});
